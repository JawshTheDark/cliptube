/**
 * ClipTube's own API for the fediverse: people follow fediverse channels by handle, admins follow whole
 * servers (PeerTube-style mirroring) and switch ActivityPub on or off, and the remote-video pages get
 * comments, likes and subscriptions for videos that came from the fediverse.
 */
import { Router } from 'express';
import { db, getSettings, setSetting } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { HttpError, newId, now, str } from '../util.js';
import { CONTEXT, PUBLIC, apBase, apEnabled, hostOf, htmlToText, idOf, originOf, textToHtml, urls } from './common.js';
import { apFetch } from './http.js';
import { getActor, resolveActor, signer } from './actors.js';
import { followersOf, sendFollow, sendTo, sendUnfollow } from './deliver.js';
import { isNetworkPeer, networkPolicy } from '../network.js';
import { forgetThread, remoteThread } from './peering.js';

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

// ---- the remote video pages: videos from the fediverse and from ClipTube peers on protocol 4 ----------------
// (mounted before the ClipTube network routes, which still serve videos from peers on protocol v3)

export const apNetworkRouter = Router();

function apVideo(req) {
  const row = db
    .prepare(
      "SELECT r.*, p.url AS peer_url, p.name AS peer_name, p.blocked FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ? AND r.origin_type = 'activitypub'",
    )
    .get(Number(req.params.iid), String(req.params.rid));
  return row && !row.blocked ? row : null;
}

const instOf = (instanceId) => db.prepare('SELECT * FROM instances WHERE id = ?').get(Number(instanceId));
/** A ClipTube peer on protocol 4: answers each comment, and serves its whole thread. */
const clipTubePeer = (inst) => !!inst?.ap_actor && (inst.protocol || 0) >= 4;

/** The ClipTube network's switches cover ClipTube peers; other servers only answer to their own settings. */
function allowedHere(instanceId, kind) {
  const inst = instOf(instanceId);
  if (inst && isNetworkPeer(inst) && !networkPolicy()[kind]) throw new HttpError(403, `The network has turned off ${kind} between instances`);
}

// Comments from a remote thread get ids that carry the note's own id, so replies and deletes can find it.
const noteKey = (apId) => `n-${Buffer.from(String(apId)).toString('base64url')}`;
function fromNoteKey(id) {
  if (!/^n-[A-Za-z0-9_-]+$/.test(String(id))) return null;
  try {
    const s = Buffer.from(String(id).slice(2), 'base64url').toString('utf8');
    return /^https?:\/\//.test(s) ? s : null;
  } catch {
    return null;
  }
}

const commentShape = (c, me) => {
  const u = db.prepare('SELECT username, display_name, avatar, remote_instance_id, remote_avatar_url, remote_profile_url FROM users WHERE id = ?').get(c.user_id) || {};
  const remote = !!u.remote_instance_id;
  const mine = !!me && me.id === c.user_id;
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
    // pending: sent, waiting for the video's server to show it; rejected: it refused (reason alongside).
    status: c.status || 'visible',
    status_reason: mine ? c.status_reason || null : null,
    can_delete: !!me && (mine || me.is_moderator),
  };
};

/** A note from a ClipTube peer's thread, in the shape of the comments API. */
function threadComment(n, v, me, mine, inThread, base) {
  const a = n.attributedTo && typeof n.attributedTo === 'object' ? n.attributedTo : { id: idOf(n.attributedTo) };
  const actorId = idOf(a.id) || '';
  const own = mine.get(n.id);
  // People from here who commented over there show up as themselves.
  const localName = base && actorId.startsWith(`${base}/ap/users/`) ? decodeURIComponent(actorId.slice(`${base}/ap/users/`.length)) : null;
  const local = localName ? db.prepare('SELECT username, display_name, avatar FROM users WHERE username = ? AND remote_instance_id IS NULL').get(localName) : null;
  const host = a.host || hostOf(actorId) || hostOf(v.ap_id);
  const icon = a.icon && typeof a.icon === 'object' ? idOf(a.icon.url) : idOf(a.icon);
  const parent = idOf(n.inReplyTo);
  const parentId = !parent || parent === v.ap_id ? null : mine.has(parent) ? mine.get(parent).id : inThread.has(parent) ? noteKey(parent) : null;
  return {
    id: own ? own.id : noteKey(n.id),
    parent_id: parentId,
    body: str(htmlToText(n.content || ''), 2000),
    created_at: Date.parse(n.published) || 0,
    author: local
      ? { username: local.username, display_name: local.display_name, avatar_url: local.avatar ? `/media/avatars/${local.avatar}` : null, profile_url: null, remote: false }
      : { username: `${a.preferredUsername || 'someone'}@${host}`, display_name: a.name || a.preferredUsername || 'someone', avatar_url: icon || null, profile_url: idOf(a.url) || actorId || null, remote: true },
    is_uploader: !!n.isUploader,
    hearted: !!n.hearted,
    pinned: !!n.pinned,
    status: 'visible',
    can_delete: !!own && !!me && (me.id === own.user_id || me.is_moderator),
  };
}

