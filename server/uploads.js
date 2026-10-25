import path from 'node:path';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import multer from 'multer';
import { DIRS, VIDEO_EXTENSIONS, IMAGE_EXTENSIONS } from './config.js';
import { db, getSettings } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, newId, now, str } from './util.js';

const tmpStorage = multer.diskStorage({
  destination: DIRS.tmp,
  filename: (req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
});

function extFilter(allowed, label) {
  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.has(ext)) return cb(new HttpError(400, `${label}: unsupported file type ${ext || '(none)'}`));
    cb(null, true);
  };
}

/** Video upload middleware. The size limit is read from settings on every request. */
export function videoUpload(req, res, next) {
  const maxMb = Number(getSettings().max_upload_mb) || 8192;
  const mw = multer({
    storage: tmpStorage,
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: extFilter(VIDEO_EXTENSIONS, 'Video'),
  }).single('file');
  mw(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `File is larger than the ${maxMb} MB upload limit`));
    next(err);
  });
}

export function imageUpload(field) {
  return multer({
    storage: tmpStorage,
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
    fileFilter: extFilter(IMAGE_EXTENSIONS, 'Image'),
  }).single(field);
}

export function discard(file) {
  if (!file) return;
  try { fs.unlinkSync(file.path); } catch {}
}

// ---- uploads in pieces --------------------------------------------------------------------------------------
// A big file can go up as a series of PUTs of a few tens of MB instead of one request. That gets it past proxies
// that cap the size of a request (Cloudflare's cap is 100 MB), and a dropped connection only costs what was in
// flight: the uploader asks where the upload stands and carries on from there.
//
//   POST   /api/uploads {kind, name, size}   starts one: {upload: {id, offset: 0, chunk_size, ...}}
//   PUT    /api/uploads/:id                  the next bytes, raw, with an Upload-Offset header saying where they go
//   GET    /api/uploads/:id                  where it stands (GET /api/uploads lists your unfinished ones)
//   DELETE /api/uploads/:id                  gives up
//
// Once offset reaches size, its upload_id goes where the file would have: POST /api/videos for a video, POST
// /api/me/channel-imports for a channel archive. An upload with no new piece for a day is deleted.

/** The piece size uploaders are told to use, well under Cloudflare's 100 MB. */
export const CHUNK_BYTES = 32 * 1024 * 1024;
const STALE_MS = Number(process.env.UPLOAD_STALE_MS) || 24 * 3600_000;
const SWEEP_MS = Number(process.env.UPLOAD_SWEEP_MS) || 3600_000;
const MAX_OPEN = 10; // unfinished uploads per person
const kinds = new Map();
const arriving = new Map(); // upload id -> { req, done } for the piece arriving right now

/**
 * Lets a kind of file go up in pieces: { label, extensions, maxBytes(), check?(user, size, pendingBytes) }, where
 * check throws to refuse (pendingBytes: what the person's other unfinished uploads of this kind will add).
 */
export function defineUploadKind(name, spec) {
  kinds.set(name, spec);
}

const partOf = (id) => path.join(DIRS.uploads, `${id}.part`);
function received(id) {
  try {
    return fs.statSync(partOf(id)).size;
  } catch {
    return 0;
  }
}
const view = (u, offset = received(u.id)) => ({
  id: u.id,
  kind: u.kind,
  name: u.name,
  size: u.size,
  offset,
  chunk_size: CHUNK_BYTES,
  fingerprint: u.fingerprint || null,
  created_at: u.created_at,
  updated_at: u.updated_at,
});

function ownUpload(id, user) {
  const u = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(String(id || ''), user.id);
  if (!u) throw new HttpError(404, 'Upload not found (unfinished uploads are deleted after a day)');
  return u;
}

function dropUpload(id) {
  db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  try {
    fs.rmSync(partOf(id), { force: true });
  } catch {} // still open on Windows: the sweep gets it later
}

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

uploadsRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM uploads WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ uploads: rows.map((u) => view(u)) });
});

uploadsRouter.post('/', (req, res) => {
  const b = req.body || {};
  const kindName = String(b.kind || 'video');
  const kind = kinds.get(kindName);
  if (!kind) throw new HttpError(400, `kind must be ${[...kinds.keys()].join(' or ')}`);
  const name = str(b.name, 255).trim();
  const ext = path.extname(name).toLowerCase();
  if (!kind.extensions.has(ext)) throw new HttpError(400, `${kind.label}: unsupported file type ${ext || '(none)'}`);
  const size = Number(b.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'size must be the size of the file in bytes');
  const max = kind.maxBytes();
  if (size > max) throw new HttpError(413, `File is larger than the ${Math.round(max / 1048576)} MB upload limit`);
  const open = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN kind = ? THEN size END), 0) AS pending FROM uploads WHERE user_id = ?')
    .get(kindName, req.user.id);
  if (open.n >= MAX_OPEN) throw new HttpError(429, 'Too many unfinished uploads: finish or cancel some first');
  kind.check?.(req.user, size, open.pending);
  const t = now();
  const u = { id: newId(), user_id: req.user.id, kind: kindName, name, size, fingerprint: str(b.fingerprint, 100) || null, created_at: t, updated_at: t };
  fs.writeFileSync(partOf(u.id), '');
  db.prepare('INSERT INTO uploads (id, user_id, kind, name, size, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    u.id, u.user_id, u.kind, u.name, u.size, u.fingerprint, t, t,
  );
  res.status(201).json({ upload: view(u, 0) });
});

