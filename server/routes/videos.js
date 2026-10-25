import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { DIRS } from '../config.js';
import { requireAuth } from '../auth.js';
import { videoUpload, imageUpload, discard } from '../uploads.js';
import { HttpError, newId, now, parseTags, str, clampInt, sha256 } from '../util.js';
import { enqueue, convertImage } from '../media.js';

export const videosRouter = Router();

const VISIBILITIES = ['public', 'unlisted', 'private'];

export function videoSelect(extra = '') {
  return `SELECT v.*, u.username, u.display_name, u.avatar AS u_avatar${extra ? ', ' + extra : ''} FROM videos v JOIN users u ON u.id = v.user_id`;
}

export function serializeVideo(v) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    visibility: v.visibility,
    status: v.status,
    progress: v.progress,
    error: v.error,
    duration: v.duration,
    width: v.width,
    height: v.height,
    size_bytes: v.size_bytes,
    views: v.views,
    created_at: v.created_at,
    published_at: v.published_at,
    thumbnail_url: v.thumb_path ? `/media/thumbs/${v.thumb_path}` : null,
    video_url: v.status === 'ready' ? `/media/videos/${v.id}.mp4` : null,
    uploader: {
      id: v.user_id,
      username: v.username,
      display_name: v.display_name,
      avatar_url: v.u_avatar ? `/media/avatars/${v.u_avatar}` : null,
    },
    ...(v.position !== undefined ? { position: v.position } : {}),
    ...(v.like_count !== undefined ? { likes: v.like_count, comment_count: v.comment_count } : {}),
  };
}

export function loadVideo(id) {
  return db.prepare(`${videoSelect()} WHERE v.id = ?`).get(String(id));
}

export function canView(v, user) {
  if (v.visibility !== 'private') return true;
  return !!user && (user.id === v.user_id || user.is_admin);
}

export function canEdit(v, user) {
  return !!user && (user.id === v.user_id || user.is_admin);
}

function getViewable(id, user) {
  const v = loadVideo(id);
  if (!v || !canView(v, user)) throw new HttpError(404, 'Video not found');
  return v;
}

function getEditable(id, user) {
  const v = loadVideo(id);
  if (!v || !canEdit(v, user)) throw new HttpError(404, 'Video not found');
  return v;
}

function setTags(videoId, tags) {
  db.prepare('DELETE FROM tags WHERE video_id = ?').run(videoId);
  const ins = db.prepare('INSERT OR IGNORE INTO tags (video_id, tag) VALUES (?, ?)');
  for (const t of tags) ins.run(videoId, t);
}

export function fullVideo(id, user) {
  const v = loadVideo(id);
  if (!v) return null;
  const out = serializeVideo(v);
  const lk = db.prepare('SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes FROM likes WHERE video_id = ?').get(v.id);
  out.likes = lk.likes;
  out.dislikes = lk.dislikes;
  out.my_like = user ? db.prepare('SELECT value FROM likes WHERE user_id = ? AND video_id = ?').get(user.id, v.id)?.value || 0 : 0;
  out.tags = db.prepare('SELECT tag FROM tags WHERE video_id = ? ORDER BY tag').all(v.id).map((r) => r.tag);
  out.comment_count = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE video_id = ?').get(v.id).n;
  out.uploader.subscriber_count = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(v.user_id).n;
  out.subscribed = user ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').get(user.id, v.user_id) : false;
  out.can_edit = canEdit(v, user);
  out.resume_at = user ? db.prepare('SELECT position FROM history WHERE user_id = ? AND video_id = ?').get(user.id, v.id)?.position || 0 : 0;
  out.original_available = !!(v.original_path && fs.existsSync(path.join(DIRS.originals, v.original_path)));
  out.original_name = v.original_name;
  return out;
}

// ---- listing & search -------------------------------------------------------

