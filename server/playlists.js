/**
 * Playlists: anyone signed in keeps lists of videos, from this site or from the rest of the network, in their
 * own order. Public ones show on the channel, unlisted ones open by their link, private ones only for their
 * owner. Every account also has a Watch later list, created when first needed. Watch parties keep their queue
 * as a playlist of their own (kind 'party'), which never shows in anyone's lists.
 *
 * Items point at a video here (video_id) or at one in the network index (instance_id, remote_id), with the
 * title and thumbnail as they were when added, so a list stays readable when a video goes away.
 * Mounted at /api/playlists, plus /api/users/:username/playlists for channel pages.
 */
import { Router } from 'express';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, newId, now, str } from './util.js';
import { LOCAL_LIST_COLS, REMOTE_LIST_COLS, mapListRow } from './routes/videos.js';
import { NETWORK_VISIBLE } from './network.js';

export const MAX_PLAYLISTS = 200;
export const MAX_ITEMS = 500;
const VISIBILITIES = ['public', 'unlisted', 'private'];

/** A video reference: 'v:<id>' for a video here, 'n:<instance id>:<remote id>' for one from the network. */
export function parseRef(ref) {
  const s = String(ref || '');
  let m = /^v:([A-Za-z0-9_-]{1,40})$/.exec(s);
  if (m) return { video_id: m[1], instance_id: null, remote_id: null };
  m = /^n:(\d{1,10}):([^\s]{1,300})$/.exec(s);
  if (m) return { video_id: null, instance_id: Number(m[1]), remote_id: m[2] };
  throw new HttpError(400, 'Unknown video');
}
export const refOf = (it) => (it.video_id ? `v:${it.video_id}` : `n:${it.instance_id}:${it.remote_id}`);

/** The video a reference points at, in list shape, or null when it is gone or not visible to `viewer`. */
export function resolveRef(ref, viewer = null) {
  if (ref.video_id) {
    const r = db
      .prepare(`SELECT ${LOCAL_LIST_COLS}, v.visibility AS vis, v.status AS st, v.moderation_status AS modstat FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?`)
      .get(ref.video_id);
    // Unlisted videos may be in a playlist (their owner shared the link); private ones only for their owner.
    const ok = r && r.st === 'ready' && !r.modstat && (r.vis !== 'private' || (viewer && viewer.id === r.user_id));
    return ok ? mapListRow(r) : null;
  }
  const r = db
    .prepare(`SELECT ${REMOTE_LIST_COLS} FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ? AND ${NETWORK_VISIBLE}`)
    .get(ref.instance_id, ref.remote_id);
  return r ? mapListRow(r) : null;
}

const watchUrl = (it) => (it.video_id ? `/watch/${it.video_id}` : `/n/${it.instance_id}/${encodeURIComponent(it.remote_id)}`);

function serializeItem(it, viewer) {
  const video = resolveRef(it, viewer);
  return {
    id: it.id,
    ref: refOf(it),
    url: watchUrl(it),
    available: !!video,
    title: video?.title || it.title || 'Video unavailable',
    thumbnail_url: video?.thumbnail_url || it.thumbnail_url || null,
    video,
    added_at: it.added_at,
  };
}

const itemsOf = (playlistId) => db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id').all(playlistId);

function summary(p, viewer) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n;
  const first = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id LIMIT 1').get(p.id);
  const owner = db.prepare('SELECT username, display_name, avatar FROM users WHERE id = ?').get(p.user_id);
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    visibility: p.visibility,
    kind: p.kind,
    item_count: n,
    thumbnail_url: first ? resolveRef(first, viewer)?.thumbnail_url || first.thumbnail_url || null : null,
    first_url: first ? watchUrl(first) : null,
    owner: owner ? { username: owner.username, display_name: owner.display_name, avatar_url: owner.avatar ? `/media/avatars/${owner.avatar}` : null } : null,
    is_owner: !!viewer && viewer.id === p.user_id,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/** The playlist with its items, as far as `viewer` may see it. */