uploadsRouter.get('/:id', (req, res) => {
  res.json({ upload: view(ownUpload(req.params.id, req.user)) });
});

uploadsRouter.put('/:id', async (req, res) => {
  const u = ownUpload(req.params.id, req.user);
  if (req.is('json') || req.is('multipart')) throw new HttpError(415, 'Send each piece as its raw bytes (application/octet-stream)');
  // A new piece means the uploader gave up on the one still arriving here: a connection that died somewhere
  // between them (a proxy can keep its side open for a while). That one stops; what it wrote stays.
  const before = arriving.get(u.id);
  if (before) {
    before.req.destroy();
    await before.done;
  }
  if (arriving.has(u.id)) throw new HttpError(409, 'This upload is already taking a piece');
  const have = received(u.id);
  const offset = Number(req.get('upload-offset'));
  // A piece may start before what arrived already (sent again after a dropped connection, when the uploader
  // couldn't know how much got here): those bytes are skipped. Only a gap is refused.
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > have) {
    return res.status(409).json({ error: `This upload continues at byte ${have}`, upload: view(u, have) });
  }
  const room = u.size - have;
  let skip = have - offset;
  if (Number(req.get('content-length')) - skip > room) throw new HttpError(413, 'That piece goes past the end of the file');
  let finish;
  arriving.set(u.id, { req, done: new Promise((r) => (finish = r)) });
  let got = 0;
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk, enc, cb) {
          if (skip >= chunk.length) {
            skip -= chunk.length;
            return cb();
          }
          const fresh = skip ? chunk.subarray(skip) : chunk;
          skip = 0;
          got += fresh.length;
          cb(got > room ? new HttpError(413, 'That piece goes past the end of the file') : null, fresh);
        },
      }),
      fs.createWriteStream(partOf(u.id), { flags: 'a' }),
    );
  } catch (e) {
    if (e instanceof HttpError || !['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(e.code)) throw e;
    // The connection dropped: what arrived is kept, and the uploader asks where to carry on.
    return;
  } finally {
    arriving.delete(u.id);
    finish();
    db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(now(), u.id);
  }
  res.json({ upload: view(u) });
});

uploadsRouter.delete('/:id', (req, res) => {
  dropUpload(ownUpload(req.params.id, req.user).id);
  res.status(204).end();
});

/**
 * A finished upload of this kind, to use like a file that came with the request: { path, originalname, size }.
 * The caller moves the file away and then calls done(); until then the upload stays, so a refused request
 * (a bad game name, say) can be sent again without sending the file again.
 */
export function finishedUpload(id, user, kind) {
  const u = ownUpload(id, user);
  if (u.kind !== kind) throw new HttpError(400, `That upload is not a ${kinds.get(kind)?.label.toLowerCase() || kind}`);
  if (arriving.has(u.id)) throw new HttpError(409, 'That upload is still taking a piece');
  const have = received(u.id);
  if (have !== u.size) throw new HttpError(409, `That upload isn't finished: ${have} of ${u.size} bytes arrived`);
  return { path: partOf(u.id), originalname: u.name, size: u.size, done: () => db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id) };
}

/** Deletes uploads that had no new piece for a day, and files no upload owns. */
export function sweepUploads() {
  const cutoff = now() - STALE_MS;
  for (const u of db.prepare('SELECT id FROM uploads WHERE updated_at < ?').all(cutoff)) if (!arriving.has(u.id)) dropUpload(u.id);
  const known = new Set(db.prepare('SELECT id FROM uploads').all().map((u) => `${u.id}.part`));
  for (const f of fs.readdirSync(DIRS.uploads)) {
    if (known.has(f)) continue;
    try {
      if (fs.statSync(path.join(DIRS.uploads, f)).mtimeMs < cutoff) fs.rmSync(path.join(DIRS.uploads, f), { force: true });
    } catch {}
  }
}

export function startUploadSweep() {
  sweepUploads();
  setInterval(sweepUploads, SWEEP_MS).unref();
}
