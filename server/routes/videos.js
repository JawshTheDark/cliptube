import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, touchVideo, getSettings } from '../db.js';
import { DIRS, VIDEO_EXTENSIONS } from '../config.js';
import { requireAuth } from '../auth.js';
import { apBase } from '../ap/common.js';
import { checkServerSpace } from '../storage.js';
import { videoUpload, imageUpload, discard, defineUploadKind, finishedUpload } from '../uploads.js';
import { HttpError, newId, now, parseTags, str, clampInt, sha256 } from '../util.js';
import { enqueue, enqueueRender, convertImage, grabFrame, editorAssets, editorDir, queueRenditions } from '../media.js';
import { intakeComment, intakeLike } from '../intake.js';
import { effectiveCommentMode } from '../spam.js';
import { logAction } from '../reports.js';
import { networkActive, serializeRemote, NETWORK_VISIBLE, acceptsFromNetwork, publicComment, onLocalVideosChanged } from '../network.js';
import { findGame, gameSlugs, networkGameWhere, resolveGame } from '../games.js';
import { removeRenditionFiles, renditionUrls } from '../renditions.js';
import { canDownloadOriginal, communityFor, originalFile, publishedCaptions, publishedSegments, removeWatchingFiles } from '../watching.js';
import { maybeNotifyUpload, notifyComment } from '../notify.js';
import { indexVideo } from '../search.js';
import { recordView, recordWatch, viewSource } from '../stats.js';
import { apCommentCreated, apCommentVerdict, apVideoChanged, sendCommentDelete, sendVideoDelete } from '../ap/deliver.js';
import { isLinkedCommenter } from '../links.js';

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

/** The top-voted community title and thumbnail, as columns (see watching.js). */
const COMMUNITY_COLS = `(SELECT ts.title FROM title_suggestions ts WHERE ts.video_id = v.id AND ts.votes > 0 ORDER BY ts.votes DESC, ts.created_at LIMIT 1) AS c_title,
  (SELECT th.file FROM thumbnail_suggestions th WHERE th.video_id = v.id AND th.votes > 0 ORDER BY th.votes DESC, th.created_at LIMIT 1) AS c_thumb`;
const community = (r) => (r.c_title || r.c_thumb ? { title: r.c_title || null, thumbnail_url: r.c_thumb ? `/media/thumbs/${r.c_thumb}` : null } : null);

export function videoSelect(extra = '') {
  return `SELECT v.*, u.username, u.display_name, u.avatar AS u_avatar, u.support_links AS u_support_links, g.name AS game_name, g.short_name AS game_short,
    ${COMMUNITY_COLS}${extra ? ', ' + extra : ''}
    FROM videos v JOIN users u ON u.id = v.user_id LEFT JOIN games g ON g.id = v.game_id`;
}