videosRouter.get('/', (req, res) => {
  const { q, tag, sort = 'new', user } = req.query;
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  const where = ["v.status = 'ready'", "v.visibility = 'public'"];
  const params = [];

  if (q && String(q).trim()) {
    const like = `%${String(q).trim().replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    where.push(
      "(v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM tags t WHERE t.video_id = v.id AND t.tag LIKE ? ESCAPE '\\'))",
    );
    params.push(like, like, like, like, like);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM tags t WHERE t.video_id = v.id AND t.tag = ?)');
    params.push(String(tag).toLowerCase());
  }
  if (user) {
    where.push('u.username = ?');
    params.push(String(user));
  }

  const order = {
    views: 'v.views DESC, v.created_at DESC',
    top: 'score DESC, v.views DESC, v.created_at DESC',
    old: 'v.created_at ASC',
    new: 'v.created_at DESC',
  }[sort] || 'v.created_at DESC';

  const rows = db
    .prepare(`${videoSelect('(SELECT COALESCE(SUM(value), 0) FROM likes l WHERE l.video_id = v.id) AS score')} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  res.json({ videos: rows.map(serializeVideo), has_more: rows.length === limit });
});

videosRouter.get('/tags', (req, res) => {
  const rows = db
    .prepare(
      "SELECT t.tag, COUNT(*) AS n FROM tags t JOIN videos v ON v.id = t.video_id WHERE v.status = 'ready' AND v.visibility = 'public' GROUP BY t.tag ORDER BY n DESC, t.tag ASC LIMIT 30",
    )
    .all();
  res.json({ tags: rows.map((r) => ({ tag: r.tag, count: r.n })) });
});

// ---- upload -----------------------------------------------------------------

videosRouter.post('/', requireAuth, videoUpload, (req, res) => {
  if (!req.file) throw new HttpError(400, 'No video file was received');
  const id = newId();
  const ext = path.extname(req.file.originalname).toLowerCase();
  const originalName = `${id}${ext}`;
  fs.renameSync(req.file.path, path.join(DIRS.originals, originalName));

  const fallbackTitle = path.basename(req.file.originalname, ext).replace(/_+/g, ' ').trim().slice(0, 120);
  const title = str(req.body.title, 120).trim() || fallbackTitle || 'Untitled clip';
  const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : 'public';

  db.prepare(
    "INSERT INTO videos (id, user_id, title, description, visibility, status, original_name, original_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
  ).run(id, req.user.id, title, str(req.body.description), visibility, req.file.originalname.slice(0, 255), originalName, req.file.size, now());
  setTags(id, parseTags(req.body.tags));
  enqueue(id);
  res.status(201).json({ video: fullVideo(id, req.user) });
});

// ---- single video -----------------------------------------------------------

videosRouter.get('/:id', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  res.json({ video: fullVideo(v.id, req.user) });
});

videosRouter.get('/:id/related', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const rows = db
    .prepare(
      `${videoSelect(
        '(SELECT COUNT(*) FROM tags t1 JOIN tags t2 ON t1.tag = t2.tag WHERE t1.video_id = v.id AND t2.video_id = ?) AS shared_tags, (v.user_id = ?) AS same_user',
      )} WHERE v.status = 'ready' AND v.visibility = 'public' AND v.id != ? ORDER BY shared_tags DESC, same_user DESC, v.created_at DESC LIMIT 20`,
    )
    .all(v.id, v.user_id, v.id);
  res.json({ videos: rows.map(serializeVideo) });
});

videosRouter.patch('/:id', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  const b = req.body || {};
  const title = b.title !== undefined ? str(b.title, 120).trim() : v.title;
  if (!title) throw new HttpError(400, 'Title is required');
  const description = b.description !== undefined ? str(b.description, 5000) : v.description;
  const visibility = b.visibility !== undefined ? b.visibility : v.visibility;
  if (!VISIBILITIES.includes(visibility)) throw new HttpError(400, 'Visibility must be public, unlisted or private');
  db.prepare('UPDATE videos SET title = ?, description = ?, visibility = ? WHERE id = ?').run(title, description, visibility, v.id);
  if (b.tags !== undefined) setTags(v.id, parseTags(b.tags));
  res.json({ video: fullVideo(v.id, req.user) });
});

videosRouter.post('/:id/thumbnail', requireAuth, imageUpload('thumbnail'), async (req, res) => {
  let v;
  try {
    v = getEditable(req.params.id, req.user);
    if (!req.file) throw new HttpError(400, 'No image was received');
  } catch (e) {
    discard(req.file);
    throw e;
  }
  const name = `${v.id}-${Date.now()}.jpg`;
  try {
    await convertImage(req.file.path, path.join(DIRS.thumbs, name), 'thumb');
  } catch (e) {
    throw new HttpError(400, `Could not read that image: ${e.message}`);
  } finally {
    discard(req.file);
  }
  if (v.thumb_path) try { fs.unlinkSync(path.join(DIRS.thumbs, v.thumb_path)); } catch {}
  db.prepare('UPDATE videos SET thumb_path = ?, custom_thumb = 1 WHERE id = ?').run(name, v.id);
  res.json({ video: fullVideo(v.id, req.user) });
});

videosRouter.delete('/:id', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  const files = [
    v.original_path && path.join(DIRS.originals, v.original_path),
    v.file_path && path.join(DIRS.videos, v.file_path),
    v.thumb_path && path.join(DIRS.thumbs, v.thumb_path),
  ];
  for (const f of files) if (f) try { fs.unlinkSync(f); } catch {}
  res.json({ ok: true });
});

