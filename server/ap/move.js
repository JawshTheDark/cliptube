/**
 * Moving a channel to another site, the way Mastodon accounts move:
 *
 * 1. The new account lists the old one as an alias (alsoKnownAs). On OurTube: Settings, "Moving here".
 * 2. The old account points at the new one (movedTo) and sends Move to its followers. Their servers
 *    check the alias, then follow the new account instead.
 *
 * People subscribed through the OurTube network are moved by a signed message from the old instance
 * to theirs, and people on the old instance itself are moved by it directly. Mounted at /api/me.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { requireAuth, userToPublic } from '../auth.js';
import { HttpError, now } from '../util.js';
import { defineJob, enqueueJob } from '../jobs.js';
import { notify } from '../notify.js';
import { announceAccountMove, clipTubePeer, networkActive, onRemoteAccountMoved, peerWith, subscribeRemote } from '../network.js';
import { CONTEXT, PUBLIC, apBase, apEnabled, hostOf, originOf, parseLocal, urls } from './common.js';
import { getActor, inboxesOf, resolveActor } from './actors.js';
import { deliver, followersOf, sendFollow, sendUnfollow } from './deliver.js';
import { groupJson, personJson } from './objects.js';

const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** The old accounts a local account says it was (its alsoKnownAs). */
export const aliasesOf = (u) => parseList(u?.also_known_as);
const handleOf = (a) => `@${a.username}@${a.domain}`;

/** What a move points at, in the shape the subscription movers below want. */
function targetFromActor(a, group = null) {
  return {
    person: a.type === 'Person' ? a.id : null,
    group: group?.id || (a.type === 'Group' ? a.id : null),
    url: a.url || a.id,
    handle: handleOf(a),
    origin: originOf(a.id),
    domain: a.domain,
    username: a.type === 'Person' ? a.username : null,
    name: a.name || a.username,
    icon_url: a.icon_url || null,
  };
}

const isHere = (target) => {
  const base = apBase();
  return !!base && hostOf(base) === target.domain;
};

/**
 * Moves one local person's subscription to a channel's new home: a channel on this site, an OurTube
 * instance (subscribed through the network), or anywhere in the fediverse (followed). Returns how, or null.
 */