/** A channel's support links (tips, merch, Patreon...), validated when saved. */
export function parseSupportLinks(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list.filter((l) => l && typeof l.url === 'string' && /^https:\/\//.test(l.url)).slice(0, 5) : [];
  } catch {
    return [];
  }
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
    // Not published yet: hidden until its details are saved, then it becomes draft_visibility.
    draft: !!v.draft,
    draft_visibility: v.draft ? v.draft_visibility || 'public' : null,
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
    moderation_status: v.moderation_status || null,
    moderation_reason: v.moderation_status ? v.moderation_reason || null : null,
    comment_mode: v.comment_mode || 'inherit',
    game: v.game_id ? { id: v.game_id, name: v.game_name || v.game_id, short_name: v.game_short || null } : null,
    allow_clips: !!v.allow_clips,
    allow_original_download: !!v.allow_original_download,
    community: community(v),
    source: v.source_video_id ? { id: v.source_video_id, start: v.source_start, end: v.source_end } : null,
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

/** Hidden or removed videos are only visible to their uploader and moderators. */
export function canView(v, user) {
  if (v.moderation_status && !(user && (user.id === v.user_id || user.is_moderator))) return false;
  if (v.visibility !== 'private') return true;
  return !!user && (user.id === v.user_id || user.is_admin);
}

/** Who may play the file: removed videos only by moderators (the uploader sees the details, not the video). */
export function canPlay(v, user) {
  if (v.moderation_status === 'removed') return !!user?.is_moderator;
  return canView(v, user);
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

export function setTags(videoId, tags) {
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
  out.can_moderate = !!user?.is_moderator;
  if (!canPlay(v, user)) out.video_url = null;
  out.can_clip = !!user && v.status === 'ready' && !!out.video_url && (canEdit(v, user) || (!!v.allow_clips && v.visibility === 'public' && !v.moderation_status));
  if (v.source_video_id) {
    const s = loadVideo(v.source_video_id);
    out.source = s && canView(s, user)
      ? { id: s.id, title: s.title, start: v.source_start, end: v.source_end, uploader: { username: s.username, display_name: s.display_name } }
      : null;
  }
  out.clip_count = db
    .prepare("SELECT COUNT(*) AS n FROM videos WHERE source_video_id = ? AND status = 'ready' AND visibility = 'public' AND moderation_status IS NULL")
    .get(v.id).n;
  const ren = renditionUrls(v);
  out.hls_url = out.video_url ? ren.hls_url : null;
  out.hls_rungs = out.video_url ? ren.hls_rungs : null;
  out.federation_url = out.video_url ? ren.federation_url : null;
  out.captions = publishedCaptions(v.id);
  out.segments = publishedSegments(v.id);
  if (getSettings().show_dislikes !== 'true' && !canEdit(v, user)) out.dislikes = null;
  out.original_download = null;
  if (out.video_url && canDownloadOriginal(v, user)) {
    const o = originalFile(v);
    if (o) out.original_download = { url: `/media/original/${v.id}`, name: v.original_name || null, size: o.size, upload: o.upload };
  }
  out.uploader.support_links = parseSupportLinks(v.u_support_links);
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
  removeRenditionFiles(v.id);
  removeWatchingFiles(v.id);
  indexVideo(v.id); // the row is gone, so this drops it from search
}
export { removeFiles as removeVideoFiles };

// ---- listing & search -------------------------------------------------------

/** Columns for mixed local + network listings (UNION ALL of these two, then mapListRow). */
export const LOCAL_LIST_COLS = `'local' AS src, v.id AS vid, NULL AS peer_id, v.title, v.description, v.duration, v.width, v.height, v.views,
  v.created_at, v.thumb_path AS thumb, v.edit_version AS ver, v.user_id, u.username AS u_username, u.display_name AS u_display,
  u.avatar AS u_avatar, NULL AS u_avatar_url, NULL AS thumb_url, NULL AS video_url, NULL AS watch_url, NULL AS uploader_url,
  NULL AS peer_name, NULL AS peer_url, '' AS tags, (SELECT COALESCE(SUM(value), 0) FROM likes l WHERE l.video_id = v.id) AS score,
  v.game_id AS game_id, (SELECT name FROM games WHERE id = v.game_id) AS game_name, ${COMMUNITY_COLS}, NULL AS origin`;
export const REMOTE_LIST_COLS = `'remote' AS src, r.remote_id AS vid, r.instance_id AS peer_id, r.title, r.description, r.duration, r.width,
  r.height, r.views, r.created_at, NULL AS thumb, 0 AS ver, NULL AS user_id, r.uploader_username AS u_username,
  r.uploader_display_name AS u_display, NULL AS u_avatar, r.uploader_avatar_url AS u_avatar_url, r.thumbnail_url AS thumb_url,
  r.video_url, r.watch_url, r.uploader_url, p.name AS peer_name, p.url AS peer_url, r.tags, r.likes AS score,
  r.game_slug AS game_id, r.game_name AS game_name, NULL AS c_title, NULL AS c_thumb, r.origin_type AS origin`;

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
      game: r.game_id ? { id: r.game_id, name: r.game_name || r.game_id } : null,
      community: community(r),
      uploader: { id: r.user_id, username: r.u_username, display_name: r.u_display, avatar_url: r.u_avatar ? `/media/avatars/${r.u_avatar}` : null },
    };
  }
  return serializeRemote({
    game_slug: r.game_id, game_name: r.game_name,
    instance_id: r.peer_id, remote_id: r.vid, title: r.title, description: r.description, duration: r.duration, width: r.width,
    height: r.height, views: r.views, likes: r.score, created_at: r.created_at, tags: r.tags, thumbnail_url: r.thumb_url,
    video_url: r.video_url, watch_url: r.watch_url, uploader_username: r.u_username, uploader_display_name: r.u_display,
    uploader_avatar_url: r.u_avatar_url, uploader_url: r.uploader_url, peer_name: r.peer_name, peer_url: r.peer_url, origin_type: r.origin,
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
  const game = req.query.game ? findGame(req.query.game) || { id: String(req.query.game), aliases: '' } : null;
  // Vertical clips (taller than wide) get their own tab; the main feed can leave them out.
  const shape = req.query.shape === 'vertical' ? '>' : req.query.shape === 'landscape' ? '<=' : null;
  const limit = clampInt(req.query.limit, 1, 100, 24);
  const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
  let scope = ['local', 'network', 'all'].includes(req.query.scope) ? req.query.scope : 'local';
  if (!networkActive() || user) scope = 'local';
  const peer = req.query.peer ? Number(req.query.peer) : null;

  const parts = [];
  const params = [];

  if (scope !== 'network') {
    const where = ["v.status = 'ready'", "v.visibility = 'public'", 'v.moderation_status IS NULL'];
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
    if (game) {
      where.push('v.game_id = ?');
      params.push(game.id);
    }
    if (shape) where.push(`v.height ${shape} v.width`);
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
    if (game) {
      const w = networkGameWhere(gameSlugs(game));
      where.push(w.sql);
      params.push(...w.params);
    }
    if (shape) where.push(`r.height ${shape} r.width`);
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
      "SELECT t.tag, COUNT(*) AS n FROM tags t JOIN videos v ON v.id = t.video_id WHERE v.status = 'ready' AND v.visibility = 'public' AND v.moderation_status IS NULL GROUP BY t.tag ORDER BY n DESC, t.tag ASC LIMIT 30",
    )
    .all();
  res.json({ tags: rows.map((r) => ({ tag: r.tag, count: r.n })) });
});

