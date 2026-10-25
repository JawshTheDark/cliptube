import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, touchVideo } from '../db.js';
import { DIRS } from '../config.js';
import { requireAuth } from '../auth.js';
import { videoUpload, imageUpload, discard } from '../uploads.js';
import { HttpError, newId, now, parseTags, str, clampInt, sha256 } from '../util.js';
import { enqueue, enqueueRender, convertImage, grabFrame, editorAssets, editorDir } from '../media.js';
import { intakeComment, intakeLike } from '../intake.js';
import { networkActive, serializeRemote, NETWORK_VISIBLE, acceptsFromNetwork, publicComment, onLocalVideosChanged } from '../network.js';

export const videosRouter = Router();

// After any successful change to a video (details, thumbnail, delete, edit revert), let the
// network hub know so other instances pick it up quickly. Debounced, and a no-op when not a member.
videosRouter.use((req, res, next) => {
  if (req.method !== 'GET' && !/\/(view|progress|like|comments)(\/|$)/.test(req.path)) {
    res.on('finish', () => {
      if (res.statusCode < 400) onLocalVideosChanged();
    });
  }
  next();
});

const VISIBILITIES = ['public', 'unlisted', 'private'];

export function videoSelect(extra = '') {
  return `SELECT v.*, u.username, u.display_name, u.avatar AS u_avatar${extra ? ', ' + extra : ''} FROM videos v JOIN users u ON u.id = v.user_id`;
}

