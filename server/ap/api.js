/**
 * ClipTube's own API for the fediverse: people follow fediverse channels by handle, admins follow whole
 * servers (PeerTube-style mirroring) and switch ActivityPub on or off, and the remote-video pages get
 * comments, likes and subscriptions for videos that came from the fediverse.
 */
import { Router } from 'express';
import { db, getSettings, setSetting } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { HttpError, newId, now, str } from '../util.js';
import { CONTEXT, PUBLIC, apBase, apEnabled, hostOf, textToHtml, urls } from './common.js';
import { apFetch } from './http.js';
import { getActor, resolveActor, signer } from './actors.js';
import { followersOf, sendFollow, sendTo, sendUnfollow } from './deliver.js';

const actorSummary = (a, status = null) => ({
  id: a.id,
  type: a.type,
  handle: `@${a.username}@${a.domain}`,
  name: a.name || a.username,
  url: a.url || a.id,
  icon_url: a.icon_url,
  summary: a.summary,
  status,
});

function requireApOn(req, res, next) {
  if (!apEnabled()) throw new HttpError(400, 'ActivityPub is turned off on this site');
  if (!apBase()) throw new HttpError(400, "Set this site's Public URL first, so other servers can reach it");
  next();
}

// ---- people: follow fediverse channels and accounts -------------------------------------------------------

export const fediverseRouter = Router();
fediverseRouter.use(requireAuth);

fediverseRouter.get('/me', (req, res) => {
  const base = apBase(req);
  const host = hostOf(base);
  res.json({
    enabled: apEnabled(),
    handles: { account: `@${req.user.username}@${host}`, channel: `@${req.user.username}_channel@${host}` },
    followers: db.prepare('SELECT COUNT(*) AS n FROM ap_followers WHERE local_actor IN (?, ?)').get(`u:${req.user.id}`, `c:${req.user.id}`).n,
  });
});

fediverseRouter.get('/lookup', requireApOn, async (req, res) => {
  const a = await resolveActor(req.query.q);
  const f = db.prepare('SELECT status FROM ap_follows WHERE local_actor = ? AND remote_actor = ?').get(`u:${req.user.id}`, a.id);
  res.json({ actor: actorSummary(a, f?.status || null) });
});

fediverseRouter.get('/follows', (req, res) => {
  const rows = db
    .prepare('SELECT f.status, f.created_at, a.* FROM ap_follows f JOIN ap_actors a ON a.id = f.remote_actor WHERE f.local_actor = ? ORDER BY f.created_at DESC')
    .all(`u:${req.user.id}`);
  res.json({ follows: rows.map((r) => actorSummary(r, r.status)) });
});

