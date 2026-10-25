/**
 * ActivityPub endpoints: discovery (WebFinger, NodeInfo, host-meta), actors and their collections,
 * video and comment objects, inboxes, and content negotiation on /watch and /c pages, so pasting a
 * ClipTube link into Mastodon or PeerTube search finds the video or channel.
 */
import { Router } from 'express';
import { db, getSettings } from '../db.js';
import { VERSION } from '../config.js';
import { HttpError } from '../util.js';
import { AP_CONTENT_TYPE, CONTEXT, PUBLIC, apBase, apEnabled, hostOf, idOf, textToHtml, urls } from './common.js';
import { verifyRequest } from './http.js';
import { isBlockedActor, keyFor, setInstanceSigner } from './actors.js';
import { VIDEO_FEDERATED, collection, commentApId, groupJson, instanceJson, loadVideoForAp, noteJson, personJson, videoJson } from './objects.js';
import { receive } from './inbox.js';
import { signerFor } from './deliver.js';
import { isLinkedCommenter } from '../links.js';

// Fetches are signed by the instance actor (some servers only answer signed requests).
setInstanceSigner(() => (apBase() ? signerFor('i') : null));

const send = (res, obj) => res.type(AP_CONTENT_TYPE).set('Access-Control-Allow-Origin', '*').json(obj);
const wantsAp = (req) => /application\/(activity\+json|ld\+json)/.test(req.get('accept') || '');
// Fediverse software often lowercases handles: match exactly first, then ignoring case.
const localUser = (name) =>
  db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(String(name)) ||
  db.prepare('SELECT * FROM users WHERE lower(username) = lower(?) AND remote_instance_id IS NULL ORDER BY created_at LIMIT 1').get(String(name));

function requireAp(req, res, next) {
  if (!apEnabled()) throw new HttpError(404, 'Not found');
  next();
}

// ---- discovery ----------------------------------------------------------------------------------------

export const apWellKnownRouter = Router();

apWellKnownRouter.get('/.well-known/webfinger', requireAp, (req, res) => {
  const base = apBase(req);
  const host = hostOf(base);
  const resource = String(req.query.resource || '');
  const m = /^(?:acct:)?@?([^@]+)@(.+)$/.exec(resource) || [];
  let name = m[1];
  if (!m[2] && resource.startsWith(base)) {
    // Also answer for actor URLs.
    const u = /\/ap\/(users|channels)\/([A-Za-z0-9_]+)$/.exec(resource);
    if (u) name = u[1] === 'channels' ? `${u[2]}_channel` : u[2];
  } else if (String(m[2]).toLowerCase() !== host) throw new HttpError(404, 'Not found');
  // Answer with the canonical spelling, so servers that re-check the subject find the same account.
  let href = null;
  let canonical = name;
  let profile = `${base}/`;
  const person = name && name !== host ? localUser(name) : null;
  const owner = !person && /_channel$/i.test(name || '') ? localUser(name.replace(/_channel$/i, '')) : null;
  if (name && name.toLowerCase() === host) {
    href = urls(base).instance();
    canonical = host;
  } else if (person) {
    href = urls(base).person(person.username);
    canonical = person.username;
    profile = `${base}/c/${encodeURIComponent(person.username)}`;
  } else if (owner) {
    href = urls(base).group(owner.username);
    canonical = `${owner.username}_channel`;
    profile = `${base}/c/${encodeURIComponent(owner.username)}`;
  }
  if (!href) throw new HttpError(404, 'Not found');
  res.type('application/jrd+json').set('Access-Control-Allow-Origin', '*').json({
    subject: `acct:${canonical}@${host}`,
    aliases: [href, profile],
    links: [
      { rel: 'self', type: AP_CONTENT_TYPE, href },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: profile },
      // Lets people here follow fediverse accounts from those accounts' own pages.
      { rel: 'http://ostatus.org/schema/1.0/subscribe', template: `${base}/authorize_interaction?uri={uri}` },
    ],
  });
});