export async function moveSubscriber(userId, target, { fromName = null, prefer = 'network' } = {}) {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND remote_instance_id IS NULL AND status = 'active'").get(userId);
  if (!user) return null;
  let how = null;
  if (isHere(target)) {
    // A channel on this site: its account or channel actor names it.
    const p = parseLocal(target.person || target.group, apBase());
    const name = p && (p.kind === 'u' || p.kind === 'c') ? p.name : target.username;
    const ch = name ? db.prepare('SELECT id, username FROM users WHERE username = ? AND remote_instance_id IS NULL').get(name) : null;
    if (ch && ch.id !== user.id) {
      db.prepare('INSERT OR IGNORE INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)').run(user.id, ch.id, now());
      target = { ...target, username: ch.username };
      how = 'here';
    }
  }
  if (!how && prefer === 'network' && target.username && networkActive()) {
    const peer = clipTubePeer(target.origin) || (await peerWith(target.origin));
    if (peer) {
      try {
        await subscribeRemote(userToPublic(user), peer, target.username, { display_name: target.name, avatar_url: target.icon_url, profile_url: target.url });
        how = 'network';
      } catch (e) {
        console.warn(`[move] could not subscribe ${user.username} to ${target.handle} through the network: ${e.message}`);
      }
    }
  }
  if (!how && !isHere(target) && apEnabled() && apBase()) {
    const a = await sendFollow(`u:${user.id}`, target.group || target.person);
    db.prepare(
      'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(user.id, a.instance_id, a.username, a.name || a.username, a.icon_url, a.url || a.id, now());
    how = 'fediverse';
  }
  notify(user.id, {
    kind: 'move',
    title: `${fromName || 'A channel you subscribe to'} moved to ${target.handle}`,
    body: how ? 'Your subscription moved with it.' : 'Subscribe to the new channel to keep getting its videos.',
    url: how === 'here' ? `/c/${target.username}` : '/subscriptions',
    actor_label: target.handle,
    dedupe: `move:${target.person || target.group}`,
  });
  return how;
}

// ---- moves announced by others -----------------------------------------------------------------------------

/** A fediverse account people here follow sent Move: check the new account agrees, then follow it instead. */
export async function followMove(originId, targetId) {
  if (typeof targetId !== 'string' || !/^https?:\/\//.test(targetId)) return 0;
  const target = await getActor(targetId, { refresh: true });
  if (!parseList(target.also_known_as).includes(originId)) {
    console.warn(`[move] ignored a move of ${originId}: ${targetId} does not list it as an old account`);
    return 0;
  }
  db.prepare('UPDATE ap_actors SET moved_to = ? WHERE id = ?').run(target.id, originId);
  const origin = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(originId);
  const info = targetFromActor(target);
  let n = 0;
  for (const f of db.prepare('SELECT * FROM ap_follows WHERE remote_actor = ?').all(originId)) {
    await sendUnfollow(f.local_actor, originId);
    if (f.local_actor.startsWith('u:')) {
      const userId = f.local_actor.slice(2);
      if (origin) db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(userId, origin.instance_id, origin.username);
      if (await moveSubscriber(userId, info, { fromName: origin?.name, prefer: 'fediverse' }).catch(() => null)) n++;
    } else if (!isHere(info)) {
      await sendFollow(f.local_actor, target.id); // the instance mirroring a server
      n++;
    }
  }
  return n;
}

// Another OurTube instance says one of its accounts moved (signed; see network.js).
onRemoteAccountMoved(async (inst, username, t) => {
  if (typeof t.person !== 'string') return 0;
  let target;
  try {
    target = await getActor(t.person, { refresh: true });
  } catch {
    return 0;
  }
  const old = [`${inst.url}/ap/users/${username}`, `${inst.url}/ap/channels/${username}`];
  if (!parseList(target.also_known_as).some((x) => old.includes(x))) {
    console.warn(`[move] ignored a move of ${username}@${hostOf(inst.url)}: the new account does not list it as an old account`);
    return 0;
  }
  let group = null;
  if (typeof t.group === 'string') group = await getActor(t.group).catch(() => null);
  if (group && group.attributed_to && group.attributed_to !== target.id) group = null;
  const info = targetFromActor(target, group);
  let n = 0;
  for (const r of db.prepare('SELECT user_id, display_name FROM network_subscriptions WHERE instance_id = ? AND username = ?').all(inst.id, username)) {
    const how = await moveSubscriber(r.user_id, info, { fromName: r.display_name }).catch(() => null);
    if (how) {
      db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(r.user_id, inst.id, username);
      n++;
    }
  }
  return n;
});

// ---- moving a local channel out ------------------------------------------------------------------------------

/** Tells fediverse followers: Update (so they see movedTo), then Move from the account and from the channel. */
function sendMoveActivities(u) {
  const base = apBase();
  if (!base || !u.moved_to) return;
  const x = urls(base);
  const person = x.person(u.username);
  const group = x.group(u.username);
  const personInboxes = inboxesOf(followersOf([`u:${u.id}`]));
  const groupInboxes = inboxesOf(followersOf([`c:${u.id}`]));
  const pj = personJson(u, base);
  const gj = groupJson(u, base);
  delete pj['@context'];
  delete gj['@context'];
  deliver(`u:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Update', actor: person, to: [PUBLIC], object: pj }, personInboxes);
  deliver(`c:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Update', actor: group, to: [PUBLIC], object: gj }, groupInboxes);
  deliver(`u:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Move', actor: person, object: person, target: u.moved_to, to: [`${person}/followers`] }, personInboxes);
  deliver(`c:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Move', actor: group, object: group, target: u.moved_to_group || u.moved_to, to: [`${group}/followers`] }, groupInboxes);
}

/**
 * Profile changes (name, picture, bio, aliases, undoing a move) for servers that follow the account or channel,
 * and for the servers peering with this one, which show its videos and comments.
 */
export function sendActorUpdates(u) {
  const base = apBase();
  if (!base) return;
  const x = urls(base);
  const pj = personJson(u, base);
  const gj = groupJson(u, base);
  delete pj['@context'];
  delete gj['@context'];
  deliver(`u:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Update', actor: x.person(u.username), to: [PUBLIC], object: pj }, inboxesOf(followersOf([`u:${u.id}`, 'i'])));
  deliver(`c:${u.id}`, { '@context': CONTEXT, id: x.activity(), type: 'Update', actor: x.group(u.username), to: [PUBLIC], object: gj }, inboxesOf(followersOf([`c:${u.id}`, 'i'])));
}

// People on this site and on other OurTube instances follow the channel to its new home.
defineJob('move.followers', {
  lane: 'network',
  maxAttempts: 3,
  handler: async ({ userId }) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u?.moved_to) return;
    const person = await getActor(u.moved_to);
    const group = u.moved_to_group ? await getActor(u.moved_to_group).catch(() => null) : null;
    const target = targetFromActor(person, group);
    const subs = db
      .prepare('SELECT s.subscriber_id FROM subscriptions s JOIN users x ON x.id = s.subscriber_id WHERE s.channel_id = ? AND x.remote_instance_id IS NULL')
      .all(u.id);
    for (const s of subs) {
      const how = await moveSubscriber(s.subscriber_id, target, { fromName: u.display_name }).catch((e) => {
        console.warn(`[move] could not move a subscriber of ${u.username}: ${e.message}`);
        return null;
      });
      if (how) db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').run(s.subscriber_id, u.id);
    }
    await announceAccountMove(userToPublic(u), { person: target.person, group: target.group, url: target.url, handle: target.handle });
  },
});

// ---- the account owner's API --------------------------------------------------------------------------------

export const moveRouter = Router();
moveRouter.use(requireAuth);

function requireApOn(req, res, next) {
  if (!apEnabled()) throw new HttpError(400, 'Moving needs ActivityPub, which is turned off on this site');
  if (!apBase()) throw new HttpError(400, "Moving needs this site's Public URL set (ask an admin)");
  next();
}

function moveState(userId, req) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const base = apBase(req);
  const host = hostOf(base);
  return {
    enabled: apEnabled() && !!apBase(),
    handles: { account: `@${u.username}@${host}`, channel: `@${u.username}_channel@${host}` },
    aliases: aliasesOf(u).map((id) => {
      const a = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(id);
      return { id, handle: a ? handleOf(a) : id, name: a?.name || null, type: a?.type || null, url: a?.url || id };
    }),
    moved: u.moved_to ? { to: u.moved_to, group: u.moved_to_group, url: u.moved_to_url, handle: u.moved_to_handle, at: u.moved_at } : null,
    followers: {
      fediverse: db.prepare('SELECT COUNT(DISTINCT remote_actor) AS n FROM ap_followers WHERE local_actor IN (?, ?)').get(`u:${u.id}`, `c:${u.id}`).n,
      here: db.prepare('SELECT COUNT(*) AS n FROM subscriptions s JOIN users x ON x.id = s.subscriber_id WHERE s.channel_id = ? AND x.remote_instance_id IS NULL').get(u.id).n,
      network: db.prepare('SELECT COUNT(*) AS n FROM subscriptions s JOIN users x ON x.id = s.subscriber_id WHERE s.channel_id = ? AND x.remote_instance_id IS NOT NULL AND x.ap_actor IS NULL').get(u.id).n,
    },
  };
}

moveRouter.get('/move', (req, res) => res.json(moveState(req.user.id, req)));

// "Moving here": the old account (and its channel, if it has one) become aliases of this one.
moveRouter.post('/aliases', requireApOn, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const a = await resolveActor(req.body?.handle);
  if (a.domain === hostOf(apBase())) throw new HttpError(400, 'That account is on this site. Aliases are for accounts on other sites.');
  if (!['Person', 'Group'].includes(a.type)) throw new HttpError(400, "That isn't an account or a channel");
  const add = [a.id];
  // OurTube and PeerTube channels are called name_channel; list it too, so its followers can move.
  if (a.type === 'Person') {
    try {
      const g = await resolveActor(`${a.username}_channel@${a.domain}`);
      if (g.type === 'Group' && (!g.attributed_to || g.attributed_to === a.id)) add.push(g.id);
    } catch {}
  }
  const list = [...new Set([...aliasesOf(u), ...add])];
  if (list.length > 10) throw new HttpError(400, 'An account can have up to 10 old accounts');
  db.prepare('UPDATE users SET also_known_as = ? WHERE id = ?').run(JSON.stringify(list), u.id);
  sendActorUpdates(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id));
  res.status(201).json(moveState(u.id, req));
});

moveRouter.delete('/aliases', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const id = String(req.body?.id || '');
  const gone = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(id);
  // Removing an account also removes its channel (and the other way round).
  const drop = new Set([id]);
  for (const x of aliasesOf(u)) {
    const a = db.prepare('SELECT attributed_to FROM ap_actors WHERE id = ?').get(x);
    if (a?.attributed_to === id || (gone?.attributed_to && gone.attributed_to === x)) drop.add(x);
  }
  db.prepare('UPDATE users SET also_known_as = ? WHERE id = ?').run(JSON.stringify(aliasesOf(u).filter((x) => !drop.has(x))), u.id);
  res.json(moveState(u.id, req));
});

// Moving this channel away. The new account must list this one as an alias first.
moveRouter.post('/move', requireApOn, async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(String(req.body?.password || ''), u.password_hash))) throw new HttpError(400, 'Password is wrong');
  if (u.moved_to) throw new HttpError(400, 'This channel has already moved. Undo that first to move it somewhere else.');
  const base = apBase();
  const found = await resolveActor(req.body?.handle);
  const target = await getActor(found.id, { refresh: true });
  if (target.domain === hostOf(base)) throw new HttpError(400, 'Pick an account on another site');
  if (!['Person', 'Group'].includes(target.type)) throw new HttpError(400, "That isn't an account or a channel");
  const mine = [urls(base).person(u.username), urls(base).group(u.username)];
  const myHandle = `@${u.username}@${hostOf(base)}`;
  if (!parseList(target.also_known_as).some((x) => mine.includes(x))) {
    throw new HttpError(
      400,
      `${handleOf(target)} doesn't list ${myHandle} as an old account yet. On the new site, add ${myHandle} under Settings, "Moving here", then try again.`,
    );
  }
  let group = target.type === 'Group' ? target : null;
  if (!group) {
    try {
      const g = await resolveActor(`${target.username}_channel@${target.domain}`);
      const fresh = await getActor(g.id, { refresh: true });
      if (fresh.type === 'Group' && parseList(fresh.also_known_as).some((x) => mine.includes(x))) group = fresh;
    } catch {}
  }
  db.prepare('UPDATE users SET moved_to = ?, moved_to_group = ?, moved_to_url = ?, moved_to_handle = ?, moved_at = ? WHERE id = ?').run(
    target.id, group && group.id !== target.id ? group.id : null, target.url || target.id, handleOf(target), now(), u.id,
  );
  sendMoveActivities(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id));
  enqueueJob('move.followers', { userId: u.id }, { dedupe: `move:${u.id}:${target.id}` });
  res.json(moveState(u.id, req));
});

// Undo: the channel stops pointing elsewhere. Followers who already moved stay with the new account.
moveRouter.delete('/move', (req, res) => {
  db.prepare('UPDATE users SET moved_to = NULL, moved_to_group = NULL, moved_to_url = NULL, moved_to_handle = NULL, moved_at = NULL WHERE id = ?').run(req.user.id);
  if (apEnabled()) sendActorUpdates(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  res.json(moveState(req.user.id, req));
});
