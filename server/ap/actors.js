/**
 * Remote ActivityPub actors: fetched (signed, as the instance actor), cached with their keys, looked up by
 * handle with WebFinger, and given a placeholder account ("name@host") so their likes, comments and
 * follows work like everyone else's. Their server gets an instances row, so blocking works the same.
 */
import { db } from '../db.js';
import { HttpError, newId, now, str } from '../util.js';
import { apFetch } from './http.js';
import { first, hostOf, idOf, originOf } from './common.js';
import { instanceKeys } from './keys.js';

const STALE_MS = 24 * 3600_000;
const ACTOR_TYPES = new Set(['Person', 'Group', 'Application', 'Service', 'Organization']);

let instanceSigner = null;
/** Signs fetches as the instance actor. Set by the routes module, which knows the base URL. */
export function setInstanceSigner(fn) {
  instanceSigner = fn;
}
export const signer = () => (instanceSigner ? instanceSigner() : null);

/** The instances row for a fediverse server, created on first contact (blocking applies to it). */
export function instanceFor(actorId) {
  const origin = originOf(actorId);
  if (!origin) throw new HttpError(400, 'Bad actor id');
  let inst = db.prepare('SELECT * FROM instances WHERE url = ?').get(origin);
  if (!inst) {
    db.prepare("INSERT INTO instances (url, name, source, peer_status, protocol, created_at) VALUES (?, ?, 'activitypub', 'approved', 0, ?)").run(origin, hostOf(origin), now());
    inst = db.prepare('SELECT * FROM instances WHERE url = ?').get(origin);
  }
  return inst;
}

export const isBlockedActor = (actorId) => !!db.prepare('SELECT 1 FROM instances WHERE url = ? AND blocked = 1').get(originOf(actorId));

function iconOf(a) {
  const ic = first(a.icon);
  return typeof ic === 'string' ? ic : ic?.url ? idOf(ic.url) || null : null;
}

function htmlUrl(a) {
  if (typeof a.url === 'string') return a.url;
  const list = Array.isArray(a.url) ? a.url : a.url ? [a.url] : [];
  const html = list.find((u) => u && (u.mediaType === 'text/html' || !u.mediaType));
  return idOf(html) || a.id;
}

/** Validates and stores an actor document. The id must be on the host it was fetched from. */
export function storeActor(a, fetchedFrom = null) {
  if (!a || !ACTOR_TYPES.has(a.type) || typeof a.id !== 'string') throw new HttpError(400, 'Not an actor');
  if (fetchedFrom && hostOf(a.id) !== hostOf(fetchedFrom)) throw new HttpError(400, 'Actor id is on a different host');
  const inbox = idOf(a.inbox);
  if (!inbox || hostOf(inbox) !== hostOf(a.id)) throw new HttpError(400, 'Actor inbox missing or on another host');
  const key = a.publicKey && typeof a.publicKey === 'object' ? first(a.publicKey) : null;
  const username = str(a.preferredUsername || hostOf(a.id), 100).trim();
  const inst = instanceFor(a.id);
  const vals = [
    a.type, username, hostOf(a.id), str(a.name || username, 100), str(a.summary, 2000), inbox, idOf(a.endpoints?.sharedInbox) || null, idOf(a.outbox),
    idOf(a.followers), htmlUrl(a), iconOf(a), key?.id || null, key?.publicKeyPem || null, idOf(first(a.attributedTo)), inst.id, now(),
  ];
  db.prepare(
    `INSERT INTO ap_actors (type, username, domain, name, summary, inbox, shared_inbox, outbox, followers_url, url, icon_url, key_id, public_key, attributed_to, instance_id, fetched_at, id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET type = excluded.type, username = excluded.username, domain = excluded.domain, name = excluded.name, summary = excluded.summary,
       inbox = excluded.inbox, shared_inbox = excluded.shared_inbox, outbox = excluded.outbox, followers_url = excluded.followers_url, url = excluded.url,
       icon_url = excluded.icon_url, key_id = excluded.key_id, public_key = excluded.public_key, attributed_to = excluded.attributed_to,
       instance_id = excluded.instance_id, fetched_at = excluded.fetched_at`,
  ).run(...vals, a.id);
  const row = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(a.id);
  if (row.user_id) refreshShadow(row);
  return row;
}