fediverseRouter.post('/follow', requireApOn, async (req, res) => {
  const a = await resolveActor(req.body?.handle);
  if (a.domain === hostOf(apBase())) throw new HttpError(400, 'That is on this site; subscribe to it here instead');
  await sendFollow(`u:${req.user.id}`, a.id);
  // Shows up with the other subscriptions, and new uploads notify.
  db.prepare(
    'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(req.user.id, a.instance_id, a.username, a.name || a.username, a.icon_url, a.url || a.id, now());
  res.status(201).json({ actor: actorSummary(a, 'pending') });
});

fediverseRouter.delete('/follow', async (req, res) => {
  const id = String(req.body?.actor || '');
  const a = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(id);
  await sendUnfollow(`u:${req.user.id}`, id);
  if (a) db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(req.user.id, a.instance_id, a.username);
  res.json({ ok: true });
});

// ---- admins: the switch, and following whole servers -------------------------------------------------------

export const fediverseAdminRouter = Router();
fediverseAdminRouter.use(requireAdmin);

function adminState(req) {
  const base = apBase(req);
  return {
    enabled: apEnabled(),
    base,
    public_url_set: !!getSettings().public_url,
    instance_handle: `@${hostOf(base)}@${hostOf(base)}`,
    followers: {
      instance: db.prepare("SELECT COUNT(*) AS n FROM ap_followers WHERE local_actor = 'i'").get().n,
      channels: db.prepare("SELECT COUNT(*) AS n FROM ap_followers WHERE local_actor != 'i'").get().n,
    },
    servers: db
      .prepare("SELECT f.status, f.created_at, a.* FROM ap_follows f JOIN ap_actors a ON a.id = f.remote_actor WHERE f.local_actor = 'i' ORDER BY f.created_at DESC")
      .all()
      .map((r) => actorSummary(r, r.status)),
    videos: db.prepare("SELECT COUNT(*) AS n FROM network_videos WHERE origin_type = 'activitypub'").get().n,
  };
}

fediverseAdminRouter.get('/', (req, res) => res.json(adminState(req)));

fediverseAdminRouter.patch('/', (req, res) => {
  if (req.body?.enabled !== undefined) setSetting('activitypub_enabled', req.body.enabled ? 'true' : 'false');
  res.json(adminState(req));
});

/** Finds a server's instance actor from its address (NodeInfo, then the usual WebFinger names). */
async function serverActor(input) {
  const s = String(input || '').trim().replace(/\/+$/, '');
  if (/^@?[^@\s]+@[^@\s]+$/.test(s) || /\/(accounts|users|actor|video-channels)\b/.test(s)) return resolveActor(s);
  const origin = /^https?:\/\//.test(s) ? new URL(s).origin : `https://${s}`;
  const ni = await apFetch(`${origin}/.well-known/nodeinfo`, { accept: 'application/json' }).catch(() => null);
  const app = ni?.links?.find((l) => l.rel === 'https://www.w3.org/ns/activitystreams#Application')?.href;
  if (app) return getActor(app);
  const host = new URL(origin).host;
  for (const name of [host, 'peertube', 'actor', 'relay']) {
    try {
      return await resolveActor(`${name}@${host}`);
    } catch {}
  }
  throw new HttpError(404, `Could not find the server actor of ${host}`);
}

fediverseAdminRouter.post('/follow', requireApOn, async (req, res) => {
  const a = await serverActor(req.body?.server);
  await sendFollow('i', a.id);
  res.status(201).json(adminState(req));
});

fediverseAdminRouter.delete('/follow', async (req, res) => {
  await sendUnfollow('i', String(req.body?.actor || ''));
  res.json(adminState(req));
});

// ---- the remote video pages, for videos from the fediverse (mounted before the ClipTube network routes) ----

export const apNetworkRouter = Router();

function apVideo(req) {
  const row = db
    .prepare("SELECT r.*, p.url AS peer_url, p.blocked FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ? AND r.origin_type = 'activitypub'")
    .get(Number(req.params.iid), String(req.params.rid));
  return row && !row.blocked ? row : null;
}

const commentShape = (c, me) => {
  const u = db.prepare('SELECT username, display_name, avatar, remote_instance_id, remote_avatar_url, remote_profile_url FROM users WHERE id = ?').get(c.user_id) || {};
  const remote = !!u.remote_instance_id;
  return {
    id: c.id,
    parent_id: c.parent_id,
    body: c.body,
    created_at: c.created_at,
    author: {
      username: u.username || 'someone',
      display_name: u.display_name || u.username,
      avatar_url: remote ? u.remote_avatar_url : u.avatar ? `/media/avatars/${u.avatar}` : null,
      profile_url: remote ? u.remote_profile_url : null,
      remote,
    },
    is_uploader: false,
    hearted: false,
    pinned: false,
    status: 'visible',
    can_delete: !!me && (me.id === c.user_id || me.is_moderator),
  };
};

apNetworkRouter.get('/videos/:iid/:rid/comments', (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  const rows = db.prepare('SELECT * FROM network_comments WHERE instance_id = ? AND remote_id = ? ORDER BY created_at').all(v.instance_id, v.remote_id);
  res.json({ comments: rows.map((c) => commentShape(c, req.user)), can_post: !!v.comments_enabled && apEnabled(), origin: hostOf(v.peer_url) });
});

/** Who should hear about an interaction with this video: its channel and the channel's account. */
async function videoAudience(v) {
  const ids = [v.ap_actor];
  try {
    const ch = await getActor(v.ap_actor);
    if (ch.attributed_to) ids.push(ch.attributed_to);
  } catch {}
  return ids.filter(Boolean);
}

apNetworkRouter.post('/videos/:iid/:rid/comments', requireAuth, requireApOn, async (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  if (!v.comments_enabled) throw new HttpError(403, 'Comments are off on this video');
  const body = str(req.body?.body, 2000).trim();
  if (!body) throw new HttpError(400, 'Comment cannot be empty');
  let parent = null;
  if (req.body?.parent_id) {
    parent = db.prepare('SELECT * FROM network_comments WHERE id = ? AND instance_id = ? AND remote_id = ?').get(String(req.body.parent_id), v.instance_id, v.remote_id);
    if (!parent) throw new HttpError(400, 'That comment no longer exists');
  }
  const base = apBase();
  const id = newId();
  const apId = `${base}/ap/notes/${id}`;
  const t = now();
  db.prepare('INSERT INTO network_comments (id, instance_id, remote_id, ap_id, in_reply_to, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, v.instance_id, v.remote_id, apId, parent ? parent.ap_id : v.ap_id, parent ? parent.parent_id || parent.id : null, req.user.id, body, t,
  );
  const audience = await videoAudience(v);
  if (parent) {
    const pa = db.prepare('SELECT ap_actor FROM users WHERE id = ?').get(parent.user_id)?.ap_actor;
    if (pa) audience.push(pa);
  }
  const note = { id: apId, type: 'Note', attributedTo: urls(base).person(req.user.username), inReplyTo: parent ? parent.ap_id : v.ap_id, content: textToHtml(body), published: new Date(t).toISOString(), to: [PUBLIC], cc: audience };
  sendTo(`u:${req.user.id}`, { type: 'Create', actor: note.attributedTo, to: note.to, cc: note.cc, object: note }, audience);
  res.status(201).json({ comment: commentShape(db.prepare('SELECT * FROM network_comments WHERE id = ?').get(id), req.user) });
});

apNetworkRouter.delete('/videos/:iid/:rid/comments/:cid', requireAuth, async (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  const c = db.prepare('SELECT * FROM network_comments WHERE id = ? AND instance_id = ? AND remote_id = ?').get(String(req.params.cid), v.instance_id, v.remote_id);
  if (!c) throw new HttpError(404, 'Comment not found');
  if (c.user_id !== req.user.id && !req.user.is_moderator) throw new HttpError(403, 'You cannot delete that comment');
  db.prepare('DELETE FROM network_comments WHERE id = ?').run(c.id);
  if (c.user_id === req.user.id && apEnabled()) {
    sendTo(`u:${req.user.id}`, { type: 'Delete', actor: urls(apBase()).person(req.user.username), to: [PUBLIC], object: { id: c.ap_id, type: 'Tombstone' } }, await videoAudience(v));
  }
  res.json({ ok: true });
});

apNetworkRouter.post('/videos/:iid/:rid/like', requireAuth, requireApOn, async (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  const value = Number(req.body?.value);
  if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value must be 1, -1 or 0');
  const prev = db.prepare('SELECT value FROM network_likes WHERE user_id = ? AND instance_id = ? AND remote_id = ?').get(req.user.id, v.instance_id, v.remote_id)?.value || 0;
  const base = apBase();
  const me = urls(base).person(req.user.username);
  const audience = await videoAudience(v);
  const likeId = (val) => `${me}/likes/${encodeURIComponent(v.remote_id)}/${val === 1 ? 'like' : 'dislike'}`;
  if (prev && prev !== value) sendTo(`u:${req.user.id}`, { type: 'Undo', actor: me, object: { id: likeId(prev), type: prev === 1 ? 'Like' : 'Dislike', actor: me, object: v.ap_id } }, audience);
  if (value && value !== prev) sendTo(`u:${req.user.id}`, { type: value === 1 ? 'Like' : 'Dislike', actor: me, object: v.ap_id, id: likeId(value) }, audience);
  if (value === 0) db.prepare('DELETE FROM network_likes WHERE user_id = ? AND instance_id = ? AND remote_id = ?').run(req.user.id, v.instance_id, v.remote_id);
  else {
    db.prepare(
      'INSERT INTO network_likes (user_id, instance_id, remote_id, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, instance_id, remote_id) DO UPDATE SET value = excluded.value',
    ).run(req.user.id, v.instance_id, v.remote_id, value, now());
  }
  const likes = db.prepare('SELECT likes FROM network_videos WHERE instance_id = ? AND remote_id = ?').get(v.instance_id, v.remote_id).likes;
  res.json({ likes: likes + (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0), my_like: value });
});

/** A fediverse channel's page data, for the remote channel links. */
function apChannel(req) {
  return db.prepare('SELECT * FROM ap_actors WHERE instance_id = ? AND username = ? ORDER BY type = ? DESC LIMIT 1').get(Number(req.params.iid), String(req.params.username), 'Group');
}

apNetworkRouter.post('/channels/:iid/:username/subscribe', requireAuth, requireApOn, async (req, res, next) => {
  const a = apChannel(req);
  if (!a) return next();
  await sendFollow(`u:${req.user.id}`, a.id);
  db.prepare(
    'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(req.user.id, a.instance_id, a.username, a.name || a.username, a.icon_url, a.url || a.id, now());
  res.json({ subscribed: true });
});

apNetworkRouter.delete('/channels/:iid/:username/subscribe', requireAuth, async (req, res, next) => {
  const a = apChannel(req);
  if (!a) return next();
  await sendUnfollow(`u:${req.user.id}`, a.id);
  db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(req.user.id, a.instance_id, a.username);
  res.json({ subscribed: false });
});

export { followersOf };
