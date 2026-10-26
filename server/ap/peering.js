/**
 * The OurTube network over ActivityPub (protocol 4). network.js decides who peers with whom; this module
 * does the ActivityPub part and registers itself there with useApTransport:
 *
 * - follow: our instance actor follows a peer's, which is what peering is now. Videos we already had from
 *   that peer switch to the ActivityPub path, and people's subscriptions there become follows.
 * - reconcile: reads the peer's outbox (its instance actor lists every public video), fetches what is new
 *   or changed, and drops what is gone, so nothing is missed even if a delivery was.
 * - answerFollow: accepts or rejects a peer's follow that waited for an admin.
 * - unpeer: stops following a peer and removes it as a follower (leaving the network).
 * - upgradePeers: moves peers from protocol v3 to ActivityPub once they speak it.
 * - refreshVideo: fresh counts and details for a remote video page.
 */
import { db } from '../db.js';
import { now } from '../util.js';
import { introduce, isNetworkPeer, useApTransport } from '../network.js';
import { apBase, hostOf, idOf, originOf, urls } from './common.js';
import { apFetch } from './http.js';
import { getActor, signer } from './actors.js';
import { sendAcceptOrReject, sendFollow, sendUnfollow } from './deliver.js';
import { ingestVideo } from './inbox.js';
import { MAX_SHARED, cleanShares, dropShares, recordShare, sharesIn } from './sharing.js';

const MAX_ITEMS = 5000;
const REFRESH_MS = 60_000;