/** A remote actor, from the cache or fetched (again when stale or when `refresh`). */
export async function getActor(id, { refresh = false } = {}) {
  const row = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(id);
  if (row && !refresh && now() - row.fetched_at < STALE_MS) return row;
  try {
    const doc = await apFetch(id, { signer: signer() });
    return storeActor(doc, id);
  } catch (e) {
    if (row) return row; // keep using what we had while their server is unreachable
    throw new HttpError(e.status === 404 || e.status === 410 ? 404 : 400, `Could not load ${id}: ${e.message}`);
  }
}

/** The key behind a keyId (an actor URI, usually with #main-key). */
export async function keyFor(keyId, { refresh = false } = {}) {
  let row = !refresh && db.prepare('SELECT * FROM ap_actors WHERE key_id = ?').get(keyId);
  if (!row) {
    const actorId = keyId.split('#')[0];
    try {
      row = await getActor(actorId, { refresh });
    } catch {
      return null;
    }
  }
  if (!row?.public_key || (row.key_id && row.key_id !== keyId)) return null;
  return { actorId: row.id, pem: row.public_key };
}

/** Finds an actor by handle (@name@host or name@host) with WebFinger, or by URL. */
export async function resolveActor(input) {
  const s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) {
    const doc = await apFetch(s, { signer: signer() }).catch((e) => {
      throw new HttpError(400, `Could not load ${s}: ${e.message}`);
    });
    if (ACTOR_TYPES.has(doc.type)) return storeActor(doc, doc.id);
    // A video or note URL: return its channel, if it has one.
    const owners = (Array.isArray(doc.attributedTo) ? doc.attributedTo : [doc.attributedTo]).filter(Boolean);
    const owner = idOf(owners.find((a) => typeof a === 'object' && a.type === 'Group') || owners[0]);
    if (owner) return getActor(owner);
    throw new HttpError(400, "That address isn't a fediverse account or channel");
  }
  const m = /^@?([^@\s]+)@([^@\s/]+)$/.exec(s);
  if (!m) throw new HttpError(400, 'Enter a handle like @name@server.example or a link');
  const [, user, host] = m;
  const wf = await apFetch(`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${user}@${host}`)}`, { accept: 'application/jrd+json, application/json' }).catch(
    async (e) => {
      // Plain http only in local test setups.
      try {
        return await apFetch(`http://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${user}@${host}`)}`, { accept: 'application/jrd+json, application/json' });
      } catch {
        throw new HttpError(404, `Could not find ${user}@${host}: ${e.message}`);
      }
    },
  );
  const link = (wf.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/.test(l.type || ''));
  if (!link?.href) throw new HttpError(404, `${user}@${host} has no ActivityPub actor`);
  return getActor(link.href);
}

function refreshShadow(actor) {
  db.prepare('UPDATE users SET display_name = ?, remote_avatar_url = ?, remote_profile_url = ? WHERE id = ?').run(
    str(actor.name || actor.username, 50) || actor.username, actor.icon_url, actor.url || actor.id, actor.user_id,
  );
}

/** A placeholder account for a remote actor, so it can like, comment and subscribe. */
export function shadowUser(actor) {
  if (actor.user_id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(actor.user_id);
    if (u) return u;
  }
  const clean = actor.username.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 50) || 'someone';
  let handle = `${clean}@${actor.domain}`;
  const clash = db.prepare('SELECT * FROM users WHERE username = ?').get(handle);
  if (clash && clash.ap_actor === actor.id) {
    db.prepare('UPDATE ap_actors SET user_id = ? WHERE id = ?').run(clash.id, actor.id);
    return clash;
  }
  if (clash) handle = `${clean}.${newId(3)}@${actor.domain}`;
  const id = newId();
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at, remote_instance_id, remote_avatar_url, remote_profile_url, ap_actor) VALUES (?, ?, ?, '!', 0, ?, ?, ?, ?, ?)",
  ).run(id, handle, str(actor.name || actor.username, 50) || actor.username, now(), actor.instance_id, actor.icon_url, actor.url || actor.id, actor.id);
  db.prepare('UPDATE ap_actors SET user_id = ? WHERE id = ?').run(id, actor.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** Inboxes to deliver to: shared inboxes where servers have them, one per server. */
export function inboxesOf(actorIds) {
  const out = new Set();
  for (const id of actorIds) {
    const a = db.prepare('SELECT inbox, shared_inbox FROM ap_actors WHERE id = ?').get(id);
    if (a && !isBlockedActor(id)) out.add(a.shared_inbox || a.inbox);
  }
  return [...out];
}

export { instanceKeys };
