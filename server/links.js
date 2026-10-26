/**
 * Linked accounts: one person's accounts on several sites, shown as one person.
 *
 * Each account lists the others. They go out in its alsoKnownAs, next to the old accounts from "Moving
 * here", and a link counts as verified only while the other account lists this one back, so nobody can
 * claim an account that isn't theirs. Any software that publishes alsoKnownAs can take part: another
 * OurTube, or a Mastodon account that adds this one as an alias.
 *
 * Verified links show on the channel page ("Also on"), give comments from the other accounts the uploader's
 * mark, let viewers subscribe to all of them at once, and can list the other channels' videos with this
 * one's. Adding or removing a link sends this account's new profile to the other one, so its server checks
 * its side at once; every link is also checked again twice a day. The owner's side is mounted at /api/me.
 */
import { Router } from 'express';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, now } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';
import { isNetworkPeer, networkPolicy } from './network.js';
import { CONTEXT, PUBLIC, apBase, apEnabled, hostOf, urls } from './ap/common.js';
import { apFetch } from './ap/http.js';
import { getActor, inboxesOf, isBlockedActor, resolveActor, signer, storeActor } from './ap/actors.js';
import { deliver, sendFollow } from './ap/deliver.js';
import { personJson } from './ap/objects.js';
import { sendActorUpdates } from './ap/move.js';

export const MAX_LINKS = 5;
const RECHECK_MS = 12 * 3600_000;

const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const handleOf = (a) => `@${a.username}@${a.domain}`;
const linkRow = (id) => db.prepare('SELECT * FROM account_links WHERE id = ?').get(id);
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

/** What another account has to list for a link to this one to count: this account or its channel. */
const selfIds = (u, base) => [urls(base).person(u.username), urls(base).group(u.username)];

/**
 * Checks that the other account lists this one back, fetching it fresh unless `cached` (a profile it has
 * just sent is as fresh as it gets). While its server can't be reached, the last answer stands.
 */
export async function verifyLink(link, { cached = false } = {}) {
  const u = userRow(link.user_id);
  const base = apBase();
  if (!u || !base) return link;
  const mine = selfIds(u, base);
  const lists = (a) => !!a && parseList(a.also_known_as).some((x) => mine.includes(x));
  const load = async (id) => {
    const row = cached && db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(id);
    return row || storeActor(await apFetch(id, { signer: signer() }), id);
  };
  let verified;
  let error = null;
  try {
    verified = lists(await load(link.actor_id));
    // Some software keeps aliases on the channel rather than the account.
    if (!verified && link.group_id) verified = lists(await load(link.group_id).catch(() => null));
  } catch (e) {
    const gone = e.status === 404 || e.status === 410;
    verified = gone ? false : !!link.verified_at;
    error = gone ? 'That account no longer exists' : `Could not reach it: ${e.message}`;
  }
  db.prepare('UPDATE account_links SET verified_at = ?, checked_at = ?, last_error = ? WHERE id = ?').run(
    verified ? link.verified_at || now() : null, now(), error, link.id,
  );
  return linkRow(link.id);
}

