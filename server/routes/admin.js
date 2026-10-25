import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, setSetting } from '../db.js';
import { DIRS } from '../config.js';
import { requireAdmin, userToPublic } from '../auth.js';
import { HttpError } from '../util.js';
import { queueInfo, ffmpegInfo } from '../media.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const ENCODERS = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'];

adminRouter.get('/settings', (req, res) => res.json({ settings: getSettings(), encoders: ENCODERS }));

adminRouter.patch('/settings', (req, res) => {
  const b = req.body || {};
  const bool = (v) => (v === true || v === 'true' ? 'true' : 'false');
  if (b.site_name !== undefined) {
    const name = String(b.site_name).trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Site name cannot be empty');
    setSetting('site_name', name);
  }
  if (b.allow_registration !== undefined) setSetting('allow_registration', bool(b.allow_registration));
  if (b.delete_originals !== undefined) setSetting('delete_originals', bool(b.delete_originals));
  if (b.max_upload_mb !== undefined) {
    const n = parseInt(b.max_upload_mb, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) throw new HttpError(400, 'Upload limit must be between 1 and 1000000 MB');
    setSetting('max_upload_mb', n);
  }
  if (b.max_height !== undefined) {
    const n = parseInt(b.max_height, 10);
    if (![480, 720, 1080, 1440, 2160].includes(n)) throw new HttpError(400, 'Max height must be 480, 720, 1080, 1440 or 2160');
    setSetting('max_height', n);
  }
  if (b.encoder !== undefined) {
    if (!ENCODERS.includes(b.encoder)) throw new HttpError(400, 'Unknown encoder');
    setSetting('encoder', b.encoder);
  }
  if (b.public_url !== undefined) {
    const url = String(b.public_url).trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) throw new HttpError(400, 'Public URL must start with http:// or https://');
    setSetting('public_url', url);
  }
  res.json({ settings: getSettings(), encoders: ENCODERS });
});

adminRouter.get('/users', (req, res) => {
  const rows = db
    .prepare(
      'SELECT u.*, (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS video_count, (SELECT COALESCE(SUM(size_bytes), 0) FROM videos v WHERE v.user_id = u.id) AS bytes FROM users u ORDER BY u.created_at ASC',
    )
    .all();
  res.json({ users: rows.map((u) => ({ ...userToPublic(u), video_count: u.video_count, bytes: u.bytes })) });
});

adminRouter.patch('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  if (req.body?.is_admin !== undefined) {
    if (u.id === req.user.id && !req.body.is_admin) throw new HttpError(400, 'You cannot remove your own admin role');
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, u.id);
  }
  res.json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

adminRouter.delete('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  if (u.id === req.user.id) throw new HttpError(400, 'You cannot delete your own account from here');
  const videos = db.prepare('SELECT original_path, file_path, thumb_path FROM videos WHERE user_id = ?').all(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  for (const v of videos) {
    const files = [
      v.original_path && path.join(DIRS.originals, v.original_path),
      v.file_path && path.join(DIRS.videos, v.file_path),
      v.thumb_path && path.join(DIRS.thumbs, v.thumb_path),
    ];
    for (const f of files) if (f) try { fs.unlinkSync(f); } catch {}
  }
  if (u.avatar) try { fs.unlinkSync(path.join(DIRS.avatars, u.avatar)); } catch {}
  res.json({ ok: true });
});

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return total;
}

adminRouter.get('/stats', (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    videos: db.prepare('SELECT COUNT(*) AS n FROM videos').get().n,
    ready: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'ready'").get().n,
    failed: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'failed'").get().n,
    views: db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM videos').get().n,
    comments: db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,
    disk: { videos: dirSize(DIRS.videos), originals: dirSize(DIRS.originals), thumbs: dirSize(DIRS.thumbs), avatars: dirSize(DIRS.avatars) },
    queue: queueInfo(),
    tools: ffmpegInfo(),
  });
});