apNetworkRouter.get('/videos/:iid/:rid/comments', async (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  const inst = instOf(v.instance_id);
  const origin = hostOf(v.peer_url);
  const canPost = !!v.comments_enabled && apEnabled() && (!isNetworkPeer(inst) || networkPolicy().comments);
  const rows = db.prepare('SELECT * FROM network_comments WHERE instance_id = ? AND remote_id = ? ORDER BY created_at').all(v.instance_id, v.remote_id);
  const mine = new Map(rows.filter((c) => c.ap_id).map((c) => [c.ap_id, c]));
  // A ClipTube peer serves the whole thread; elsewhere, show the comments that were delivered here.
  const thread = clipTubePeer(inst) ? await remoteThread(v) : null;
  if (thread) {
    const inThread = new Set(thread.map((n) => n.id));
    const comments = thread.map((n) => threadComment(n, v, req.user, mine, inThread, apBase()));
    for (const c of rows) {
      if (inThread.has(c.ap_id)) {
        if (c.status !== 'visible') db.prepare("UPDATE network_comments SET status = 'visible', status_reason = NULL WHERE id = ?").run(c.id); // its Accept went missing
        continue;
      }
      if (c.status !== 'visible' && req.user?.id === c.user_id) comments.push(commentShape(c, req.user));
    }
    return res.json({ comments, can_post: canPost, origin, host_name: v.peer_name || origin });
  }
  const shown = rows.filter((c) => c.status === 'visible' || c.user_id === req.user?.id);
  res.json({ comments: shown.map((c) => commentShape(c, req.user)), can_post: canPost, origin, host_name: v.peer_name || origin });
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
  allowedHere(v.instance_id, 'comments');
  if (!v.comments_enabled) throw new HttpError(403, 'Comments are off on this video');
  const body = str(req.body?.body, 2000).trim();
  if (!body) throw new HttpError(400, 'Comment cannot be empty');
  // The parent is one of ours (a stored note) or a note from the remote thread (an n- id).
  let parentApId = null;
  let parentKey = null;
  let parentAuthor = null;
  if (req.body?.parent_id) {
    const pid = String(req.body.parent_id);
    const local = db.prepare('SELECT * FROM network_comments WHERE id = ? AND instance_id = ? AND remote_id = ?').get(pid, v.instance_id, v.remote_id);
    if (local) {
      parentApId = local.ap_id;
      parentKey = local.parent_id || local.id;
      parentAuthor = db.prepare('SELECT ap_actor FROM users WHERE id = ?').get(local.user_id)?.ap_actor || null;
    } else {
      parentApId = fromNoteKey(pid);
      if (!parentApId) throw new HttpError(400, 'That comment no longer exists');
      parentKey = pid;
      const n = (await remoteThread(v).catch(() => null))?.find((x) => x.id === parentApId);
      parentAuthor = n ? idOf(n.attributedTo?.id || n.attributedTo) : null;
    }
  }
  const base = apBase();
  const id = newId();
  const apId = `${base}/ap/notes/${id}`;
  const t = now();
  const inst = instOf(v.instance_id);
  // ClipTube peers answer with Accept or Reject; until then it waits.
  const status = clipTubePeer(inst) ? 'pending' : 'visible';
  db.prepare('INSERT INTO network_comments (id, instance_id, remote_id, ap_id, in_reply_to, parent_id, user_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, v.instance_id, v.remote_id, apId, parentApId || v.ap_id, parentKey, req.user.id, body, status, t,
  );
  const audience = await videoAudience(v);
  if (parentAuthor && /^https?:\/\//.test(parentAuthor) && !parentAuthor.startsWith(`${base}/`)) audience.push(parentAuthor);
  const note = { id: apId, type: 'Note', attributedTo: urls(base).person(req.user.username), inReplyTo: parentApId || v.ap_id, content: textToHtml(body), published: new Date(t).toISOString(), to: [PUBLIC], cc: audience };
  sendTo(`u:${req.user.id}`, { type: 'Create', actor: note.attributedTo, to: note.to, cc: note.cc, object: note }, audience);
  forgetThread(v.ap_id);
  res.status(201).json({ comment: commentShape(db.prepare('SELECT * FROM network_comments WHERE id = ?').get(id), req.user), pending: status === 'pending', host_name: v.peer_name || hostOf(v.peer_url) });
});

apNetworkRouter.delete('/videos/:iid/:rid/comments/:cid', requireAuth, async (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  const cid = String(req.params.cid);
  let c = db.prepare('SELECT * FROM network_comments WHERE id = ? AND instance_id = ? AND remote_id = ?').get(cid, v.instance_id, v.remote_id);
  const noteId = c ? null : fromNoteKey(cid);
  if (!c && noteId) c = db.prepare('SELECT * FROM network_comments WHERE ap_id = ? AND instance_id = ? AND remote_id = ?').get(noteId, v.instance_id, v.remote_id);
  if (!c) throw new HttpError(404, 'Comment not found');
  if (c.user_id !== req.user.id && !req.user.is_moderator) throw new HttpError(403, 'You cannot delete that comment');
  db.prepare('DELETE FROM network_comments WHERE id = ?').run(c.id);
  if (c.user_id === req.user.id && apEnabled()) {
    sendTo(`u:${req.user.id}`, { type: 'Delete', actor: urls(apBase()).person(req.user.username), to: [PUBLIC], object: { id: c.ap_id, type: 'Tombstone' } }, await videoAudience(v));
  }
  forgetThread(v.ap_id);
  res.json({ ok: true });
});

apNetworkRouter.post('/videos/:iid/:rid/like', requireAuth, requireApOn, async (req, res, next) => {
  const v = apVideo(req);
  if (!v) return next();
  allowedHere(v.instance_id, 'likes');
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
  // The new count as it will be once the other server has it (it arrives within seconds).
  const likes = Math.max(0, v.likes + (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0));
  db.prepare('UPDATE network_videos SET likes = ? WHERE instance_id = ? AND remote_id = ?').run(likes, v.instance_id, v.remote_id);
  res.json({ likes, my_like: value });
});

/**
 * A fediverse channel's actor, for the remote channel links. On a ClipTube peer (protocol 4) a channel we
 * haven't seen yet is fetched from its usual address (name_channel is /ap/channels/name).
 */
async function apChannel(req) {
  const row = db.prepare('SELECT * FROM ap_actors WHERE instance_id = ? AND username = ? ORDER BY type = ? DESC LIMIT 1').get(Number(req.params.iid), String(req.params.username), 'Group');
  if (row) return row;
  const inst = instOf(req.params.iid);
  const m = /^([A-Za-z0-9_]{3,20})_channel$/.exec(String(req.params.username));
  if (!clipTubePeer(inst) || !m) return null;
  return getActor(`${originOf(inst.ap_actor)}/ap/channels/${m[1]}`).catch(() => null);
}

const followerCounts = new Map(); // followers url -> { at, n }
apNetworkRouter.get('/channels/:iid/:username', async (req, res, next) => {
  const a = await apChannel(req);
  if (!a) return next();
  let count = null;
  const hit = followerCounts.get(a.followers_url);
  if (hit && now() - hit.at < 60_000) count = hit.n;
  else if (a.followers_url) {
    try {
      const c = await apFetch(a.followers_url, { signer: signer(), timeout: 4000 });
      if (Number.isFinite(Number(c.totalItems))) {
        count = Number(c.totalItems);
        followerCounts.set(a.followers_url, { at: now(), n: count });
      }
    } catch {}
  }
  const subscribed = req.user ? !!db.prepare('SELECT 1 FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').get(req.user.id, a.instance_id, a.username) : false;
  res.json({ subscriber_count: count, subscribed });
});

apNetworkRouter.post('/channels/:iid/:username/subscribe', requireAuth, requireApOn, async (req, res, next) => {
  const a = await apChannel(req);
  if (!a) return next();
  allowedHere(a.instance_id, 'subscriptions');
  await sendFollow(`u:${req.user.id}`, a.id);
  db.prepare(
    'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(req.user.id, a.instance_id, a.username, a.name || a.username, a.icon_url, a.url || a.id, now());
  followerCounts.delete(a.followers_url);
  res.json({ subscribed: true });
});

apNetworkRouter.delete('/channels/:iid/:username/subscribe', requireAuth, async (req, res, next) => {
  const a = await apChannel(req);
  if (!a) return next();
  await sendUnfollow(`u:${req.user.id}`, a.id);
  db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(req.user.id, a.instance_id, a.username);
  followerCounts.delete(a.followers_url);
  res.json({ subscribed: false });
});

export { followersOf };