videosRouter.post('/:id/retry', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  if (v.status !== 'failed') throw new HttpError(400, 'Only failed videos can be retried');
  if (!v.original_path || !fs.existsSync(path.join(DIRS.originals, v.original_path))) {
    throw new HttpError(400, 'The original file is gone, please upload again');
  }
  db.prepare("UPDATE videos SET status = 'queued', progress = 0, error = NULL WHERE id = ?").run(v.id);
  enqueue(v.id);
  res.json({ video: fullVideo(v.id, req.user) });
});

// ---- views, history, likes --------------------------------------------------

videosRouter.post('/:id/view', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const key = req.user ? `u:${req.user.id}` : `a:${sha256(`${req.ip || ''}|${req.get('user-agent') || ''}`)}`;
  const t = now();
  const prev = db.prepare('SELECT viewed_at FROM views WHERE video_id = ? AND viewer_key = ?').get(v.id, key);
  if (!prev || t - prev.viewed_at > 6 * 3600 * 1000) {
    db.prepare('INSERT INTO views (video_id, viewer_key, viewed_at) VALUES (?, ?, ?) ON CONFLICT(video_id, viewer_key) DO UPDATE SET viewed_at = excluded.viewed_at').run(v.id, key, t);
    db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(v.id);
  }
  if (req.user) {
    db.prepare(
      'INSERT INTO history (user_id, video_id, watched_at, position) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, video_id) DO UPDATE SET watched_at = excluded.watched_at',
    ).run(req.user.id, v.id, t);
  }
  res.json({ views: db.prepare('SELECT views FROM videos WHERE id = ?').get(v.id).views });
});

videosRouter.post('/:id/progress', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const pos = Number(req.body?.position);
  if (!Number.isFinite(pos) || pos < 0) throw new HttpError(400, 'Bad position');
  db.prepare(
    'INSERT INTO history (user_id, video_id, watched_at, position) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET position = excluded.position, watched_at = excluded.watched_at',
  ).run(req.user.id, v.id, now(), pos);
  res.json({ ok: true });
});

videosRouter.post('/:id/like', requireAuth, (req, res) => {
  const value = Number(req.body?.value);
  if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value must be 1, -1 or 0');
  const v = getViewable(req.params.id, req.user);
  if (value === 0) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(req.user.id, v.id);
  } else {
    db.prepare(
      'INSERT INTO likes (user_id, video_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
    ).run(req.user.id, v.id, value, now());
  }
  const lk = db.prepare('SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes FROM likes WHERE video_id = ?').get(v.id);
  res.json({ likes: lk.likes, dislikes: lk.dislikes, my_like: value });
});

// ---- comments ---------------------------------------------------------------

const COMMENT_SELECT = 'SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON u.id = c.user_id';

function serializeComment(c, viewer, v) {
  return {
    id: c.id,
    parent_id: c.parent_id,
    body: c.body,
    created_at: c.created_at,
    author: {
      id: c.user_id,
      username: c.username,
      display_name: c.display_name,
      avatar_url: c.avatar ? `/media/avatars/${c.avatar}` : null,
    },
    is_uploader: c.user_id === v.user_id,
    can_delete: !!viewer && (viewer.id === c.user_id || viewer.is_admin || viewer.id === v.user_id),
  };
}

videosRouter.get('/:id/comments', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const rows = db.prepare(`${COMMENT_SELECT} WHERE c.video_id = ? ORDER BY c.created_at ASC`).all(v.id);
  res.json({ comments: rows.map((c) => serializeComment(c, req.user, v)) });
});

videosRouter.post('/:id/comments', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const body = str(req.body?.body, 2000).trim();
  if (!body) throw new HttpError(400, 'Comment cannot be empty');
  let parentId = req.body?.parent_id ? String(req.body.parent_id) : null;
  if (parentId) {
    const p = db.prepare('SELECT id, parent_id FROM comments WHERE id = ? AND video_id = ?').get(parentId, v.id);
    if (!p) throw new HttpError(400, 'That comment no longer exists');
    if (p.parent_id) parentId = p.parent_id; // keep threads one level deep
  }
  const id = newId();
  db.prepare('INSERT INTO comments (id, video_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, v.id, req.user.id, parentId, body, now());
  const c = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id);
  res.status(201).json({ comment: serializeComment(c, req.user, v) });
});

videosRouter.delete('/:id/comments/:cid', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const c = db.prepare('SELECT * FROM comments WHERE id = ? AND video_id = ?').get(String(req.params.cid), v.id);
  if (!c) throw new HttpError(404, 'Comment not found');
  if (!(req.user.id === c.user_id || req.user.is_admin || req.user.id === v.user_id)) throw new HttpError(403, 'You cannot delete that comment');
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});