// ---- upload -----------------------------------------------------------------

/** Bytes a user's videos use, and their quota (0 = unlimited). */
export function storageFor(userId) {
  const used = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM videos WHERE user_id = ?').get(userId).n;
  const u = db.prepare('SELECT quota_bytes FROM users WHERE id = ?').get(userId);
  const quota = u?.quota_bytes ?? (Number(getSettings().default_quota_mb) || 0) * 1024 * 1024;
  return { used, quota };
}

const overQuota = (used, quota) => {
  const mb = (n) => `${Math.round(n / 1048576).toLocaleString()} MB`;
  return new HttpError(413, `This upload would go over your storage quota (${mb(used)} of ${mb(quota)} used). Delete some videos or ask an admin for more space.`);
};

// Videos can also go up in pieces (/api/uploads); unfinished ones count against the quota already.
defineUploadKind('video', {
  label: 'Video',
  extensions: VIDEO_EXTENSIONS,
  maxBytes: () => (Number(getSettings().max_upload_mb) || 8192) * 1048576,
  check(user, size, pending) {
    checkServerSpace(size);
    const { used, quota } = storageFor(user.id);
    if (quota > 0 && used + pending + size > quota) throw overQuota(used + pending, quota);
  },
});

videosRouter.post('/', requireAuth, videoUpload, (req, res) => {
  // The file came with this request, or went up in pieces before it (upload_id).
  const pieces = !req.file && req.body?.upload_id ? finishedUpload(req.body.upload_id, req.user, 'video') : null;
  const file = req.file || pieces;
  if (!file) throw new HttpError(400, 'No video file was received');
  // A refused request throws away a file that came with it; one sent in pieces stays for another try.
  const refuse = (e) => {
    discard(req.file);
    return e;
  };
  try {
    checkServerSpace(req.file ? file.size : 0); // pieces were counted as they arrived
  } catch (e) {
    throw refuse(e);
  }
  const { used, quota } = storageFor(req.user.id);
  if (quota > 0 && used + file.size > quota) throw refuse(overQuota(used, quota));
  let gameId = null;
  try {
    gameId = resolveGame(req.body.game, req.user) ?? null;
  } catch (e) {
    throw refuse(e);
  }
  const id = newId();
  const ext = path.extname(file.originalname).toLowerCase();
  const originalName = `${id}${ext}`;
  fs.renameSync(file.path, path.join(DIRS.originals, originalName));
  pieces?.done();

  const fallbackTitle = path.basename(file.originalname, ext).replace(/_+/g, ' ').trim().slice(0, 120);
  const title = str(req.body.title, 120).trim() || fallbackTitle || 'Untitled video';
  // With an API key, the key's defaults fill in what the request leaves out.
  const key = req.apiKey;
  const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : key?.visibility || 'public';
  const t = now();
  const allowClips = req.body.allow_clips === 'true' || req.body.allow_clips === true ? 1 : 0;
  // The upload page sends drafts: nothing is published until its details are saved.
  const draft = req.body.draft !== undefined ? (req.body.draft === 'true' || req.body.draft === true ? 1 : 0) : key && !key.publish ? 1 : 0;

  db.prepare(
    "INSERT INTO videos (id, user_id, title, description, visibility, status, original_name, original_path, size_bytes, created_at, updated_at, game_id, allow_clips, draft, draft_visibility) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id, req.user.id, title, str(req.body.description), draft ? 'private' : visibility, file.originalname.slice(0, 255), originalName, file.size, t, t, gameId, allowClips,
    draft, draft ? visibility : null,
  );
  setTags(id, parseTags(req.body.tags));
  indexVideo(id);
  enqueue(id);
  // `url` is the watch page, for uploaders that copy a link when they're done (ShareX: {json:url}).
  res.status(201).json({ video: fullVideo(id, req.user), url: `${apBase(req) || `${req.protocol}://${req.get('host')}`}/watch/${id}` });
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
      )} WHERE v.status = 'ready' AND v.visibility = 'public' AND v.moderation_status IS NULL AND v.id != ? ORDER BY shared_tags DESC, same_user DESC, v.created_at DESC LIMIT 20`,
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
  // A draft stays private until it is saved with `publish`; until then the choice is kept for later.
  const publishing = !!v.draft && b.publish === true;
  const wanted = b.visibility !== undefined ? b.visibility : v.draft ? v.draft_visibility || 'public' : v.visibility;
  if (!VISIBILITIES.includes(wanted)) throw new HttpError(400, 'Visibility must be public, unlisted or private');
  const visibility = v.draft && !publishing ? 'private' : wanted;
  const federate = b.federate !== undefined ? (b.federate ? 1 : 0) : v.federate;
  const commentMode = b.comment_mode !== undefined ? b.comment_mode : v.comment_mode || 'inherit';
  if (!['inherit', 'open', 'hold_all', 'off'].includes(commentMode)) throw new HttpError(400, 'Comment mode must be inherit, open, hold_all or off');
  const game = resolveGame(b.game, req.user);
  const gameId = game === undefined ? v.game_id : game;
  const allowClips = b.allow_clips !== undefined ? (b.allow_clips ? 1 : 0) : v.allow_clips || 0;
  const allowOriginal = b.allow_original_download !== undefined ? (b.allow_original_download ? 1 : 0) : v.allow_original_download || 0;
  const t = now();
  db.prepare(
    `UPDATE videos SET title = ?, description = ?, visibility = ?, federate = ?, comment_mode = ?, game_id = ?, allow_clips = ?, allow_original_download = ?, updated_at = ?,
       draft = ?, draft_visibility = ?, published_at = CASE WHEN ? THEN (CASE WHEN status = 'ready' THEN ? ELSE NULL END) ELSE published_at END WHERE id = ?`,
  ).run(
    title, description, visibility, federate, commentMode, gameId, allowClips, allowOriginal, t,
    v.draft && !publishing ? 1 : 0, v.draft && !publishing ? wanted : null, publishing ? 1 : 0, t, v.id,
  );
  if (visibility === 'public') maybeNotifyUpload(v.id);
  apVideoChanged(v.id);
  if (b.tags !== undefined) setTags(v.id, parseTags(b.tags));
  indexVideo(v.id);
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
  sendVideoDelete({ id: v.id, user_id: v.user_id, username: v.username, ap_published_at: v.ap_published_at });
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
  queueRenditions(v.id);
  apVideoChanged(v.id);
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

/** Whether to record watch history for this request (not in anonymous mode, not while paused). */
function recordsHistory(req) {
  if (!req.user || req.body?.anonymous === true) return false;
  return !db.prepare('SELECT history_paused FROM users WHERE id = ?').get(req.user.id)?.history_paused;
}

videosRouter.post('/:id/view', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const anonymous = req.body?.anonymous === true;
  const key = req.user && !anonymous ? `u:${req.user.id}` : `a:${sha256(`${req.ip || ''}|${req.get('user-agent') || ''}`)}`;
  const t = now();
  const prev = db.prepare('SELECT viewed_at FROM views WHERE video_id = ? AND viewer_key = ?').get(v.id, key);
  if (!prev || t - prev.viewed_at > 6 * 3600 * 1000) {
    db.prepare('INSERT INTO views (video_id, viewer_key, viewed_at) VALUES (?, ?, ?) ON CONFLICT(video_id, viewer_key) DO UPDATE SET viewed_at = excluded.viewed_at').run(v.id, key, t);
    db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(v.id);
    let selfHost = req.get('host') || '';
    try {
      if (getSettings().public_url) selfHost = new URL(getSettings().public_url).hostname;
    } catch {}
    recordView(v.id, viewSource({ from: req.body?.from, ref: req.body?.ref }, selfHost.replace(/:\d+$/, '')));
  }
  if (recordsHistory(req)) {
    db.prepare(
      'INSERT INTO history (user_id, video_id, watched_at, position) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, video_id) DO UPDATE SET watched_at = excluded.watched_at',
    ).run(req.user.id, v.id, t);
  }
  res.json({ views: db.prepare('SELECT views FROM videos WHERE id = ?').get(v.id).views });
});

// Playback report for analytics (watch time and retention), sent by the player as a beacon.
videosRouter.post('/:id/watch', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  recordWatch(v, req.body, req.ip || '');
  res.status(204).end();
});

videosRouter.post('/:id/progress', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const pos = Number(req.body?.position);
  if (!Number.isFinite(pos) || pos < 0) throw new HttpError(400, 'Bad position');
  if (!recordsHistory(req)) return res.json({ ok: true, recorded: false });
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
  const hide = getSettings().show_dislikes !== 'true' && !canEdit(v, req.user);
  res.json({ likes: lk.likes, dislikes: hide ? null : lk.dislikes, my_like: value });
});

// ---- comments ---------------------------------------------------------------

const COMMENT_SELECT =
  'SELECT c.*, u.username, u.display_name, u.avatar, u.remote_instance_id, u.remote_avatar_url, u.remote_profile_url, u.ap_actor AS author_ap_actor FROM comments c JOIN users u ON u.id = c.user_id';

const canModerateComments = (v, viewer) => !!viewer && (viewer.id === v.user_id || viewer.is_moderator);

function serializeComment(c, viewer, v) {
  const mine = !!viewer && viewer.id === c.user_id;
  const mod = canModerateComments(v, viewer);
  const pub = publicComment(c, v.user_id, v.pinned_comment_id);
  // Verified linked accounts of the uploader (see links.js) count as the uploader.
  const linked = !pub.is_uploader && !!c.remote_instance_id && isLinkedCommenter(v.user_id, { ap_actor: c.author_ap_actor, remote_profile_url: c.remote_profile_url });
  return {
    ...pub,
    is_uploader: pub.is_uploader || linked,
    linked_uploader: linked,
    held_reason: c.status === 'held' && (mine || mod) ? c.held_reason || null : null,
    can_delete: mine || mod,
    can_moderate: mod,
    can_pin: !!viewer && viewer.id === v.user_id,
  };
}

videosRouter.get('/:id/comments', (req, res) => {
  const v = getViewable(req.params.id, req.user);
  // Held comments show only to their author, the uploader and moderators.
  const rows = db
    .prepare(`${COMMENT_SELECT} WHERE c.video_id = ? AND (c.status = 'visible' OR c.user_id = ? OR ?) ORDER BY c.created_at ASC`)
    .all(v.id, req.user?.id || '', canModerateComments(v, req.user) ? 1 : 0);
  const owner = db.prepare('SELECT comment_mode FROM users WHERE id = ?').get(v.user_id);
  const comments = rows.map((c) => serializeComment(c, req.user, v));
  // The pinned comment always comes first.
  const pin = comments.findIndex((c) => c.id === v.pinned_comment_id);
  if (pin > 0) comments.unshift(...comments.splice(pin, 1));
  res.json({
    comments,
    comment_mode: effectiveCommentMode(v, owner),
    // Lets other instances know whether their people can comment here.
    network_accepts: networkActive() ? acceptsFromNetwork() : null,
  });
});

/** Approve a held comment (uploader or moderator), pin or heart one (uploader). */
videosRouter.patch('/:id/comments/:cid', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const c = db.prepare('SELECT * FROM comments WHERE id = ? AND video_id = ?').get(String(req.params.cid), v.id);
  if (!c) throw new HttpError(404, 'Comment not found');
  const b = req.body || {};
  if (b.status !== undefined) {
    if (!canModerateComments(v, req.user)) throw new HttpError(403, 'Only the uploader and moderators can approve comments');
    if (b.status !== 'visible') throw new HttpError(400, 'Comments can only be approved; delete them to remove');
    db.prepare("UPDATE comments SET status = 'visible', held_reason = NULL WHERE id = ?").run(c.id);
    notifyComment(c.id);
    apCommentCreated(c.id);
    if (c.status === 'held') apCommentVerdict(c, true).catch(() => {}); // an OurTube peer is waiting to hear
    if (req.user.id !== v.user_id) logAction(req.user, 'comment.approve', { targetType: 'comment', targetId: c.id, targetLabel: c.body.slice(0, 120) });
  }
  if (b.pinned !== undefined || b.hearted !== undefined) {
    if (req.user.id !== v.user_id) throw new HttpError(403, 'Only the uploader can pin or heart comments');
    if (b.pinned !== undefined) db.prepare('UPDATE videos SET pinned_comment_id = ? WHERE id = ?').run(b.pinned ? c.id : null, v.id);
    if (b.hearted !== undefined) db.prepare('UPDATE comments SET hearted = ? WHERE id = ?').run(b.hearted ? 1 : 0, c.id);
  }
  const fresh = loadVideo(v.id);
  res.json({ comment: serializeComment(db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(c.id), req.user, fresh) });
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
  db.prepare('INSERT INTO comments (id, video_id, user_id, parent_id, body, status, held_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, v.id, req.user.id, parentId, body, verdict.status, verdict.status === 'held' ? verdict.reason : null, now(),
  );
  const c = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id);
  if (verdict.status === 'visible') {
    notifyComment(id);
    apCommentCreated(id);
  }
  res.status(201).json({ comment: serializeComment(c, req.user, v), held: verdict.status === 'held', held_reason: verdict.status === 'held' ? verdict.reason : null });
});

videosRouter.delete('/:id/comments/:cid', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const c = db.prepare('SELECT * FROM comments WHERE id = ? AND video_id = ?').get(String(req.params.cid), v.id);
  if (!c) throw new HttpError(404, 'Comment not found');
  if (!(req.user.id === c.user_id || req.user.is_moderator || req.user.id === v.user_id)) throw new HttpError(403, 'You cannot delete that comment');
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  const author = db.prepare('SELECT username, remote_instance_id FROM users WHERE id = ?').get(c.user_id);
  if (author && !author.remote_instance_id) sendCommentDelete(c, author.username, v.user_id);
  // Deleting a held comment from an OurTube peer is the answer to it.
  if (c.status === 'held' && c.ap_id) apCommentVerdict(c, false, 'Not approved').catch(() => {});
  if (req.user.is_moderator && req.user.id !== c.user_id && req.user.id !== v.user_id) {
    logAction(req.user, 'comment.delete', { targetType: 'comment', targetId: c.id, targetLabel: c.body.slice(0, 120) });
  }
  res.json({ ok: true });
});

/** Uploader's response to a copyright removal. */
videosRouter.post('/:id/counter-notice', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  const statement = str(req.body?.statement, 5000).trim();
  if (v.user_id !== req.user.id) throw new HttpError(403, 'Only the uploader can respond');
  // A counter-notice for copyright removals, an appeal for anything else the moderators did.
  if (!v.moderation_status) throw new HttpError(400, 'This video has not been hidden or removed');
  if (statement.length < 20) throw new HttpError(400, 'Explain why the removal was a mistake (at least a sentence)');
  if (db.prepare("SELECT 1 FROM counter_notices WHERE video_id = ? AND status = 'pending'").get(v.id)) throw new HttpError(409, 'A counter-notice for this video is already waiting');
  const notice = db.prepare('SELECT id FROM takedown_notices WHERE video_id = ? ORDER BY received_at DESC LIMIT 1').get(v.id);
  db.prepare('INSERT INTO counter_notices (id, notice_id, video_id, user_id, statement, contact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    newId(), notice?.id || null, v.id, req.user.id, statement, str(req.body?.contact, 300), now(),
  );
  if (notice) db.prepare("UPDATE takedown_notices SET status = 'countered' WHERE id = ?").run(notice.id);
  logAction(req.user, 'counter_notice.submit', { targetType: 'video', targetId: v.id, targetLabel: v.title });
  res.status(201).json({ ok: true });
});

/** The uploader's view of their own video's moderation (reason, counter-notice state). */
videosRouter.get('/:id/moderation', requireAuth, (req, res) => {
  const v = getViewable(req.params.id, req.user);
  if (v.user_id !== req.user.id && !req.user.is_moderator) throw new HttpError(403, 'Not your video');
  res.json({
    status: v.moderation_status || null,
    reason: v.moderation_reason || null,
    moderated_at: v.moderated_at || null,
    counter_notice: db.prepare('SELECT status, created_at, decided_at FROM counter_notices WHERE video_id = ? ORDER BY created_at DESC LIMIT 1').get(v.id) || null,
  });
});

export { touchVideo };