/** Sends this account's profile (with its new alsoKnownAs) to its followers and to the accounts named. */
function announce(u, actorIds) {
  const base = apBase();
  if (!base || !apEnabled()) return;
  sendActorUpdates(u);
  const inboxes = inboxesOf(actorIds);
  if (!inboxes.length) return;
  const x = urls(base);
  const object = personJson(u, base);
  delete object['@context'];
  deliver(`u:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Update', actor: x.person(u.username), to: [PUBLIC], object }, inboxes);
}

/** Called when another server sends a fresh copy of an account: links to it are checked again. */
export function remoteActorChanged(actorId) {
  for (const l of db.prepare('SELECT id FROM account_links WHERE actor_id = ? OR group_id = ?').all(actorId, actorId)) {
    enqueueJob('links.verify', { id: l.id, cached: true }, { dedupe: `links-verify:${l.id}` });
  }
}

defineJob('links.verify', {
  lane: 'network',
  maxAttempts: 2,
  handler: async ({ id, cached = false }) => {
    const l = linkRow(id);
    if (l) await verifyLink(l, { cached });
  },
});

defineJob('links.recheck', {
  lane: 'network',
  maxAttempts: 1,
  handler: async () => {
    try {
      if (apEnabled() && apBase()) {
        const due = db.prepare('SELECT * FROM account_links WHERE checked_at IS NULL OR checked_at < ? ORDER BY checked_at LIMIT 200').all(now() - RECHECK_MS);
        for (const l of due) await verifyLink(l);
      }
    } finally {
      enqueueJob('links.recheck', {}, { delay: 6 * 3600_000, dedupe: 'links-recheck' });
    }
  },
});
export const startLinkChecks = () => enqueueJob('links.recheck', {}, { delay: 5 * 60_000, dedupe: 'links-recheck' });

// ---- what other pages show -------------------------------------------------------------------------------

function follows(viewerId, l) {
  const ids = [l.actor_id, l.group_id].filter(Boolean);
  return !!db.prepare(`SELECT 1 FROM ap_follows WHERE local_actor = ? AND remote_actor IN (${ids.map(() => '?').join(', ')})`).get(`u:${viewerId}`, ...ids);
}

/** A local account's verified links, for its channel page, and whether the viewer follows each. */
export function publicLinks(userId, viewer = null) {
  return db
    .prepare('SELECT l.*, a.name, a.icon_url FROM account_links l LEFT JOIN ap_actors a ON a.id = l.actor_id WHERE l.user_id = ? AND l.verified_at IS NOT NULL ORDER BY l.created_at')
    .all(userId)
    .map((l) => ({
      handle: l.handle,
      url: l.profile_url || l.actor_id,
      name: l.name || null,
      avatar_url: l.icon_url || null,
      host: hostOf(l.actor_id),
      channel: !!l.group_id,
      following: viewer ? follows(viewer.id, l) : false,
    }));
}

/** The profile pages a local account names as its own, for rel="me" links on its channel page. */
export const relMeLinks = (userId) => db.prepare('SELECT profile_url, actor_id FROM account_links WHERE user_id = ?').all(userId).map((l) => l.profile_url || l.actor_id);

/** Whether a commenter (the placeholder of someone from elsewhere) is one of the uploader's verified linked accounts. */
export function isLinkedCommenter(ownerId, author) {
  const ids = [author?.ap_actor, author?.remote_profile_url].filter(Boolean);
  if (!ids.length) return false;
  const q = db.prepare('SELECT 1 FROM account_links WHERE user_id = ? AND verified_at IS NOT NULL AND (actor_id = ? OR group_id = ? OR profile_url = ?)');
  return ids.some((id) => !!q.get(ownerId, id, id, id));
}

/** A filter on the network index for videos from a local account's verified linked channels, or null. */
export function linkedVideoFilter(userId) {
  const ids = db
    .prepare('SELECT actor_id, group_id FROM account_links WHERE user_id = ? AND verified_at IS NOT NULL')
    .all(userId)
    .flatMap((l) => [l.actor_id, l.group_id])
    .filter(Boolean);
  return ids.length ? { sql: `r.ap_actor IN (${ids.map(() => '?').join(', ')})`, params: ids } : null;
}

/**
 * Subscribes the viewer to a channel here and follows each verified linked account that has a channel
 * (an account without one, such as Mastodon's, has no videos to follow). Returns the handles followed.
 */
export async function subscribeAll(viewer, owner) {
  if (viewer.id !== owner.id) {
    db.prepare('INSERT OR IGNORE INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)').run(viewer.id, owner.id, now());
  }
  const followed = [];
  if (!apEnabled() || !apBase()) return followed;
  const links = db.prepare('SELECT * FROM account_links WHERE user_id = ? AND verified_at IS NOT NULL AND group_id IS NOT NULL ORDER BY created_at').all(owner.id);
  for (const l of links) {
    if (follows(viewer.id, l) || isBlockedActor(l.group_id)) continue;
    const g = await getActor(l.group_id).catch(() => null);
    if (!g) continue;
    // The network can turn off subscriptions between its members.
    const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(g.instance_id);
    if (inst && isNetworkPeer(inst) && !networkPolicy().subscriptions) continue;
    await sendFollow(`u:${viewer.id}`, g.id);
    db.prepare(
      'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(viewer.id, g.instance_id, g.username, g.name || g.username, g.icon_url, g.url || g.id, now());
    followed.push(l.handle);
  }
  return followed;
}

// ---- the owner's side: /api/me/links -----------------------------------------------------------------

function ownLink(l) {
  const a = db.prepare('SELECT name, icon_url FROM ap_actors WHERE id = ?').get(l.actor_id);
  return {
    id: l.id,
    handle: l.handle,
    url: l.profile_url || l.actor_id,
    name: a?.name || null,
    avatar_url: a?.icon_url || null,
    channel: !!l.group_id,
    verified: !!l.verified_at,
    verified_at: l.verified_at,
    checked_at: l.checked_at,
    error: l.last_error,
  };
}

/** Accounts elsewhere that list this one but aren't linked from here yet, so one click links them back. */
function suggestionsFor(u, base) {
  const mine = selfIds(u, base);
  const linked = new Set(db.prepare('SELECT actor_id, group_id FROM account_links WHERE user_id = ?').all(u.id).flatMap((l) => [l.actor_id, l.group_id]));
  const out = new Map();
  const rows = db
    .prepare("SELECT * FROM ap_actors WHERE type IN ('Person', 'Group') AND (also_known_as LIKE ? OR also_known_as LIKE ?)")
    .all(`%"${mine[0]}"%`, `%"${mine[1]}"%`);
  for (const a of rows) {
    if (a.domain === hostOf(base) || isBlockedActor(a.id) || !parseList(a.also_known_as).some((x) => mine.includes(x))) continue;
    // A channel stands for its account.
    const owner = a.type === 'Group' && a.attributed_to ? db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(a.attributed_to) || a : a;
    if (linked.has(a.id) || linked.has(owner.id) || out.has(owner.id)) continue;
    out.set(owner.id, { actor: owner.id, handle: handleOf(owner), name: owner.name || owner.username, url: owner.url || owner.id });
  }
  return [...out.values()].slice(0, 10);
}

function state(userId, req) {
  const u = userRow(userId);
  const base = apBase(req);
  return {
    enabled: apEnabled() && !!apBase(),
    handle: `@${u.username}@${hostOf(base)}`,
    max: MAX_LINKS,
    links: db.prepare('SELECT * FROM account_links WHERE user_id = ? ORDER BY created_at').all(u.id).map(ownLink),
    suggestions: apBase() ? suggestionsFor(u, apBase()) : [],
  };
}

function requireApOn(req, res, next) {
  if (!apEnabled()) throw new HttpError(400, 'Linking accounts needs ActivityPub, which is off on this site');
  if (!apBase()) throw new HttpError(400, "Set this site's Public URL first, so other sites can check the link");
  next();
}

export const linksRouter = Router();

linksRouter.get('/links', requireAuth, (req, res) => res.json(state(req.user.id, req)));

linksRouter.post('/links', requireAuth, requireApOn, async (req, res) => {
  const u = userRow(req.user.id);
  if (db.prepare('SELECT COUNT(*) AS n FROM account_links WHERE user_id = ?').get(u.id).n >= MAX_LINKS) {
    throw new HttpError(400, `An account can be linked to up to ${MAX_LINKS} others`);
  }
  const found = await resolveActor(req.body?.handle);
  if (found.domain === hostOf(apBase())) throw new HttpError(400, 'That account is on this site. Link accounts on other sites.');
  if (!['Person', 'Group'].includes(found.type)) throw new HttpError(400, "That isn't an account or a channel");
  if (isBlockedActor(found.id)) throw new HttpError(400, 'That site is blocked here');
  // A channel stands for its account, and an account brings its channel along when it has one.
  let person = found;
  let group = null;
  if (found.type === 'Group') {
    group = found;
    if (found.attributed_to) person = await getActor(found.attributed_to).catch(() => found);
  } else {
    try {
      const g = await resolveActor(`${found.username}_channel@${found.domain}`);
      if (g.type === 'Group' && (!g.attributed_to || g.attributed_to === found.id)) group = g;
    } catch {}
  }
  if (db.prepare('SELECT 1 FROM account_links WHERE user_id = ? AND (actor_id = ? OR group_id = ?)').get(u.id, person.id, person.id)) {
    throw new HttpError(409, `${handleOf(person)} is already linked`);
  }
  const r = db
    .prepare('INSERT INTO account_links (user_id, actor_id, group_id, handle, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u.id, person.id, group && group.id !== person.id ? group.id : null, handleOf(person), person.url || person.id, now());
  const link = await verifyLink(linkRow(r.lastInsertRowid));
  announce(userRow(u.id), [link.actor_id]);
  res.status(201).json({ ...state(u.id, req), added: ownLink(link) });
});

linksRouter.delete('/links/:id', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM account_links WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!l) throw new HttpError(404, 'That link is gone already');
  db.prepare('DELETE FROM account_links WHERE id = ?').run(l.id);
  // The other account's server hears about it, and stops showing the link.
  announce(userRow(req.user.id), [l.actor_id]);
  res.json(state(req.user.id, req));
});

linksRouter.post('/links/check', requireAuth, requireApOn, async (req, res) => {
  for (const l of db.prepare('SELECT * FROM account_links WHERE user_id = ?').all(req.user.id)) await verifyLink(l);
  res.json(state(req.user.id, req));
});
