/**
 * Fediverse sharing: OurTube servers pass on to each other the videos they follow elsewhere in the fediverse
 * (PeerTube channels and servers), so the network's catalog grows with every server's follows. Each server opts
 * in on both sides: `fediverse_share_out` passes on what it follows, `fediverse_share_in` shows what its peers
 * pass on.
 *
 * - A sharing server lists those videos at /ap/actor/shared (see routes.js) and announces new ones to its peers.
 * - A taking server reads each peer's list every network round (ap/peering.js) and fetches every video from its
 *   own server, never from the peer. It notes who shares what (network_video_shares); a video that is here only
 *   because of shares (via_share = 1) leaves when no peer shares it any more.
 * - Only one hop: what a server took from its peers is not passed on again.
 */
import { db, getSettings } from '../db.js';
import { now, sha256 } from '../util.js';
import { PUBLIC, apBase, urls } from './common.js';
import { sendTo } from './deliver.js';

export const sharesOut = () => getSettings().fediverse_share_out === 'true';
export const sharesIn = () => getSettings().fediverse_share_in === 'true';

export const MAX_SHARED = 2000;
const RECENT_MS = 2 * 24 * 3600_000;

// Servers known through the OurTube network (protocol 2 and up; the fediverse is 0) share their own videos
// already; what is passed on is the rest.
const NETWORK_SERVER = `(COALESCE(p.protocol, 0) >= 2 OR p.ap_actor IS NOT NULL OR p.hub_status IS NOT NULL)`;
const SHARED_WHERE = `r.ap_id IS NOT NULL AND r.via_share = 0 AND r.hidden = 0 AND p.blocked = 0 AND NOT ${NETWORK_SERVER}`;

/** The fediverse videos this server follows, newest first, for its shared list. */
export function sharedVideos({ limit = 100, offset = 0 } = {}) {
  return db
    .prepare(`SELECT r.ap_id, r.created_at, r.updated_at FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${SHARED_WHERE} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
}
export function sharedCount() {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${SHARED_WHERE}`).get().n;
  return Math.min(n, MAX_SHARED);
}

/** A peer shares this video. */
export function recordShare(instanceId, remoteId, viaId) {
  db.prepare('INSERT OR IGNORE INTO network_video_shares (instance_id, remote_id, via_instance_id, created_at) VALUES (?, ?, ?, ?)').run(instanceId, remoteId, viaId, now());
}

/** Videos here only because of shares, that no peer shares any more, leave. */
export function pruneShared() {
  db.prepare(
    `DELETE FROM network_videos WHERE via_share = 1 AND NOT EXISTS
       (SELECT 1 FROM network_video_shares s WHERE s.instance_id = network_videos.instance_id AND s.remote_id = network_videos.remote_id)`,
  ).run();
}

/** A peer's shares, except the videos (by ActivityPub id) it still lists; `keep` null drops them all. */
export function dropShares(viaId, keep = null) {
  const rows = db
    .prepare('SELECT s.instance_id, s.remote_id, r.ap_id FROM network_video_shares s JOIN network_videos r ON r.instance_id = s.instance_id AND r.remote_id = s.remote_id WHERE s.via_instance_id = ?')
    .all(viaId);
  for (const r of rows) {
    if (!keep || !keep.has(r.ap_id)) db.prepare('DELETE FROM network_video_shares WHERE instance_id = ? AND remote_id = ? AND via_instance_id = ?').run(r.instance_id, r.remote_id, viaId);
  }
  pruneShared();
}

/** Each round: shares from servers that are no longer peers go, and all of them when this server stopped taking them. */
export function cleanShares() {
  if (!sharesIn()) db.prepare('DELETE FROM network_video_shares').run();
  else db.prepare('DELETE FROM network_video_shares WHERE via_instance_id IN (SELECT id FROM instances WHERE blocked = 1 OR ap_actor IS NULL)').run();
  pruneShared();
}

/** A fediverse video this server follows just arrived: peers hear of it now rather than at their next round. */
export function shareWithPeers(apId, publishedAt) {
  if (!sharesOut() || now() - (Number(publishedAt) || 0) > RECENT_MS) return;
  const peers = db
    .prepare("SELECT f.remote_actor FROM ap_followers f JOIN instances p ON p.ap_actor = f.remote_actor WHERE f.local_actor = 'i' AND p.blocked = 0")
    .all()
    .map((r) => r.remote_actor);
  if (!peers.length) return;
  const base = apBase();
  sendTo('i', { id: `${base}/ap/actor/shared/${sha256(apId).slice(0, 24)}`, type: 'Announce', actor: urls(base).instance(), to: [PUBLIC], object: apId }, peers);
}
