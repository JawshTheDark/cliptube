/**
 * Personal data: export everything about an account (as a tar archive with the uploads), and
 * self-serve account deletion with a grace period. Mounted at /api/me.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { DIRS } from './config.js';
import { requireAuth, userToPublic } from './auth.js';
import { HttpError, now } from './util.js';
import { defineJob, enqueueJob, jobPending } from './jobs.js';
import { writeTar } from './tar.js';
import { announceAccountDeletion } from './network.js';
import { removeVideoFiles } from './routes/videos.js';
import { logAction } from './reports.js';
import { sendActorDelete } from './ap/deliver.js';

const DAY = 24 * 3600_000;
export const DELETE_GRACE_DAYS = 7;

export const privacyRouter = Router();
privacyRouter.use(requireAuth);

// ---- export ---------------------------------------------------------------------------------

function exportData(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const videos = db.prepare('SELECT * FROM videos WHERE user_id = ? ORDER BY created_at').all(userId);
  const tags = db.prepare('SELECT video_id, tag FROM tags WHERE video_id IN (SELECT id FROM videos WHERE user_id = ?)').all(userId);
  const tagsBy = {};
  for (const t of tags) (tagsBy[t.video_id] ||= []).push(t.tag);
  return {
    exported_at: new Date().toISOString(),
    format: 'cliptube-personal-export-1',
    account: {
      username: u.username,
      display_name: u.display_name,
      bio: u.bio,
      role: u.role,
      created_at: new Date(u.created_at).toISOString(),
    },
    videos: videos.map((v) => ({
      id: v.id,
      title: v.title,
      description: v.description,
      tags: tagsBy[v.id] || [],
      visibility: v.visibility,
      views: v.views,
      duration: v.duration,
      width: v.width,
      height: v.height,
      created_at: new Date(v.created_at).toISOString(),
      original_name: v.original_name,
      file: v.file_path ? `videos/${v.id}.mp4` : null,
      original_file: v.original_path ? `originals/${v.original_path}` : null,
      edited: !!v.edit_json,
      edit: v.edit_json ? JSON.parse(v.edit_json) : null,
    })),
    comments: db
      .prepare('SELECT c.id, c.video_id, c.parent_id, c.body, c.status, c.created_at FROM comments c WHERE c.user_id = ? ORDER BY c.created_at')
      .all(userId)
      .map((c) => ({ ...c, created_at: new Date(c.created_at).toISOString() })),
    comments_on_your_videos: db
      .prepare('SELECT c.id, c.video_id, c.body, u.username AS author, c.created_at FROM comments c JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id WHERE v.user_id = ? ORDER BY c.created_at')
      .all(userId)
      .map((c) => ({ ...c, created_at: new Date(c.created_at).toISOString() })),
    likes: db.prepare('SELECT video_id, value, created_at FROM likes WHERE user_id = ?').all(userId),
    network_likes: db.prepare('SELECT i.url AS instance, l.remote_id, l.value, l.created_at FROM network_likes l JOIN instances i ON i.id = l.instance_id WHERE l.user_id = ?').all(userId),
    subscriptions: db.prepare('SELECT u.username, s.created_at FROM subscriptions s JOIN users u ON u.id = s.channel_id WHERE s.subscriber_id = ?').all(userId),
    network_subscriptions: db.prepare('SELECT i.url AS instance, s.username, s.created_at FROM network_subscriptions s JOIN instances i ON i.id = s.instance_id WHERE s.user_id = ?').all(userId),
    linked_accounts: db.prepare('SELECT handle, profile_url, created_at, verified_at FROM account_links WHERE user_id = ? ORDER BY created_at').all(userId),
    playlists: db
      .prepare("SELECT id, title, description, visibility, kind, created_at FROM playlists WHERE user_id = ? AND kind != 'party' ORDER BY created_at")
      .all(userId)
      .map((p) => ({ ...p, videos: db.prepare('SELECT video_id, instance_id, remote_id, title, added_at FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(p.id) })),
    subscribers: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(userId).n,
    watch_history: db.prepare('SELECT video_id, watched_at, position FROM history WHERE user_id = ? ORDER BY watched_at DESC').all(userId),
  };
}

defineJob('user.export', {
  maxAttempts: 2,
  handler: async ({ userId }) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u) return;
    fs.mkdirSync(DIRS.exports, { recursive: true });
    const data = exportData(userId);
    const root = `cliptube-${u.username}`;
    const entries = [{ name: `${root}/export.json`, data: JSON.stringify(data, null, 2) }];
    for (const v of db.prepare('SELECT * FROM videos WHERE user_id = ?').all(userId)) {
      if (v.file_path && fs.existsSync(path.join(DIRS.videos, v.file_path))) entries.push({ name: `${root}/videos/${v.id}.mp4`, file: path.join(DIRS.videos, v.file_path) });
      if (v.original_path && fs.existsSync(path.join(DIRS.originals, v.original_path))) entries.push({ name: `${root}/originals/${v.original_path}`, file: path.join(DIRS.originals, v.original_path) });
      if (v.thumb_path && fs.existsSync(path.join(DIRS.thumbs, v.thumb_path))) entries.push({ name: `${root}/thumbnails/${v.id}.jpg`, file: path.join(DIRS.thumbs, v.thumb_path) });
    }
    if (u.avatar && fs.existsSync(path.join(DIRS.avatars, u.avatar))) entries.push({ name: `${root}/avatar.jpg`, file: path.join(DIRS.avatars, u.avatar) });
    const file = `export-${u.id}-${Date.now()}.tar`;
    const tmp = path.join(DIRS.exports, `${file}.part`);
    await writeTar(tmp, entries);
    fs.renameSync(tmp, path.join(DIRS.exports, file));
    enqueueJob('user.export.cleanup', { file }, { delay: 7 * DAY });
  },
});

defineJob('user.export.cleanup', {
  handler: ({ file }) => {
    try {
      fs.unlinkSync(path.join(DIRS.exports, path.basename(file)));
    } catch {}
  },
});

function exportsFor(userId) {
  let files = [];
  try {
    files = fs.readdirSync(DIRS.exports).filter((f) => f.startsWith(`export-${userId}-`) && f.endsWith('.tar'));
  } catch {}
  return files
    .map((f) => {
      const st = fs.statSync(path.join(DIRS.exports, f));
      return { file: f, size: st.size, created_at: st.mtimeMs, expires_at: st.mtimeMs + 7 * DAY };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

privacyRouter.get('/exports', (req, res) => {
  res.json({ exports: exportsFor(req.user.id), preparing: jobPending(`export:${req.user.id}`) });
});

privacyRouter.post('/exports', (req, res) => {
  enqueueJob('user.export', { userId: req.user.id }, { dedupe: `export:${req.user.id}` });
  res.status(202).json({ preparing: true });
});

privacyRouter.get('/exports/:file', (req, res) => {
  const file = path.basename(String(req.params.file));
  if (!file.startsWith(`export-${req.user.id}-`) || !file.endsWith('.tar')) throw new HttpError(404, 'Not found');
  const full = path.join(DIRS.exports, file);
  if (!fs.existsSync(full)) throw new HttpError(404, 'This export has expired');
  res.download(full, `cliptube-${req.user.username}-export.tar`);
});

// ---- deletion -----------------------------------------------------------------------------------

/** Deletes an account and everything it owns, after telling the network. */
export async function deleteAccount(userId, actor = null) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return;
  try {
    await announceAccountDeletion(userToPublic(u));
  } catch {}
  try {
    sendActorDelete(u); // fediverse followers of the account and its channel
  } catch {}
  const videos = db.prepare('SELECT * FROM videos WHERE user_id = ?').all(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  for (const v of videos) removeVideoFiles(v);
  if (u.avatar) {
    try {
      fs.unlinkSync(path.join(DIRS.avatars, u.avatar));
    } catch {}
  }
  for (const f of exportsFor(userId)) {
    try {
      fs.unlinkSync(path.join(DIRS.exports, f.file));
    } catch {}
  }
  logAction(actor, 'user.delete', { targetType: 'user', targetId: userId, targetLabel: u.username, details: actor ? 'Deleted by an admin' : 'Deleted at the owner\'s request' });
}