/** Versioned URL so browsers and CDNs fetch the new file after an edit. */
export function videoUrl(v) {
  return `/media/videos/${v.id}.mp4${v.edit_version ? `?v=${v.edit_version}` : ''}`;
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
    video_url: v.status === 'ready' ? videoUrl(v) : null,
    edited: !!v.edit_json,
    render_status: v.render_status || null,
    render_progress: v.render_progress || 0,
    render_error: v.render_error || null,
    federate: v.federate !== 0,
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

export function getEditable(id, user) {
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
  out.base_duration = v.base_duration || v.duration;
  out.fps = v.fps || 0;
  return out;
}

function removeFiles(v) {
  const files = [
    v.original_path && path.join(DIRS.originals, v.original_path),
    v.file_path && path.join(DIRS.videos, v.file_path),
    v.base_path && v.base_path !== v.file_path && path.join(DIRS.videos, v.base_path),
    v.thumb_path && path.join(DIRS.thumbs, v.thumb_path),
  ];
  for (const f of files) if (f) try { fs.unlinkSync(f); } catch {}
  try { fs.rmSync(editorDir(v.id), { recursive: true, force: true }); } catch {}
}
export { removeFiles as removeVideoFiles };

// ---- listing & search -------------------------------------------------------

/** Columns for mixed local + network listings (UNION ALL of these two, then mapListRow). */
export const LOCAL_LIST_COLS = `'local' AS src, v.id AS vid, NULL AS peer_id, v.title, v.description, v.duration, v.width, v.height, v.views,
  v.created_at, v.thumb_path AS thumb, v.edit_version AS ver, v.user_id, u.username AS u_username, u.display_name AS u_display,
  u.avatar AS u_avatar, NULL AS u_avatar_url, NULL AS thumb_url, NULL AS video_url, NULL AS watch_url, NULL AS uploader_url,
  NULL AS peer_name, NULL AS peer_url, '' AS tags, (SELECT COALESCE(SUM(value), 0) FROM likes l WHERE l.video_id = v.id) AS score`;
export const REMOTE_LIST_COLS = `'remote' AS src, r.remote_id AS vid, r.instance_id AS peer_id, r.title, r.description, r.duration, r.width,
  r.height, r.views, r.created_at, NULL AS thumb, 0 AS ver, NULL AS user_id, r.uploader_username AS u_username,
  r.uploader_display_name AS u_display, NULL AS u_avatar, r.uploader_avatar_url AS u_avatar_url, r.thumbnail_url AS thumb_url,
  r.video_url, r.watch_url, r.uploader_url, p.name AS peer_name, p.url AS peer_url, r.tags, r.likes AS score`;

export function mapListRow(r) {
  if (r.src === 'local') {
    return {
      id: r.vid,
      title: r.title,
      description: r.description,
      visibility: 'public',
      status: 'ready',
      duration: r.duration,
      width: r.width,
      height: r.height,
      views: r.views,
      created_at: r.created_at,
      thumbnail_url: r.thumb ? `/media/thumbs/${r.thumb}` : null,
      video_url: videoUrl({ id: r.vid, edit_version: r.ver }),
      uploader: { id: r.user_id, username: r.u_username, display_name: r.u_display, avatar_url: r.u_avatar ? `/media/avatars/${r.u_avatar}` : null },
    };
  }
  return serializeRemote({
    instance_id: r.peer_id, remote_id: r.vid, title: r.title, description: r.description, duration: r.duration, width: r.width,
    height: r.height, views: r.views, likes: r.score, created_at: r.created_at, tags: r.tags, thumbnail_url: r.thumb_url,
    video_url: r.video_url, watch_url: r.watch_url, uploader_username: r.u_username, uploader_display_name: r.u_display,
    uploader_avatar_url: r.u_avatar_url, uploader_url: r.uploader_url, peer_name: r.peer_name, peer_url: r.peer_url,
  });
}

function likeParam(q) {
  return `%${String(q).trim().replace(/[%_\\]/g, (c) => '\\' + c)}%`;
}

/**
 * Lists public videos. `scope` = local (this instance), network (federated peers) or all (both,
 * merged into one ordering). Network results only appear while this instance is in a network.
 */
videosRouter.get('/', (req, res) => {
  const { q, tag, sort = 'new', user } = req.query;
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  let scope = ['local', 'network', 'all'].includes(req.query.scope) ? req.query.scope : 'local';
  if (!networkActive() || user) scope = 'local';
  const peer = req.query.peer ? Number(req.query.peer) : null;

  const parts = [];
  const params = [];

  if (scope !== 'network') {
    const where = ["v.status = 'ready'", "v.visibility = 'public'"];
    if (q && String(q).trim()) {
      const like = likeParam(q);
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
    parts.push(`SELECT ${LOCAL_LIST_COLS} FROM videos v JOIN users u ON u.id = v.user_id WHERE ${where.join(' AND ')}`);
  }

  if (scope !== 'local') {
    const where = [NETWORK_VISIBLE];
    if (peer) {
      where.push('r.instance_id = ?');
      params.push(peer);
    }
    if (q && String(q).trim()) {
      const like = likeParam(q);
      where.push(
        "(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\' OR r.uploader_display_name LIKE ? ESCAPE '\\' OR r.uploader_username LIKE ? ESCAPE '\\' OR r.tags LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like, like);
    }
    if (tag) {
      where.push("(',' || r.tags || ',') LIKE ?");
      params.push(`%,${String(tag).toLowerCase()},%`);
    }
    parts.push(`SELECT ${REMOTE_LIST_COLS} FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${where.join(' AND ')}`);
  }

  const order = {
    views: 'views DESC, created_at DESC',
    top: 'score DESC, views DESC, created_at DESC',
    old: 'created_at ASC',
    new: 'created_at DESC',
  }[sort] || 'created_at DESC';

  const rows = db.prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ videos: rows.map(mapListRow), has_more: rows.length === limit, scope });
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
  const t = now();

  db.prepare(
    "INSERT INTO videos (id, user_id, title, description, visibility, status, original_name, original_path, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
  ).run(id, req.user.id, title, str(req.body.description), visibility, req.file.originalname.slice(0, 255), originalName, req.file.size, t, t);
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
  const federate = b.federate !== undefined ? (b.federate ? 1 : 0) : v.federate;
  db.prepare('UPDATE videos SET title = ?, description = ?, visibility = ?, federate = ?, updated_at = ? WHERE id = ?').run(
    title, description, visibility, federate, now(), v.id,
  );
  if (b.tags !== undefined) setTags(v.id, parseTags(b.tags));
  res.json({ video: fullVideo(v.id, req.user) });
});

async function replaceThumbnail(v, produce) {
  const name = `${v.id}-${Date.now()}.jpg`;
  await produce(path.join(DIRS.thumbs, name));
  if (v.thumb_path) try { fs.unlinkSync(path.join(DIRS.thumbs, v.thumb_path)); } catch {}
  db.prepare('UPDATE videos SET thumb_path = ?, custom_thumb = 1, updated_at = ? WHERE id = ?').run(name, now(), v.id);
}

videosRouter.post('/:id/thumbnail', requireAuth, imageUpload('thumbnail'), async (req, res) => {
  let v;
  try {
    v = getEditable(req.params.id, req.user);
    if (!req.file) throw new HttpError(400, 'No image was received');
  } catch (e) {
    discard(req.file);
    throw e;
  }
  try {
    await replaceThumbnail(v, (out) => convertImage(req.file.path, out, 'thumb'));
  } catch (e) {
    throw new HttpError(400, `Could not read that image: ${e.message}`);
  } finally {
    discard(req.file);
  }
  res.json({ video: fullVideo(v.id, req.user) });
});

/** Uses a frame of the source video (editor timeline time) as the thumbnail. */
videosRouter.post('/:id/thumbnail/frame', requireAuth, async (req, res) => {
  const v = getEditable(req.params.id, req.user);
  if (v.status !== 'ready' || !v.base_path) throw new HttpError(400, 'The video is not ready yet');
  const dur = v.base_duration || v.duration;
  const t = Math.min(Math.max(0, Number(req.body?.time) || 0), Math.max(0, dur - 0.05));
  try {
    await replaceThumbnail(v, (out) => grabFrame(path.join(DIRS.videos, v.base_path), t, out));
  } catch (e) {
    throw new HttpError(500, `Could not grab that frame: ${e.message}`);
  }
  res.json({ video: fullVideo(v.id, req.user) });
});

videosRouter.delete('/:id', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
  removeFiles(v);
  res.json({ ok: true });
});