apWellKnownRouter.get('/.well-known/host-meta', requireAp, (req, res) => {
  const base = apBase(req);
  res.type('application/xrd+xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n  <Link rel="lrdd" template="${base}/.well-known/webfinger?resource={uri}"/>\n</XRD>\n`,
  );
});

apWellKnownRouter.get('/.well-known/nodeinfo', requireAp, (req, res) => {
  const base = apBase(req);
  res.json({
    links: [
      { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${base}/nodeinfo/2.0` },
      { rel: 'https://www.w3.org/ns/activitystreams#Application', href: urls(base).instance() },
    ],
  });
});

apWellKnownRouter.get(['/nodeinfo/2.0', '/nodeinfo/2.0.json'], requireAp, (req, res) => {
  const s = getSettings();
  const users = db.prepare("SELECT COUNT(*) AS n FROM users WHERE remote_instance_id IS NULL AND status = 'active'").get().n;
  const videos = db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${VIDEO_FEDERATED}`).get().n;
  res.type('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"').json({
    version: '2.0',
    software: { name: 'cliptube', version: VERSION },
    protocols: ['activitypub'],
    services: { inbound: [], outbound: ['atom1.0', 'rss2.0'] },
    openRegistrations: s.registration_mode === 'open',
    usage: { users: { total: users }, localPosts: videos },
    metadata: { nodeName: s.site_name, nodeDescription: s.instance_description || '' },
  });
});

// ---- actors, objects and collections (mounted at /ap) ----------------------------------------------------

export const apRouter = Router();
apRouter.use(requireAp);

const PAGE = 20;

function outbox(req, res, user) {
  const base = apBase(req);
  const id = `${base}${req.baseUrl}${req.path}`.replace(/\/$/, '');
  const where = user ? `${VIDEO_FEDERATED} AND v.user_id = ?` : VIDEO_FEDERATED;
  const args = user ? [user.id] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${where}`).get(...args).n;
  if (!req.query.page) return send(res, collection(id, total, { first: `${id}?page=1` }));
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = db.prepare(`SELECT v.id FROM videos v WHERE ${where} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`).all(...args, PAGE, (page - 1) * PAGE);
  const items = rows.map((r) => {
    const v = loadVideoForAp(r.id);
    const video = videoJson(v, base, { singleAuthor: singleAuthor(req) });
    delete video['@context'];
    // `updated` on the instance's Announces lets peers reconciling the outbox fetch only what changed.
    return user
      ? { id: `${video.id}/activity`, type: 'Create', actor: urls(base).person(v.username), to: video.to, cc: video.cc, published: video.published, object: video }
      : { id: `${video.id}/announce`, type: 'Announce', actor: urls(base).instance(), to: [PUBLIC], published: video.published, updated: video.updated, object: video.id };
  });
  send(res, {
    '@context': CONTEXT,
    id: `${id}?page=${page}`,
    type: 'OrderedCollectionPage',
    partOf: id,
    totalItems: total,
    orderedItems: items,
    ...(page * PAGE < total ? { next: `${id}?page=${page + 1}` } : {}),
  });
}

const followersCount = (key) => db.prepare('SELECT COUNT(*) AS n FROM ap_followers WHERE local_actor = ?').get(key).n;
const followingCount = (key) => db.prepare("SELECT COUNT(*) AS n FROM ap_follows WHERE local_actor = ? AND status = 'accepted'").get(key).n;

for (const [prefix, kind] of [['users', 'u'], ['channels', 'c']]) {
  apRouter.get(`/${prefix}/:name`, (req, res) => {
    const u = localUser(req.params.name);
    if (!u || u.status !== 'active') throw new HttpError(404, 'Not found');
    send(res, kind === 'u' ? personJson(u, apBase(req)) : groupJson(u, apBase(req)));
  });
  apRouter.get(`/${prefix}/:name/outbox`, (req, res) => {
    const u = localUser(req.params.name);
    if (!u) throw new HttpError(404, 'Not found');
    outbox(req, res, u);
  });
  apRouter.get(`/${prefix}/:name/followers`, (req, res) => {
    const u = localUser(req.params.name);
    if (!u) throw new HttpError(404, 'Not found');
    send(res, collection(`${apBase(req)}/ap/${prefix}/${u.username}/followers`, followersCount(`${kind}:${u.id}`)));
  });
  apRouter.get(`/${prefix}/:name/featured`, (req, res) => {
    const u = localUser(req.params.name);
    if (!u) throw new HttpError(404, 'Not found');
    send(res, collection(`${apBase(req)}/ap/${prefix}/${u.username}/featured`, 0, { orderedItems: [] }));
  });
  apRouter.get(`/${prefix}/:name/following`, (req, res) => {
    const u = localUser(req.params.name);
    if (!u) throw new HttpError(404, 'Not found');
    send(res, collection(`${apBase(req)}/ap/${prefix}/${u.username}/following`, followingCount(`${kind}:${u.id}`)));
  });
}

apRouter.get('/actor', (req, res) => send(res, instanceJson(apBase(req))));
apRouter.get('/actor/outbox', (req, res) => outbox(req, res, null));
apRouter.get('/actor/followers', (req, res) => send(res, collection(`${apBase(req)}/ap/actor/followers`, followersCount('i'))));
apRouter.get('/actor/following', (req, res) => send(res, collection(`${apBase(req)}/ap/actor/following`, followingCount('i'))));

function federatedVideo(id) {
  const v = db.prepare(`SELECT v.id FROM videos v WHERE v.id = ? AND ${VIDEO_FEDERATED}`).get(String(id));
  if (!v) throw new HttpError(404, 'Not found');
  return loadVideoForAp(v.id);
}

/** GoToSocial refuses objects with more than one attributedTo (PeerTube needs two). */
const singleAuthor = (req) => /gotosocial/i.test(req.get('user-agent') || '');

apRouter.get('/videos/:id', (req, res) => send(res, videoJson(federatedVideo(req.params.id), apBase(req), { singleAuthor: singleAuthor(req) })));

apRouter.get('/videos/:id/likes', (req, res) => {
  const v = federatedVideo(req.params.id);
  send(res, collection(`${apBase(req)}/ap/videos/${v.id}/likes`, v.like_count));
});
apRouter.get('/videos/:id/dislikes', (req, res) => {
  const v = federatedVideo(req.params.id);
  send(res, collection(`${apBase(req)}/ap/videos/${v.id}/dislikes`, v.dislike_count));
});
apRouter.get('/videos/:id/shares', (req, res) => {
  const v = federatedVideo(req.params.id);
  send(res, collection(`${apBase(req)}/ap/videos/${v.id}/shares`, v.ap_shares || 0));
});
apRouter.get('/videos/:id/comments', (req, res) => {
  const base = apBase(req);
  const v = federatedVideo(req.params.id);
  const rows = db.prepare("SELECT * FROM comments WHERE video_id = ? AND status = 'visible' ORDER BY created_at LIMIT 500").all(v.id);
  // ?embed=1 (what ClipTube instances ask for): the whole thread at once, with who wrote what.
  if (req.query.embed === '1') {
    send(res, collection(`${base}/ap/videos/${v.id}/comments`, rows.length, { orderedItems: rows.map((c) => embeddedNote(c, v, base)) }));
    return;
  }
  send(res, collection(`${base}/ap/videos/${v.id}/comments`, rows.length, { orderedItems: rows.map((c) => commentApId(c, base)) }));
});

/** A comment with its author's name and picture inline (attributedTo may be an embedded actor). */
function embeddedNote(c, v, base) {
  const note = noteJson(c, base);
  delete note['@context'];
  const a = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id) || {};
  const remote = !!a.remote_instance_id;
  const [name, host] = remote ? String(a.username || '').split('@') : [a.username, null];
  note.id = commentApId(c, base);
  note.attributedTo = {
    type: 'Person',
    id: remote ? a.ap_actor || a.remote_profile_url || note.attributedTo : note.attributedTo,
    preferredUsername: name || 'someone',
    name: a.display_name || name,
    url: remote ? a.remote_profile_url || null : `${base}/c/${a.username}`,
    icon: remote ? (a.remote_avatar_url ? { type: 'Image', url: a.remote_avatar_url } : undefined) : a.avatar ? { type: 'Image', url: `${base}/media/avatars/${a.avatar}` } : undefined,
    ...(remote && host ? { host } : {}),
  };
  note.hearted = !!c.hearted;
  note.pinned = v.pinned_comment_id === c.id;
  // Verified linked accounts of the uploader count as the uploader.
  note.isUploader = c.user_id === v.user_id || (remote && isLinkedCommenter(v.user_id, a));
  return note;
}

// Comments by people here on videos from the fediverse.
apRouter.get('/notes/:id', (req, res) => {
  const base = apBase(req);
  const c = db.prepare('SELECT n.*, u.username, u.remote_instance_id FROM network_comments n JOIN users u ON u.id = n.user_id WHERE n.id = ?').get(String(req.params.id));
  if (!c || c.remote_instance_id) throw new HttpError(404, 'Not found');
  send(res, {
    '@context': CONTEXT,
    id: `${base}/ap/notes/${c.id}`,
    type: 'Note',
    attributedTo: urls(base).person(c.username),
    inReplyTo: c.in_reply_to,
    content: textToHtml(c.body),
    published: new Date(c.created_at).toISOString(),
    to: [PUBLIC],
  });
});

apRouter.get('/comments/:id', (req, res) => {
  const c = db.prepare("SELECT * FROM comments WHERE id = ? AND status = 'visible' AND ap_id IS NULL").get(String(req.params.id));
  if (!c || !db.prepare(`SELECT 1 FROM videos v WHERE v.id = ? AND ${VIDEO_FEDERATED}`).get(c.video_id)) throw new HttpError(404, 'Not found');
  send(res, noteJson(c, apBase(req)));
});

// Every inbox works the same way: check the signature, then handle the activity in the background.
const hits = new Map();
async function inbox(req, res) {
  const activity = req.body;
  if (!activity || typeof activity !== 'object' || typeof activity.type !== 'string') throw new HttpError(400, 'Expected an activity');
  const actorId = idOf(activity.actor);
  if (!actorId) throw new HttpError(400, 'The activity has no actor');
  if (isBlockedActor(actorId)) throw new HttpError(403, 'This server is blocked here');
  const host = hostOf(actorId);
  const t = Date.now();
  const list = (hits.get(host) || []).filter((x) => t - x < 60_000);
  if (list.length > 300) throw new HttpError(429, 'Slow down');
  hits.set(host, [...list, t]);
  const signedBy = await verifyRequest(req, keyFor);
  if (signedBy !== actorId && hostOf(signedBy) !== host) throw new HttpError(401, 'Signed by a different actor');
  receive(activity, actorId);
  res.status(202).end();
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (!v.some((x) => t - x < 60_000)) hits.delete(k);
}, 60_000).unref();

apRouter.post(['/inbox', '/actor/inbox', '/users/:name/inbox', '/channels/:name/inbox'], inbox);

// ---- content negotiation on HTML pages ---------------------------------------------------------------------

/** /watch/<id> and /c/<name> answer with ActivityPub JSON when that's what the client asks for. */
export function apNegotiation(req, res, next) {
  if (!apEnabled() || !wantsAp(req)) return next();
  let m = /^\/watch\/([A-Za-z0-9_-]+)$/.exec(req.path);
  if (m) {
    const v = db.prepare(`SELECT v.id FROM videos v WHERE v.id = ? AND ${VIDEO_FEDERATED}`).get(m[1]);
    if (!v) return next();
    return send(res, videoJson(loadVideoForAp(v.id), apBase(req)));
  }
  m = /^\/c\/([A-Za-z0-9_]{3,20})$/.exec(req.path);
  if (m) {
    const u = localUser(m[1]);
    if (!u) return next();
    return send(res, personJson(u, apBase(req)));
  }
  next();
}