export function playlistView(p, viewer) {
  return { ...summary(p, viewer), items: itemsOf(p.id).map((it) => serializeItem(it, viewer)) };
}

const canSee = (p, viewer) => p.kind !== 'party' && (p.visibility !== 'private' || (!!viewer && (viewer.id === p.user_id || viewer.is_admin)));

function playlistFor(req, { own = false } = {}) {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(String(req.params.id));
  if (!p || !canSee(p, req.user)) throw new HttpError(404, 'Playlist not found');
  if (own && (!req.user || req.user.id !== p.user_id)) throw new HttpError(403, 'Only its owner can change this playlist');
  return p;
}

/** Every account's Watch later list, made the first time it is needed. */
export function ensureWatchLater(userId) {
  const found = db.prepare("SELECT * FROM playlists WHERE user_id = ? AND kind = 'watch_later'").get(userId);
  if (found) return found;
  const id = newId();
  const t = now();
  db.prepare("INSERT INTO playlists (id, user_id, title, visibility, kind, created_at, updated_at) VALUES (?, ?, 'Watch later', 'private', 'watch_later', ?, ?)").run(id, userId, t, t);
  return db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
}

/** Creates a playlist. `kind` 'party' makes a watch party's queue. */
export function createPlaylist(userId, { title, description = '', visibility = 'public', kind = 'user' }) {
  const name = str(title, 100).trim();
  if (!name) throw new HttpError(400, 'Give the playlist a name');
  if (!VISIBILITIES.includes(visibility)) throw new HttpError(400, 'Visibility must be public, unlisted or private');
  if (kind === 'user' && db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE user_id = ? AND kind = 'user'").get(userId).n >= MAX_PLAYLISTS) {
    throw new HttpError(400, `You can have up to ${MAX_PLAYLISTS} playlists`);
  }
  const id = newId();
  const t = now();
  db.prepare('INSERT INTO playlists (id, user_id, title, description, visibility, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, userId, name, str(description, 2000), visibility, kind, t, t,
  );
  return db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
}

/**
 * Adds a video to the end of a playlist, if `viewer` can see it. Returns the new item, or the existing one
 * when the video is in the list already.
 */
export function addItem(p, ref, viewer) {
  const existing = ref.video_id
    ? db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND video_id = ?').get(p.id, ref.video_id)
    : db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? AND instance_id = ? AND remote_id = ?').get(p.id, ref.instance_id, ref.remote_id);
  if (existing) return existing;
  if (db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n >= MAX_ITEMS) {
    throw new HttpError(400, `A playlist holds up to ${MAX_ITEMS} videos`);
  }
  const video = resolveRef(ref, viewer);
  if (!video) throw new HttpError(404, 'That video is not available');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n;
  const t = now();
  const r = db
    .prepare('INSERT INTO playlist_items (playlist_id, position, video_id, instance_id, remote_id, title, thumbnail_url, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, pos, ref.video_id, ref.instance_id, ref.remote_id, str(video.title, 200), video.thumbnail_url || null, t, viewer?.id || null);
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(t, p.id);
  return db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(r.lastInsertRowid);
}

export function removeItem(p, itemId) {
  const r = db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(Number(itemId), p.id);
  if (!r.changes) throw new HttpError(404, 'That video is not in this playlist');
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), p.id);
}

/** Puts the items in the order given (all of them, each once). */
export function reorder(p, itemIds) {
  const current = itemsOf(p.id).map((it) => it.id);
  const want = Array.isArray(itemIds) ? itemIds.map(Number) : [];
  if (want.length !== current.length || new Set(want).size !== want.length || !want.every((id) => current.includes(id))) {
    throw new HttpError(400, 'The new order must list every video in the playlist once');
  }
  const set = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    want.forEach((id, i) => set.run(i + 1, id));
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), p.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- /api/playlists ----------------------------------------------------------------------------------------

export const playlistsRouter = Router();

