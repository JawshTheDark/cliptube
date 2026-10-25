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
import { videoSelect, serializeVideo, LOCAL_LIST_COLS, REMOTE_LIST_COLS, mapListRow, storageFor, parseSupportLinks } from './videos.js';
import { NETWORK_VISIBLE, serializeRemote, networkActive } from '../network.js';
import { indexVideosOf } from '../search.js';

/** Local channels only; people from other instances have placeholder accounts with no channel page here. */
function channelByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(String(username));
}

export function channelInfo(u, viewer) {
  const own = !!viewer && (viewer.id === u.id || viewer.is_admin);
  const visibility = own ? '' : "AND visibility = 'public' AND moderation_status IS NULL";
  return {
    ...userToPublic(u),
    subscriber_count: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(u.id).n,
    video_count: db.prepare(`SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND status = 'ready' ${visibility}`).get(u.id).n,
    total_views: db.prepare(`SELECT COALESCE(SUM(views), 0) AS n FROM videos WHERE user_id = ? ${visibility}`).get(u.id).n,
    subscribed: viewer ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').get(viewer.id, u.id) : false,
    is_self: !!viewer && viewer.id === u.id,
    support_links: parseSupportLinks(u.support_links),
  };
}

/** Validates support links from the settings form: up to five https links with short labels. */
function cleanSupportLinks(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'Support links must be a list');
  const out = [];
  for (const l of input.slice(0, 5)) {
    const label = str(l?.label, 40).trim();
    const raw = String(l?.url || '').trim();
    if (!raw) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, `"${raw.slice(0, 60)}" is not a valid link`);
    }
    if (url.protocol !== 'https:') throw new HttpError(400, 'Support links must start with https://');
    out.push({ label: label || url.hostname.replace(/^www\./, ''), url: url.href });
  }
  return out;
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
    .prepare(`${videoSelect()} WHERE v.user_id = ? AND v.status = 'ready' ${own ? '' : "AND v.visibility = 'public' AND v.moderation_status IS NULL"} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(u.id, limit, offset);
  res.json({ videos: rows.map(serializeVideo), has_more: rows.length === limit });
});

usersRouter.post('/:username/subscribe', requireAuth, (req, res) => {
  const u = channelByUsername(req.params.username);
  if (!u) throw new HttpError(404, 'Channel not found');
  if (u.id === req.user.id) throw new HttpError(400, 'You cannot subscribe to yourself');
  if (u.moved_to) throw new HttpError(400, `This channel moved to ${u.moved_to_handle || u.moved_to_url}. Subscribe to it there.`);
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

/** New uploads from subscribed channels, on this instance and on others in the network. */
meRouter.get('/feed', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const parts = [
    `SELECT ${LOCAL_LIST_COLS} FROM videos v JOIN users u ON u.id = v.user_id
     WHERE v.status = 'ready' AND v.visibility = 'public' AND v.moderation_status IS NULL AND v.user_id IN (SELECT channel_id FROM subscriptions WHERE subscriber_id = ?)`,
  ];
  const params = [req.user.id];
  if (networkActive()) {
    parts.push(`SELECT ${REMOTE_LIST_COLS} FROM network_videos r JOIN instances p ON p.id = r.instance_id
      JOIN network_subscriptions s ON s.instance_id = r.instance_id AND s.username = r.uploader_username AND s.user_id = ?
      WHERE ${NETWORK_VISIBLE}`);
    params.push(req.user.id);
  }
  const rows = db.prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ videos: rows.map(mapListRow), has_more: rows.length === limit });
});

meRouter.get('/subscriptions', (req, res) => {
  const rows = db
    .prepare('SELECT u.* FROM subscriptions s JOIN users u ON u.id = s.channel_id WHERE s.subscriber_id = ? ORDER BY u.display_name COLLATE NOCASE')
    .all(req.user.id);
  const channels = rows.map((u) => channelInfo(u, req.user));
  if (networkActive()) {
    const remote = db
      .prepare(
        `SELECT s.*, p.name AS peer_name, p.url AS peer_url FROM network_subscriptions s JOIN instances p ON p.id = s.instance_id
         WHERE s.user_id = ? AND p.blocked = 0 ORDER BY s.display_name COLLATE NOCASE`,
      )
      .all(req.user.id);
    for (const r of remote) {
      channels.push({
        id: `r-${r.instance_id}-${r.username}`,
        username: r.username,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        remote: { instance_id: r.instance_id, peer_name: r.peer_name || r.peer_url, profile_url: r.profile_url },
      });
    }
  }
  res.json({ channels });
});

meRouter.get('/liked', (req, res) => {
  const rows = db
    .prepare(
      `${videoSelect('l.created_at AS liked_at')} JOIN likes l ON l.video_id = v.id AND l.user_id = ? WHERE l.value = 1 AND v.status = 'ready' AND v.moderation_status IS NULL AND (v.visibility != 'private' OR v.user_id = ?) ORDER BY l.created_at DESC LIMIT 200`,
    )
    .all(req.user.id, req.user.id);
  const videos = rows.map((r) => ({ ...serializeVideo(r), _at: r.liked_at }));
  if (networkActive()) {
    const remote = db
      .prepare(
        `SELECT r.*, p.name AS peer_name, p.url AS peer_url, l.created_at AS liked_at FROM network_likes l
         JOIN network_videos r ON r.instance_id = l.instance_id AND r.remote_id = l.remote_id
         JOIN instances p ON p.id = r.instance_id
         WHERE l.user_id = ? AND l.value = 1 AND ${NETWORK_VISIBLE} ORDER BY l.created_at DESC LIMIT 200`,
      )
      .all(req.user.id);
    for (const r of remote) videos.push({ ...serializeRemote(r), _at: r.liked_at });
    videos.sort((a, b) => b._at - a._at);
  }
  res.json({ videos: videos.slice(0, 200).map(({ _at, ...v }) => v) });
});

meRouter.get('/history', (req, res) => {
  const rows = db
    .prepare(
      `${videoSelect('h.position, h.watched_at')} JOIN history h ON h.video_id = v.id AND h.user_id = ? WHERE v.status = 'ready' AND v.moderation_status IS NULL AND (v.visibility != 'private' OR v.user_id = ?) ORDER BY h.watched_at DESC LIMIT 200`,
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
  if (display_name !== u.display_name) indexVideosOf(u.id);
  if (b.history_paused !== undefined) db.prepare('UPDATE users SET history_paused = ? WHERE id = ?').run(b.history_paused ? 1 : 0, u.id);
  if (b.comment_mode !== undefined) {
    if (!['open', 'hold_all'].includes(b.comment_mode)) throw new HttpError(400, 'Comment mode must be open or hold_all');
    db.prepare('UPDATE users SET comment_mode = ? WHERE id = ?').run(b.comment_mode, u.id);
  }
  if (b.support_links !== undefined) db.prepare('UPDATE users SET support_links = ? WHERE id = ?').run(JSON.stringify(cleanSupportLinks(b.support_links)), u.id);

  if (b.new_password) {
    if (typeof b.new_password !== 'string' || b.new_password.length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
    if (!(await bcrypt.compare(String(b.current_password || ''), u.password_hash))) throw new HttpError(400, 'Current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(b.new_password, 10), u.id);
  }
  res.json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

/** Account settings that aren't part of the public profile. */
meRouter.get('/settings', (req, res) => {
  const u = db.prepare('SELECT history_paused, comment_mode, delete_requested_at FROM users WHERE id = ?').get(req.user.id);
  res.json({
    history_paused: !!u.history_paused,
    comment_mode: u.comment_mode || 'open',
    comment_filters: db.prepare('SELECT word, action FROM comment_filters WHERE user_id = ? ORDER BY word').all(req.user.id),
    support_links: parseSupportLinks(db.prepare('SELECT support_links FROM users WHERE id = ?').get(req.user.id).support_links),
    storage: storageFor(req.user.id),
    delete_requested_at: u.delete_requested_at || null,
  });
});

meRouter.put('/comment-filters', (req, res) => {
  const list = Array.isArray(req.body?.filters) ? req.body.filters : [];
  const clean = [];
  for (const f of list.slice(0, 200)) {
    const word = str(f?.word, 60).trim().toLowerCase();
    if (word && !clean.some((x) => x.word === word)) clean.push({ word, action: f?.action === 'reject' ? 'reject' : 'hold' });
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM comment_filters WHERE user_id = ?').run(req.user.id);
    const ins = db.prepare('INSERT INTO comment_filters (user_id, word, action) VALUES (?, ?, ?)');
    for (const f of clean) ins.run(req.user.id, f.word, f.action);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ comment_filters: clean });
});

/** Comments waiting for review on this person's videos. */
meRouter.get('/comments/held', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, u.username, u.display_name, u.remote_instance_id, v.title AS video_title FROM comments c
       JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id
       WHERE c.status = 'held' AND v.user_id = ? ORDER BY c.created_at DESC LIMIT 200`,
    )
    .all(req.user.id);
  res.json({
    comments: rows.map((c) => ({
      id: c.id,
      video_id: c.video_id,
      video_title: c.video_title,
      body: c.body,
      held_reason: c.held_reason,
      created_at: c.created_at,
      author: { username: c.username, display_name: c.display_name, remote: !!c.remote_instance_id },
    })),
  });
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
