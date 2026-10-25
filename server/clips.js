/**
 * Gaming clip tools on the server:
 *  - "Clip a moment": cut a range of a video into a new video that links back to its source. Copies
 *    without re-encoding when the start falls on a keyframe (or when the person picks the fast mode,
 *    which moves the start back to the previous keyframe), otherwise re-encodes for an exact cut.
 *  - GIF and short MP4 exports of a range, as downloads that expire after a day.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings } from './db.js';
import { DIRS } from './config.js';
import { requireAuth } from './auth.js';
import { HttpError, clampInt, newId, now, str } from './util.js';
import { defineJob, enqueueJob, PermanentError } from './jobs.js';
import { encodeWithFallback, ffmpegBin, ffprobeBin, processVideo, progressReader, run, throttledWriter } from './media.js';
import { canEdit, canPlay, fullVideo, loadVideo, storageFor } from './routes/videos.js';
import { indexVideo } from './search.js';

export const CLIP_MAX_SECONDS = 600;
export const GIF_MAX_SECONDS = 15;
export const MP4_EXPORT_MAX_SECONDS = 60;
const EXPORT_TTL = 24 * 3600_000;
const VISIBILITIES = ['public', 'unlisted', 'private'];

/** Keyframe times from `t - 10s` up to just after `t`, without decoding (packet flags). */
async function keyframesBefore(file, t) {
  const from = Math.max(0, t - 10);
  const { stdout } = await run(ffprobeBin, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0',
    '-read_intervals', `${from.toFixed(3)}%${(t + 0.1).toFixed(3)}`, file,
  ]);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.split(','))
    .filter(([, flags]) => flags && flags.includes('K'))
    .map(([pts]) => Number(pts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

/** Who may clip a video: its uploader and admins always, others when the uploader allows it. */
export function canClip(v, user) {
  if (!user || !v || v.status !== 'ready' || !canPlay(v, user)) return false;
  if (canEdit(v, user)) return true;
  return !!v.allow_clips && v.visibility === 'public' && !v.moderation_status;
}

function parseRange(b, total, { min, max }) {
  const start = Math.max(0, Number(b.start) || 0);
  const end = Math.min(total, Number(b.end) || 0);
  if (!(end - start >= min)) throw new HttpError(400, `Pick at least ${min} second${min === 1 ? '' : 's'}`);
  if (end - start > max + 0.01) throw new HttpError(400, `That's longer than ${max >= 60 ? `${max / 60} minutes` : `${max} seconds`}, the limit here`);
  return { start, end };
}

// ---- clip a moment ------------------------------------------------------------------------

async function cutClip({ id, source, from, start, end, mode }) {
  const clip = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!clip || clip.status === 'ready') return;
  const src = db.prepare('SELECT * FROM videos WHERE id = ?').get(source);
  const file = src && (from === 'base' ? src.base_path : src.file_path);
  const input = file && path.join(DIRS.videos, file);
  if (!input || !fs.existsSync(input)) throw new PermanentError('The video this clip comes from is gone');

  db.prepare("UPDATE videos SET status = 'processing', progress = 0, error = NULL WHERE id = ?").run(id);
  let s = start;
  let copy = false;
  try {
    const keys = await keyframesBefore(input, start);
    const exact = keys.find((k) => Math.abs(k - start) <= 0.05);
    if (exact !== undefined) {
      s = exact;
      copy = true;
    } else if (mode === 'fast' && keys.length) {
      s = keys.filter((k) => k <= start).pop() ?? start;
      copy = s !== start;
    }
  } catch (e) {
    console.warn(`[clips] keyframe lookup failed for ${id}, re-encoding: ${e.message}`);
  }
  const dur = end - s;
  const tmp = path.join(DIRS.tmp, `${id}.clip.mp4`);
  const write = throttledWriter((p) => db.prepare('UPDATE videos SET progress = ? WHERE id = ?').run(Math.round(p * 0.8), id));
  const base = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', s.toFixed(3), '-i', input, '-t', dur.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  const tail = ['-movflags', '+faststart', '-f', 'mp4', tmp];
  if (copy) {
    await run(ffmpegBin, [...base, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...tail], { onStdoutLine: progressReader(dur, write) });
  } else {
    await encodeWithFallback(getSettings(), (enc) => [...base, ...enc, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', ...tail], progressReader(dur, write));
  }
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id)) {
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  const name = `${id}.mp4`;
  fs.renameSync(tmp, path.join(DIRS.originals, name));
  const size = fs.statSync(path.join(DIRS.originals, name)).size;
  db.prepare("UPDATE videos SET original_path = ?, size_bytes = ?, source_start = ?, status = 'queued' WHERE id = ?").run(name, size, s, id);
  console.log(`[clips] ${id}: cut ${s.toFixed(2)}-${end.toFixed(2)}s from ${source} (${copy ? 'copied' : 're-encoded'})`);
  await processVideo(id);
}

defineJob('video.clip', {
  lane: 'media',
  maxAttempts: 1,
  handler: (p) => cutClip(p),
  onFail: ({ id }, e) => {
    console.error(`[clips] clip ${id} failed: ${e.message}`);
    db.prepare("UPDATE videos SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 1000), id);
  },
});

// ---- GIF / MP4 exports ------------------------------------------------------------------------

function serializeExport(x) {
  return {
    id: x.id,
    video_id: x.video_id,
    format: x.format,
    start: x.start_s,
    end: x.end_s,
    width: x.width,
    muted: !!x.muted,
    status: x.status,
    progress: x.progress,
    error: x.error,
    size_bytes: x.size_bytes,
    created_at: x.created_at,
    expires_at: x.status === 'ready' ? x.created_at + EXPORT_TTL : null,
    download_url: x.status === 'ready' ? `/api/exports/${x.id}/file` : null,
  };
}

async function runExport({ id }) {
  const x = db.prepare('SELECT * FROM media_exports WHERE id = ?').get(id);
  if (!x || x.status === 'ready') return;
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(x.video_id);
  const input = v?.file_path && path.join(DIRS.videos, v.file_path);
  if (!input || !fs.existsSync(input)) throw new PermanentError('The video is gone');
  db.prepare("UPDATE media_exports SET status = 'working', progress = 0, error = NULL WHERE id = ?").run(id);
  const dur = x.end_s - x.start_s;
  const name = `media-${id}.${x.format}`;
  const tmp = path.join(DIRS.tmp, name);
  const onLine = progressReader(dur, throttledWriter((p) => db.prepare('UPDATE media_exports SET progress = ? WHERE id = ?').run(p, id)));
  const base = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', x.start_s.toFixed(3), '-t', dur.toFixed(3), '-i', input];
  if (x.format === 'gif') {
    // Two-pass palette in one graph: a palette built from this range, then dithered with it.
    const graph = `[0:v]fps=15,scale=${x.width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    await run(ffmpegBin, [...base, '-filter_complex', graph, '-loop', '0', '-f', 'gif', tmp], { onStdoutLine: onLine });
  } else {
    const audio = x.muted ? ['-an'] : ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
    await encodeWithFallback(
      getSettings(),
      (enc) => [...base, '-map', '0:v:0', ...audio, '-vf', "scale=-2:'min(720,ih)'", ...enc, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', tmp],
      onLine,
    );
  }
  if (!db.prepare('SELECT 1 FROM media_exports WHERE id = ?').get(id)) {
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  fs.renameSync(tmp, path.join(DIRS.exports, name));
  const size = fs.statSync(path.join(DIRS.exports, name)).size;
  db.prepare("UPDATE media_exports SET status = 'ready', progress = 100, file = ?, size_bytes = ?, created_at = ? WHERE id = ?").run(name, size, now(), id);
  enqueueJob('media.export.cleanup', { id }, { delay: EXPORT_TTL });
}

defineJob('media.export', {
  lane: 'media',
  maxAttempts: 2,
  handler: (p) => runExport(p),
  onFail: ({ id }, e) => {
    db.prepare("UPDATE media_exports SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 500), id);
  },
});

defineJob('media.export.cleanup', {
  handler: ({ id }) => {
    const x = db.prepare('SELECT file FROM media_exports WHERE id = ?').get(id);
    if (x?.file) try { fs.unlinkSync(path.join(DIRS.exports, path.basename(x.file))); } catch {}
    db.prepare('DELETE FROM media_exports WHERE id = ?').run(id);
  },
});

// ---- routes (mounted at /api) -----------------------------------------------------------------

export const clipsRouter = Router();

clipsRouter.post('/videos/:id/clip', requireAuth, (req, res) => {
  const v = loadVideo(req.params.id);
  if (!v || !canPlay(v, req.user)) throw new HttpError(404, 'Video not found');
  if (!canClip(v, req.user)) throw new HttpError(403, v.status !== 'ready' ? 'The video is still processing' : "The uploader hasn't allowed clips of this video");
  const b = req.body || {};
  const fromBase = b.from === 'source';
  if (fromBase && !canEdit(v, req.user)) throw new HttpError(403, 'Only the uploader can clip from the unedited recording');
  const total = fromBase ? v.base_duration || v.duration : v.duration;
  const { start, end } = parseRange(b, total, { min: 1, max: CLIP_MAX_SECONDS });

  const estimate = Math.round((v.size_bytes || 0) * ((end - start) / Math.max(1, v.duration || 1)));
  const { used, quota } = storageFor(req.user.id);
  if (quota > 0 && used + estimate > quota) throw new HttpError(413, 'This clip would go over your storage quota. Delete some videos or ask an admin for more space.');

  const id = newId();
  const t = now();
  const title = str(b.title, 120).trim() || `${v.title} (clip)`.slice(0, 120);
  const visibility = VISIBILITIES.includes(b.visibility) ? b.visibility : v.visibility === 'private' ? 'private' : 'public';
  db.prepare(
    `INSERT INTO videos (id, user_id, title, description, visibility, status, original_name, size_bytes, created_at, updated_at, source_video_id, source_start, source_end, game_id)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, req.user.id, title, str(b.description), visibility, `${title}.mp4`.slice(0, 255), t, t, v.id, start, end, v.game_id || null);
  const ins = db.prepare('INSERT OR IGNORE INTO tags (video_id, tag) VALUES (?, ?)');
  for (const r of db.prepare('SELECT tag FROM tags WHERE video_id = ?').all(v.id)) ins.run(id, r.tag);
  indexVideo(id);
  enqueueJob('video.clip', { id, source: v.id, from: fromBase ? 'base' : 'published', start, end, mode: b.mode === 'fast' ? 'fast' : 'exact' }, { dedupe: `clip:${id}` });
  res.status(201).json({ video: fullVideo(id, req.user) });
});

clipsRouter.post('/videos/:id/exports', requireAuth, (req, res) => {
  const v = loadVideo(req.params.id);
  if (!v || !canPlay(v, req.user) || v.status !== 'ready' || !v.file_path) throw new HttpError(404, 'Video not found');
  const b = req.body || {};
  const format = b.format === 'mp4' ? 'mp4' : 'gif';
  const { start, end } = parseRange(b, v.duration, { min: 0.5, max: format === 'gif' ? GIF_MAX_SECONDS : MP4_EXPORT_MAX_SECONDS });
  const busy = db.prepare("SELECT COUNT(*) AS n FROM media_exports WHERE user_id = ? AND status IN ('queued', 'working')").get(req.user.id).n;
  if (busy >= 3) throw new HttpError(429, 'Wait for your other exports to finish first');
  const id = newId();
  const width = format === 'gif' ? clampInt(b.width, 160, 640, 480) : null;
  db.prepare('INSERT INTO media_exports (id, video_id, user_id, format, start_s, end_s, width, muted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, v.id, req.user.id, format, start, end, width, b.muted ? 1 : 0, now(),
  );
  enqueueJob('media.export', { id }, { dedupe: `export:${id}` });
  res.status(202).json({ export: serializeExport(db.prepare('SELECT * FROM media_exports WHERE id = ?').get(id)) });
});

function ownExport(req) {
  const x = db.prepare('SELECT * FROM media_exports WHERE id = ?').get(String(req.params.id));
  if (!x || x.user_id !== req.user.id) throw new HttpError(404, 'Export not found');
  return x;
}

clipsRouter.get('/exports/:id', requireAuth, (req, res) => {
  res.json({ export: serializeExport(ownExport(req)) });
});

clipsRouter.get('/exports/:id/file', requireAuth, (req, res) => {
  const x = ownExport(req);
  const file = x.file && path.join(DIRS.exports, path.basename(x.file));
  if (x.status !== 'ready' || !file || !fs.existsSync(file)) throw new HttpError(404, 'This export has expired');
  const v = db.prepare('SELECT title FROM videos WHERE id = ?').get(x.video_id);
  const stamp = (s) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  const safe = (v?.title || 'clip').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip';
  res.download(file, `${safe} ${stamp(x.start_s)}-${stamp(x.end_s)}.${x.format}`);
});