/** Rows and subscriptions we had from a peer over protocol v3 take the ActivityPub path from now on. */
async function switchToActivityPub(inst) {
  const origin = originOf(inst.ap_actor);
  db.prepare(
    `UPDATE network_videos SET origin_type = 'activitypub',
       ap_id = COALESCE(ap_id, ? || '/ap/videos/' || remote_id),
       ap_actor = COALESCE(ap_actor, ? || '/ap/channels/' || uploader_username),
       uploader_username = CASE WHEN uploader_username LIKE '%\\_channel' ESCAPE '\\' THEN uploader_username ELSE uploader_username || '_channel' END
     WHERE instance_id = ? AND origin_type = 'cliptube'`,
  ).run(origin, origin, inst.id);
  // Subscriptions to its channels become follows of the channels' actors (name_channel on OurTube).
  const subs = db.prepare("SELECT * FROM network_subscriptions WHERE instance_id = ? AND username NOT LIKE '%\\_channel' ESCAPE '\\'").all(inst.id);
  for (const s of subs) {
    try {
      const a = await sendFollow(`u:${s.user_id}`, `${origin}/ap/channels/${s.username}`);
      db.prepare(
        'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(s.user_id, a.instance_id, a.username, a.name || s.display_name, a.icon_url || s.avatar_url, a.url || s.profile_url, s.created_at);
      db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(s.user_id, s.instance_id, s.username);
    } catch (e) {
      console.warn(`[network] moving a subscription to ${s.username}@${hostOf(origin)} to ActivityPub failed: ${e.message}`);
    }
  }
}

async function follow(inst) {
  if (!inst?.ap_actor) return;
  await switchToActivityPub(inst);
  const f = db.prepare("SELECT status FROM ap_follows WHERE local_actor = 'i' AND remote_actor = ?").get(inst.ap_actor);
  if (f?.status === 'accepted') {
    db.prepare("UPDATE instances SET remote_status = 'approved' WHERE id = ?").run(inst.id);
    return;
  }
  await sendFollow('i', inst.ap_actor);
  db.prepare("UPDATE instances SET remote_status = CASE WHEN remote_status = 'approved' THEN remote_status ELSE 'pending' END, last_hello_at = ? WHERE id = ?").run(now(), inst.id);
}

async function answerFollow(inst, accepted) {
  const actor = await getActor(inst.ap_actor);
  const follow = { id: inst.ap_follow_id, type: 'Follow', actor: inst.ap_actor, object: urls(apBase()).instance() };
  if (accepted) {
    db.prepare(
      "INSERT INTO ap_followers (local_actor, remote_actor, follow_id, created_at) VALUES ('i', ?, ?, ?) ON CONFLICT(local_actor, remote_actor) DO UPDATE SET follow_id = excluded.follow_id",
    ).run(inst.ap_actor, inst.ap_follow_id, now());
  }
  sendAcceptOrReject('i', follow, actor, accepted);
  db.prepare('UPDATE instances SET ap_follow_id = NULL WHERE id = ?').run(inst.id);
}

async function unpeer(inst) {
  await sendUnfollow('i', inst.ap_actor);
  const f = db.prepare("SELECT * FROM ap_followers WHERE local_actor = 'i' AND remote_actor = ?").get(inst.ap_actor);
  if (f) {
    const actor = await getActor(inst.ap_actor).catch(() => null);
    if (actor) sendAcceptOrReject('i', { id: f.follow_id, type: 'Follow', actor: inst.ap_actor, object: urls(apBase()).instance() }, actor, false);
    db.prepare("DELETE FROM ap_followers WHERE local_actor = 'i' AND remote_actor = ?").run(inst.ap_actor);
  }
}

/** Reads a peer's outbox: fetches new and changed videos, and drops the ones that are gone. */
async function reconcile(inst, { full = false } = {}) {
  const actor = await getActor(inst.ap_actor, { refresh: full });
  if (!actor.outbox) return { received: 0 };
  const opts = { signer: signer(), timeout: 20000 };
  const top = await apFetch(actor.outbox, opts);
  let page = top.orderedItems || top.items ? top : top.first ? (typeof top.first === 'object' && (top.first.orderedItems || top.first.items) ? top.first : await apFetch(idOf(top.first), opts)) : null;
  const seen = new Map(); // video id -> updated
  let complete = false;
  for (let n = 0; page && n < 500 && seen.size < MAX_ITEMS; n++) {
    for (const it of page.orderedItems || page.items || []) {
      const id = typeof it === 'string' ? it : idOf(it?.object);
      if (typeof id === 'string' && hostOf(id) === hostOf(inst.ap_actor)) seen.set(id, Date.parse(it?.updated || it?.object?.updated || '') || 0);
    }
    const next = idOf(page.next);
    if (!next) {
      complete = true;
      break;
    }
    page = await apFetch(next, opts);
  }
  let received = 0;
  for (const [id, updated] of seen) {
    const row = db.prepare('SELECT updated_at, fetched_at FROM network_videos WHERE instance_id = ? AND ap_id = ?').get(inst.id, id);
    if (row && !full && (!updated || updated <= row.updated_at)) continue;
    try {
      if (await ingestVideo(await apFetch(id, opts), { source: 'follow' })) received++;
    } catch (e) {
      if (e.status === 404 || e.status === 410) seen.delete(id); // gone since the outbox was written
    }
  }
  // OurTube peers list every public video in their outbox, so anything missing from it is gone.
  if (complete && (typeof top.totalItems !== 'number' || seen.size >= Math.min(top.totalItems, MAX_ITEMS))) {
    for (const r of db.prepare('SELECT remote_id, ap_id FROM network_videos WHERE instance_id = ?').all(inst.id)) {
      if (!r.ap_id || !seen.has(r.ap_id)) db.prepare('DELETE FROM network_videos WHERE instance_id = ? AND remote_id = ?').run(inst.id, r.remote_id);
    }
  }
  received += await reconcileShares(inst, opts);
  return { received };
}

const NEW_SHARES_PER_ROUND = 100;
/**
 * The fediverse videos a peer passes on (ap/sharing.js), when this server takes them: new ones are read from
 * their own servers, a hundred a round; the ones it no longer lists stop counting as shared by it.
 */
async function reconcileShares(inst, opts) {
  if (!sharesIn()) return 0;
  let page;
  try {
    const top = await apFetch(`${inst.ap_actor}/shared`, opts);
    page = top.orderedItems || top.items ? top : top.first ? (typeof top.first === 'object' ? top.first : await apFetch(idOf(top.first), opts)) : null;
  } catch (e) {
    if (e.status === 404 || e.status === 410) dropShares(inst.id); // not sharing (or an older OurTube)
    return 0;
  }
  const listed = new Map(); // video id -> updated
  let complete = false;
  for (let n = 0; page && n < 100 && listed.size < MAX_SHARED; n++) {
    for (const it of page.orderedItems || page.items || []) {
      const id = typeof it === 'string' ? it : idOf(it?.object);
      if (typeof id === 'string' && /^https?:\/\//.test(id) && hostOf(id) !== hostOf(inst.ap_actor)) listed.set(id, Date.parse(it?.updated || '') || 0);
    }
    const next = idOf(page.next);
    if (!next) {
      complete = true;
      break;
    }
    page = await apFetch(next, opts);
  }
  let received = 0;
  let fetched = 0;
  for (const [id, updated] of listed) {
    const row = db.prepare('SELECT instance_id, remote_id, updated_at FROM network_videos WHERE ap_id = ?').get(id);
    if (row && (!updated || updated <= row.updated_at)) {
      recordShare(row.instance_id, row.remote_id, inst.id);
      continue;
    }
    if (fetched++ >= NEW_SHARES_PER_ROUND) continue; // the rest next round
    try {
      const obj = await apFetch(id, { ...opts, timeout: 10000 });
      if (obj?.id === id && (await ingestVideo(obj, { source: 'share', via: inst.id }))) received++;
    } catch (e) {
      if (e.status === 404 || e.status === 410) listed.delete(id);
    }
  }
  if (complete) dropShares(inst.id, new Set(listed.keys()));
  return received;
}

/** Peers we know over protocol v3 move to ActivityPub once their own address says they speak it. */
async function upgradePeers({ force = false } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM instances WHERE is_self = 0 AND blocked = 0 AND protocol >= 3 AND (ap_actor IS NULL OR protocol < 4)
         AND (peer_status = 'approved' OR hub_status = 'approved') AND (last_hello_at IS NULL OR last_hello_at < ?)`,
    )
    .all(force ? now() : now() - 30 * 60_000);
  for (const inst of rows) {
    db.prepare('UPDATE instances SET last_hello_at = ? WHERE id = ?').run(now(), inst.id);
    // introduce() re-reads the descriptor and, for a protocol 4 peer, follows it.
    await introduce(inst.url, inst.source === 'admin' ? 'admin' : inst.source || 'peer').catch(() => {});
  }
}

const refreshing = new Map();
/** Re-reads a remote video from its origin when its page opens (at most once a minute). Returns true when updated. */
async function refreshVideo(row) {
  if (!row.ap_id || now() - (row.fetched_at || 0) < REFRESH_MS || refreshing.has(row.ap_id)) return false;
  refreshing.set(row.ap_id, now());
  try {
    const obj = await apFetch(row.ap_id, { signer: signer(), timeout: 3000 });
    return !!(await ingestVideo(obj));
  } catch (e) {
    if (e.status === 404 || e.status === 410) {
      db.prepare('DELETE FROM network_videos WHERE instance_id = ? AND remote_id = ?').run(row.instance_id, row.remote_id);
      return true;
    }
    return false;
  } finally {
    refreshing.delete(row.ap_id);
  }
}

// ---- whole comment threads ----------------------------------------------------------------------------

const threads = new Map(); // video ap id -> { at, items }
const PEERTUBE_VIDEO = /^(https?:\/\/[^/]+)\/videos\/watch\/([A-Za-z0-9-]{8,64})$/;

/**
 * The full comment thread of a remote video, as notes. An OurTube peer (protocol 4) serves its comments
 * collection with the notes embedded. PeerTube only delivers comments made after someone here followed, so
 * its thread comes from its comments API. Cached for a few seconds (a minute for PeerTube, which takes more
 * requests). Returns null when it can't be read.
 */
export async function remoteThread(row) {
  if (!row.ap_id) return null;
  const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(row.instance_id);
  const ourTube = !!inst?.ap_actor && (inst.protocol || 0) >= 4;
  const peerTube = ourTube ? null : PEERTUBE_VIDEO.exec(row.ap_id);
  if (!ourTube && !peerTube) return null;
  const hit = threads.get(row.ap_id);
  if (hit && now() - hit.at < (ourTube ? 5000 : 60_000)) return hit.items;
  try {
    const items = ourTube
      ? ((c) => c.orderedItems || c.items || [])(await apFetch(`${row.ap_id}/comments?embed=1`, { signer: signer(), timeout: 5000 }))
      : await peerTubeThread(row, peerTube[1], peerTube[2]);
    const notes = items.filter((n) => n && typeof n === 'object' && typeof n.id === 'string');
    threads.set(row.ap_id, { at: now(), items: notes });
    return notes;
  } catch {
    if (peerTube) threads.set(row.ap_id, { at: now(), items: hit?.items || null }); // not PeerTube after all, or down: ask again later
    return hit?.items || null;
  }
}
export const forgetThread = (apId) => threads.delete(apId);

/**
 * A PeerTube video's comments from its API: up to 200 threads, and the replies of the 30 newest that have
 * any. Replies hang off their thread's first comment, the one level of replies OurTube shows.
 */
async function peerTubeThread(row, origin, uuid) {
  const api = `${origin}/api/v1/videos/${uuid}/comment-threads`;
  const get = (url) => apFetch(url, { accept: 'application/json', timeout: 5000 });
  const roots = [];
  for (let start = 0; start < 200; start += 100) {
    const page = await get(`${api}?start=${start}&count=100&sort=-createdAt`);
    if (!Array.isArray(page.data)) throw new Error('not a PeerTube comment list');
    roots.push(...page.data);
    if (!page.data.length || roots.length >= (Number(page.total) || 0)) break;
  }
  const replies = new Map(); // thread id -> its replies, flattened
  const busy = roots.filter((c) => c.totalReplies > 0).slice(0, 30);
  for (let i = 0; i < busy.length; i += 6) {
    await Promise.all(
      busy.slice(i, i + 6).map(async (c) => {
        const flat = [];
        const walk = (nodes) => {
          for (const n of Array.isArray(nodes) ? nodes : []) {
            if (n?.comment) flat.push(n.comment);
            walk(n?.children);
          }
        };
        walk((await get(`${api}/${c.id}`).catch(() => null))?.children);
        replies.set(c.id, flat);
      }),
    );
  }
  const owner = row.ap_actor ? db.prepare('SELECT attributed_to FROM ap_actors WHERE id = ?').get(row.ap_actor)?.attributed_to : null;
  const notes = [];
  for (const root of roots) {
    const kids = (replies.get(root.id) || []).filter((k) => !k.isDeleted);
    if (root.isDeleted && !kids.length) continue;
    notes.push(peerTubeNote(root, row.ap_id, origin, owner));
    for (const k of kids) notes.push(peerTubeNote(k, root.url, origin, owner));
  }
  return notes;
}

const chapterCache = new Map(); // video ap id -> { at, chapters }
/** A PeerTube video's chapters ([{ start, title }], seconds), from its API. Cached ten minutes; [] elsewhere. */
export async function remoteChapters(row) {
  const pt = row.ap_id && PEERTUBE_VIDEO.exec(row.ap_id);
  if (!pt) return [];
  const hit = chapterCache.get(row.ap_id);
  if (hit && now() - hit.at < 600_000) return hit.chapters;
  let chapters = hit?.chapters || [];
  try {
    const r = await apFetch(`${pt[1]}/api/v1/videos/${pt[2]}/chapters`, { accept: 'application/json', timeout: 4000 });
    chapters = (Array.isArray(r.chapters) ? r.chapters : [])
      .filter((c) => Number.isFinite(Number(c?.timecode)) && typeof c.title === 'string')
      .map((c) => ({ start: Math.max(0, Number(c.timecode)), title: c.title.slice(0, 100) }))
      .sort((a, b) => a.start - b.start);
  } catch {}
  chapterCache.set(row.ap_id, { at: now(), chapters });
  return chapters;
}

/** A comment from PeerTube's API as a note, replying to the video or to its thread's first comment. */
function peerTubeNote(c, inReplyTo, origin, owner) {
  const a = c.account || {};
  const avatars = [...(Array.isArray(a.avatars) ? a.avatars : []), ...(a.avatar ? [a.avatar] : [])].sort((x, y) => (x.width || 0) - (y.width || 0));
  const avatar = avatars.find((x) => x.width >= 100) || avatars.at(-1);
  const icon = avatar ? avatar.fileUrl || (avatar.path ? origin + avatar.path : null) : null;
  return {
    id: c.url,
    type: 'Note',
    content: c.isDeleted ? 'This comment was deleted.' : c.text || '',
    published: c.createdAt,
    inReplyTo,
    isUploader: !!owner && a.url === owner,
    attributedTo: c.isDeleted
      ? { id: null, name: 'Deleted' }
      : { id: a.url, preferredUsername: a.name, name: a.displayName || a.name, host: a.host, icon: icon ? { url: icon } : null, url: a.url },
  };
}

export { isNetworkPeer };

/**
 * Re-reads the profiles of the channels whose videos are shown here, oldest copy first, so their pictures and
 * names stay current even when their server doesn't send its changes.
 */
async function refreshChannels({ maxAge = 12 * 3600_000 } = {}) {
  const stale = db
    .prepare(
      `SELECT DISTINCT v.ap_actor AS id, a.fetched_at FROM network_videos v LEFT JOIN ap_actors a ON a.id = v.ap_actor
       WHERE v.ap_actor IS NOT NULL AND (a.fetched_at IS NULL OR a.fetched_at <= ?) ORDER BY a.fetched_at LIMIT 100`,
    )
    .all(now() - maxAge);
  for (const { id } of stale) await getActor(id, { refresh: true }).catch(() => {});
}

useApTransport({ follow, answerFollow, unpeer, reconcile, upgradePeers, refreshVideo, refreshChannels, cleanShares });