videosRouter.post('/:id/retry', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  if (v.render_status === 'failed') {
    db.prepare("UPDATE videos SET render_status = 'queued', render_progress = 0, render_error = NULL WHERE id = ?").run(v.id);
    enqueueRender(v.id);
    return res.json({ video: fullVideo(v.id, req.user) });
  }
  if (v.status !== 'failed') throw new HttpError(400, 'Only failed videos can be retried');
  if (!v.original_path || !fs.existsSync(path.join(DIRS.originals, v.original_path))) {
    throw new HttpError(400, 'The original file is gone, please upload again');
  }
  db.prepare("UPDATE videos SET status = 'queued', progress = 0, error = NULL WHERE id = ?").run(v.id);
  enqueue(v.id);
  res.json({ video: fullVideo(v.id, req.user) });
});

// ---- timeline editor ----------------------------------------------------------

const MIN_PART = 0.05;

/** Validates and normalises an edit decision list against the source duration. */
export function normalizeEdit(body, duration) {
  const input = Array.isArray(body?.segments) ? body.segments : [];
  if (!input.length) throw new HttpError(400, 'Keep at least one part of the video');
  if (input.length > 200) throw new HttpError(400, 'Too many parts (200 max)');
  const r3 = (n) => Math.round(n * 1000) / 1000;
  let segs = input.map((s) => {
    const start = Number(s?.start);
    const end = Number(s?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new HttpError(400, 'Every part needs a start and end time');
    return { start: r3(Math.max(0, Math.min(duration, start))), end: r3(Math.max(0, Math.min(duration, end))) };
  });
  segs = segs.filter((s) => s.end - s.start >= MIN_PART).sort((a, b) => a.start - b.start);
  if (!segs.length) throw new HttpError(400, 'The parts you kept are too short');
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && s.start < prev.end - 0.001) throw new HttpError(400, 'Two parts overlap');
    if (prev && s.start - prev.end < 0.001) prev.end = s.end; // touching parts render as one
    else merged.push({ ...s });
  }
  const total = merged.reduce((n, s) => n + s.end - s.start, 0);
  if (total < 0.5) throw new HttpError(400, 'The edited video must be at least half a second long');
  const volume = Math.max(0, Math.min(3, Number(body.volume ?? 1)));
  const fade = (x) => Math.max(0, Math.min(5, Number(x) || 0, total / 2));
  return {
    segments: merged,
    volume: Number.isFinite(volume) ? Math.round(volume * 100) / 100 : 1,
    muted: !!body.muted,
    fade_in: r3(fade(body.fade_in)),
    fade_out: r3(fade(body.fade_out)),
  };
}

function isIdentity(edit, duration) {
  return (
    edit.segments.length === 1 &&
    edit.segments[0].start < 0.05 &&
    edit.segments[0].end > duration - 0.05 &&
    edit.volume === 1 &&
    !edit.muted &&
    !edit.fade_in &&
    !edit.fade_out
  );
}

