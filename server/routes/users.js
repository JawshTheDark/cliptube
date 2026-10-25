import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { DIRS } from '../config.js';
import { requireAuth, userToPublic } from '../auth.js';
import { imageUpload, discard } from '../uploads.js';
import { HttpError, now, str, clampInt } from '../util.js';
import { convertImage } from '../media.js';
import { videoSelect, serializeVideo } from './videos.js';

function channelByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
}

export function channelInfo(u, viewer) {
  const own = !!viewer && (viewer.id === u.id || viewer.is_admin);
  const visibility = own ? '' : "AND visibility = 'public'";
  return {
    ...userToPublic(u),
    subscriber_count: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(u.id).n,
    video_count: db.prepare(`SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND status = 'ready' ${visibility}`).get(u.id).n,
    total_views: db.prepare(`SELECT COALESCE(SUM(views), 0) AS n FROM videos WHERE user_id = ? ${visibility}`).get(u.id).n,
    subscribed: viewer ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').get(viewer.id, u.id) : false,
    is_self: !!viewer && viewer.id === u.id,
  };
}

// ---- /api/users -------------------------------------------------------------

export const usersRouter = Router();

usersRouter.get('/:username', (req, res) => {
  const u = channelByUsername(req.params.username);
  if (!u) throw new HttpError(404, 'Channel not found');
  res.json({ channel: channelInfo(u, req.user) });
});

usersRouter.get('/:username/videos', (req, res) => {
  const u = channelByUsername(req.params.username);
  if (!u) throw new HttpError(404, 'Channel not found');
  const own = !!req.user && (req.user.id === u.id || req.user.is_admin);
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const order = { views: 'v.views DESC, v.created_at DESC', old: 'v.created_at ASC' }[req.query.sort] || 'v.created_at DESC';
  const rows = db
    .prepare(`${videoSelect()} WHERE v.user_id = ? AND v.status = 'ready' ${own ? '' : "AND v.visibility = 'public'"} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(u.id, limit, offset);
  res.json({ videos: rows.map(serializeVideo), has_more: rows.length === limit });
});

usersRouter.post('/:username/subscribe', requireAuth, (req, res) => {
  const u = channelByUsername(req.params.username);
  if (!u) throw new HttpError(404, 'Channel not found');
  if (u.id === req.user.id) throw new HttpError(400, 'You cannot subscribe to yourself');
  db.prepare('INSERT OR IGNORE INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)').run(req.user.id, u.id, now());
  res.json({ channel: channelInfo(u, req.user) });
});

usersRouter.delete('/:username/subscribe', requireAuth, (req, res) => {
  const u = channelByUsername(req.params.username);
  if (!u) throw new HttpError(404, 'Channel not found');
  db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').run(req.user.id, u.id);
  res.json({ channel: channelInfo(u, req.user) });
});

// ---- /api/me ----------------------------------------------------------------

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/videos', (req, res) => {
  const rows = db
    .prepare(
      `${videoSelect(
        '(SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count, (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comment_count',
      )} WHERE v.user_id = ? ORDER BY v.created_at DESC`,
    )
    .all(req.user.id);
  res.json({ videos: rows.map(serializeVideo) });
});

meRouter.get('/feed', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const rows = db
    .prepare(
      `${videoSelect()} WHERE v.status = 'ready' AND v.visibility = 'public' AND v.user_id IN (SELECT channel_id FROM subscriptions WHERE subscriber_id = ?) ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(req.user.id, limit, offset);
  res.json({ videos: rows.map(serializeVideo), has_more: rows.length === limit });
});

meRouter.get('/subscriptions', (req, res) => {
  const rows = db
    .prepare('SELECT u.* FROM subscriptions s JOIN users u ON u.id = s.channel_id WHERE s.subscriber_id = ? ORDER BY u.display_name COLLATE NOCASE')
    .all(req.user.id);
  res.json({ channels: rows.map((u) => channelInfo(u, req.user)) });
});

meRouter.get('/liked', (req, res) => {
  const rows = db
    .prepare(
      `${videoSelect()} JOIN likes l ON l.video_id = v.id AND l.user_id = ? WHERE l.value = 1 AND v.status = 'ready' AND (v.visibility != 'private' OR v.user_id = ?) ORDER BY l.created_at DESC LIMIT 200`,
    )
    .all(req.user.id, req.user.id);
  res.json({ videos: rows.map(serializeVideo) });
});

meRouter.get('/history', (req, res) => {
  const rows = db
    .prepare(
      `${videoSelect('h.position, h.watched_at')} JOIN history h ON h.video_id = v.id AND h.user_id = ? WHERE v.status = 'ready' AND (v.visibility != 'private' OR v.user_id = ?) ORDER BY h.watched_at DESC LIMIT 200`,
    )
    .all(req.user.id, req.user.id);
  res.json({ videos: rows.map((r) => ({ ...serializeVideo(r), watched_at: r.watched_at })) });
});

meRouter.delete('/history', (req, res) => {
  db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

meRouter.patch('/', async (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const display_name = b.display_name !== undefined ? str(b.display_name, 50).trim() : u.display_name;
  if (!display_name) throw new HttpError(400, 'Display name cannot be empty');
  const bio = b.bio !== undefined ? str(b.bio, 1000) : u.bio;
  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(display_name, bio, u.id);

  if (b.new_password) {
    if (typeof b.new_password !== 'string' || b.new_password.length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    if (!(await bcrypt.compare(String(b.current_password || ''), u.password_hash))) throw new HttpError(400, 'Current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(b.new_password, 10), u.id);
  }
  res.json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

meRouter.post('/avatar', imageUpload('avatar'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No image was received');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const name = `${u.id}-${Date.now()}.jpg`;
  try {
    await convertImage(req.file.path, path.join(DIRS.avatars, name), 'avatar');
  } catch (e) {
    throw new HttpError(400, `Could not read that image: ${e.message}`);
  } finally {
    discard(req.file);
  }
  if (u.avatar) try { fs.unlinkSync(path.join(DIRS.avatars, u.avatar)); } catch {}
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(name, u.id);
  res.json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

meRouter.delete('/avatar', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (u.avatar) try { fs.unlinkSync(path.join(DIRS.avatars, u.avatar)); } catch {}
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(u.id);
  res.json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});