// Your playlists, Watch later first. With ?has=<ref>, each says whether (and as which item) it holds that video.
playlistsRouter.get('/mine', requireAuth, (req, res) => {
  ensureWatchLater(req.user.id);
  let ref = null;
  if (req.query.has) ref = parseRef(req.query.has);
  const rows = db.prepare("SELECT * FROM playlists WHERE user_id = ? AND kind IN ('user', 'watch_later') ORDER BY kind = 'watch_later' DESC, updated_at DESC").all(req.user.id);
  const has = (p) => {
    if (!ref) return undefined;
    const it = ref.video_id
      ? db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND video_id = ?').get(p.id, ref.video_id)
      : db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? AND instance_id = ? AND remote_id = ?').get(p.id, ref.instance_id, ref.remote_id);
    return it ? it.id : null;
  };
  res.json({ playlists: rows.map((p) => ({ ...summary(p, req.user), contains: has(p) })) });
});

playlistsRouter.post('/', requireAuth, (req, res) => {
  const b = req.body || {};
  const p = createPlaylist(req.user.id, { title: b.title, description: b.description, visibility: b.visibility || 'public' });
  if (b.ref) addItem(p, parseRef(b.ref), req.user);
  res.status(201).json({ playlist: playlistView(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id), req.user) });
});

playlistsRouter.get('/:id', (req, res) => {
  res.json({ playlist: playlistView(playlistFor(req), req.user) });
});

playlistsRouter.patch('/:id', requireAuth, (req, res) => {
  const p = playlistFor(req, { own: true });
  const b = req.body || {};
  const title = b.title !== undefined && p.kind === 'user' ? str(b.title, 100).trim() : p.title;
  if (!title) throw new HttpError(400, 'Give the playlist a name');
  const visibility = b.visibility !== undefined && p.kind === 'user' ? b.visibility : p.visibility;
  if (!VISIBILITIES.includes(visibility)) throw new HttpError(400, 'Visibility must be public, unlisted or private');
  const description = b.description !== undefined ? str(b.description, 2000) : p.description;
  db.prepare('UPDATE playlists SET title = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?').run(title, description, visibility, now(), p.id);
  res.json({ playlist: playlistView(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id), req.user) });
});

playlistsRouter.delete('/:id', requireAuth, (req, res) => {
  const p = playlistFor(req, { own: true });
  if (p.kind === 'watch_later') throw new HttpError(400, 'Watch later can be emptied, but not deleted');
  db.prepare('DELETE FROM playlists WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

playlistsRouter.post('/:id/items', requireAuth, (req, res) => {
  const p = playlistFor(req, { own: true });
  const it = addItem(p, parseRef(req.body?.ref), req.user);
  res.status(201).json({ item: serializeItem(it, req.user), item_count: db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n });
});

playlistsRouter.delete('/:id/items/:itemId', requireAuth, (req, res) => {
  const p = playlistFor(req, { own: true });
  removeItem(p, req.params.itemId);
  res.json({ ok: true, item_count: db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(p.id).n });
});

playlistsRouter.put('/:id/order', requireAuth, (req, res) => {
  const p = playlistFor(req, { own: true });
  reorder(p, req.body?.item_ids);
  res.json({ playlist: playlistView(p, req.user) });
});

// ---- a channel's public playlists: /api/users/:username/playlists ------------------------------------------

export const channelPlaylistsRouter = Router();

channelPlaylistsRouter.get('/:username/playlists', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(String(req.params.username));
  if (!u) throw new HttpError(404, 'Channel not found');
  const own = !!req.user && req.user.id === u.id;
  const rows = db
    .prepare(`SELECT * FROM playlists WHERE user_id = ? AND kind = 'user' ${own ? '' : "AND visibility = 'public'"} ORDER BY updated_at DESC`)
    .all(u.id);
  res.json({ playlists: rows.map((p) => summary(p, req.user)).filter((p) => own || p.item_count > 0) });
});