/** Puts the unedited first-generation file back in place. */
function revertEdit(v) {
  const t = now();
  let size = v.size_bytes;
  try { size = fs.statSync(path.join(DIRS.videos, v.base_path)).size; } catch {}
  db.prepare(
    'UPDATE videos SET edit_json = NULL, edit_version = edit_version + 1, render_status = NULL, render_progress = 0, render_error = NULL, file_path = base_path, duration = COALESCE(base_duration, duration), size_bytes = ?, updated_at = ? WHERE id = ?',
  ).run(size, t, v.id);
  if (v.file_path && v.file_path !== v.base_path) try { fs.unlinkSync(path.join(DIRS.videos, v.file_path)); } catch {}
}

videosRouter.get('/:id/editor', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  if (v.status !== 'ready' || !v.base_path) throw new HttpError(400, 'The video has to finish processing before it can be edited');
  res.json({
    video: fullVideo(v.id, req.user),
    edit: v.edit_json ? JSON.parse(v.edit_json) : null,
    duration: v.base_duration || v.duration,
    source_url: `/media/source/${v.id}.mp4`,
    sprite_url: `/media/editor/${v.id}/sprite.jpg?b=${encodeURIComponent(v.base_path)}`,
    assets: editorAssets(v),
  });
});

videosRouter.get('/:id/editor/waveform', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  const file = path.join(editorDir(v.id), 'waveform.json');
  if (!fs.existsSync(file)) throw new HttpError(404, 'Waveform not ready');
  res.type('json').send(fs.readFileSync(file));
});

videosRouter.post('/:id/edit', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  if (v.status !== 'ready' || !v.base_path) throw new HttpError(400, 'The video has to finish processing before it can be edited');
  const duration = v.base_duration || v.duration;
  const edit = normalizeEdit(req.body, duration);
  if (isIdentity(edit, duration)) {
    if (v.edit_json) revertEdit(v);
    return res.json({ video: fullVideo(v.id, req.user), edit: null });
  }
  db.prepare("UPDATE videos SET edit_json = ?, edit_version = edit_version + 1, render_status = 'queued', render_progress = 0, render_error = NULL WHERE id = ?").run(
    JSON.stringify(edit), v.id,
  );
  enqueueRender(v.id);
  res.json({ video: fullVideo(v.id, req.user), edit });
});

videosRouter.delete('/:id/edit', requireAuth, (req, res) => {
  const v = getEditable(req.params.id, req.user);
  if (!v.edit_json && !v.render_status) return res.json({ video: fullVideo(v.id, req.user), edit: null });
  revertEdit(v);
  res.json({ video: fullVideo(v.id, req.user), edit: null });
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
  if (value !== 0) {
    const verdict = intakeLike({ video: v, author: req.user, value, remote: false, instance: null });
    if (verdict.status === 'rejected') throw new HttpError(403, verdict.reason || 'Not allowed');
  }
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

const COMMENT_SELECT =
  'SELECT c.*, u.username, u.display_name, u.avatar, u.remote_instance_id, u.remote_avatar_url, u.remote_profile_url FROM comments c JOIN users u ON u.id = c.user_id';

function serializeComment(c, viewer, v) {
  return {
    ...publicComment(c, v.user_id),
    can_delete: !!viewer && (viewer.id === c.user_id || viewer.is_moderator || viewer.id === v.user_id),
  };
}

videosRouter.get('/:id/comments', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const rows = db.prepare(`${COMMENT_SELECT} WHERE c.video_id = ? ORDER BY c.created_at ASC`).all(v.id);
  res.json({
    comments: rows.map((c) => serializeComment(c, req.user, v)),
    // Lets other instances know whether their people can comment here.
    network_accepts: networkActive() ? acceptsFromNetwork() : null,
  });
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
  const verdict = intakeComment({ video: v, author: req.user, body, parentId, remote: false, instance: null });
  if (verdict.status === 'rejected') throw new HttpError(400, verdict.reason || 'Comment not accepted');
  const id = newId();
  db.prepare('INSERT INTO comments (id, video_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, v.id, req.user.id, parentId, body, now());
  const c = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id);
  res.status(201).json({ comment: serializeComment(c, req.user, v) });
});

videosRouter.delete('/:id/comments/:cid', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const c = db.prepare('SELECT * FROM comments WHERE id = ? AND video_id = ?').get(String(req.params.cid), v.id);
  if (!c) throw new HttpError(404, 'Comment not found');
  if (!(req.user.id === c.user_id || req.user.is_moderator || req.user.id === v.user_id)) throw new HttpError(403, 'You cannot delete that comment');
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

export { touchVideo };
