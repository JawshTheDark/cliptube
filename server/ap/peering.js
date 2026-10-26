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
      if (await ingestVideo(await apFetch(id, opts))) received++;
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
  return { received };
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

// ---- whole comment threads from OurTube peers ---------------------------------------------------------

const threads = new Map(); // video ap id -> { at, items }
/**
 * The full comment thread of a video on an OurTube peer (protocol 4), from its comments collection with
 * the notes embedded. Cached for a few seconds. Returns null when it can't be read.
 */
export async function remoteThread(row) {
  const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(row.instance_id);
  if (!inst?.ap_actor || (inst.protocol || 0) < 4 || !row.ap_id) return null;
  const hit = threads.get(row.ap_id);
  if (hit && now() - hit.at < 5000) return hit.items;
  try {
    const c = await apFetch(`${row.ap_id}/comments?embed=1`, { signer: signer(), timeout: 5000 });
    const items = (c.orderedItems || c.items || []).filter((n) => n && typeof n === 'object' && typeof n.id === 'string');
    threads.set(row.ap_id, { at: now(), items });
    return items;
  } catch {
    return hit?.items || null;
  }
}
export const forgetThread = (apId) => threads.delete(apId);

export { isNetworkPeer };

useApTransport({ follow, answerFollow, unpeer, reconcile, upgradePeers, refreshVideo });