defineJob('user.delete', {
  maxAttempts: 3,
  handler: async ({ userId, requested_at }) => {
    const u = db.prepare('SELECT delete_requested_at FROM users WHERE id = ?').get(userId);
    // Cancelled, or re-requested later (that request has its own job).
    if (!u || u.delete_requested_at !== requested_at) return;
    await deleteAccount(userId);
  },
});

privacyRouter.get('/deletion', (req, res) => {
  const u = db.prepare('SELECT delete_requested_at FROM users WHERE id = ?').get(req.user.id);
  res.json({
    requested_at: u?.delete_requested_at || null,
    deletes_at: u?.delete_requested_at ? u.delete_requested_at + DELETE_GRACE_DAYS * DAY : null,
  });
});

privacyRouter.post('/deletion', async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(String(req.body?.password || ''), u.password_hash))) throw new HttpError(400, 'Password is wrong');
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND remote_instance_id IS NULL").get().n <= 1) {
    throw new HttpError(400, 'You are the only admin. Make someone else an admin first.');
  }
  const t = now();
  db.prepare('UPDATE users SET delete_requested_at = ? WHERE id = ?').run(t, u.id);
  enqueueJob('user.delete', { userId: u.id, requested_at: t }, { delay: DELETE_GRACE_DAYS * DAY });
  res.json({ requested_at: t, deletes_at: t + DELETE_GRACE_DAYS * DAY });
});

privacyRouter.delete('/deletion', (req, res) => {
  db.prepare('UPDATE users SET delete_requested_at = NULL WHERE id = ?').run(req.user.id);
  res.json({ requested_at: null, deletes_at: null });
});
