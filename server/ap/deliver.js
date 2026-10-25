/**
 * Outgoing ActivityPub: activities for local videos (Create, Announce, Update, Delete), comments, follows,
 * likes and reports, delivered through the job queue with retries over several days.
 */
import { db } from '../db.js';
import { now } from '../util.js';
import { defineJob, enqueueJob, PermanentError } from '../jobs.js';
import { apFetch } from './http.js';
import { CONTEXT, PUBLIC, apBase, apEnabled, urls } from './common.js';
import { instanceKeys, userKeys } from './keys.js';
import { getActor, inboxesOf, isBlockedActor } from './actors.js';
import { VIDEO_FEDERATED, commentApId, loadVideoForAp, noteJson, videoJson } from './objects.js';

/** The key a local actor signs with. localActor: u:<user id>, c:<user id> or i. */
export function signerFor(localActor, base = apBase()) {
  if (localActor === 'i') return { keyId: `${urls(base).instance()}#main-key`, privateKey: instanceKeys().privateKey };
  const [kind, userId] = localActor.split(':');
  const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!u) throw new PermanentError('That account is gone');
  const id = kind === 'c' ? urls(base).group(u.username) : urls(base).person(u.username);
  return { keyId: `${id}#main-key`, privateKey: userKeys(u.id).privateKey };
}

export const actorUri = (localActor, base = apBase()) => signerFor(localActor, base).keyId.replace(/#main-key$/, '');

const SCHEDULE = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3, 48 * 3600e3];

defineJob('ap.deliver', {
  lane: 'network',
  maxAttempts: SCHEDULE.length + 1,
  backoff: (attempts) => SCHEDULE[Math.min(SCHEDULE.length - 1, Math.max(0, attempts - 1))],
  handler: async ({ inbox, body, signer, key }) => {
    if (!apEnabled()) return;
    try {
      await apFetch(inbox, { method: 'POST', body, signer: key || signerFor(signer) });
    } catch (e) {
      // Their server refused it for good (bad request, gone, forbidden): don't keep trying.
      if (e.status >= 400 && e.status < 500 && ![408, 425, 429].includes(e.status)) throw new PermanentError(`${inbox}: ${e.message}`);
      throw e;
    }
  },
});

/**
 * Queues an activity for each inbox (one job per inbox, deduplicated). `key` carries the signing key
 * along when the account will be gone by the time the job runs (account deletion).
 */
export function deliver(localActor, activity, inboxes, { key = null } = {}) {
  if (!apEnabled() || !apBase()) return 0;
  const body = JSON.stringify(activity);
  let n = 0;
  for (const inbox of new Set(inboxes.filter(Boolean))) {
    if (enqueueJob('ap.deliver', { inbox, body, signer: localActor, ...(key ? { key } : {}) }, { dedupe: `ap:${activity.id}:${inbox}` })) n++;
  }
  return n;
}

/** An account is being deleted: tell everyone following its account or channel. */
export function sendActorDelete(user) {
  const base = apBase();
  if (!base || !apEnabled()) return;
  const u = urls(base);
  const targets = inboxesOf(followersOf([`u:${user.id}`, `c:${user.id}`]));
  if (!targets.length) return;
  for (const kind of ['u', 'c']) {
    const key = signerFor(`${kind}:${user.id}`, base);
    const id = key.keyId.replace(/#main-key$/, '');
    deliver(`${kind}:${user.id}`, { '@context': CONTEXT, id: `${id}#delete`, type: 'Delete', actor: id, to: [PUBLIC], object: id }, targets, { key });
  }
}

/** Remote followers of the given local actors. */
export function followersOf(localActors) {
  const marks = localActors.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT remote_actor FROM ap_followers WHERE local_actor IN (${marks})`).all(...localActors).map((r) => r.remote_actor).filter((a) => !isBlockedActor(a));
}

// ---- videos -------------------------------------------------------------------------------------------

/** Brings the fediverse up to date with a local video: Create (first time), Update, or Delete. */
export function apVideoChanged(videoId) {
  if (!apEnabled()) return;
  enqueueJob('ap.video', { id: videoId }, { dedupe: `ap-video:${videoId}` });
}

defineJob('ap.video', {
  lane: 'network',
  handler: ({ id }) => {
    const base = apBase();
    if (!base) return;
    const v = loadVideoForAp(id);
    if (!v) return;
    const owner = v.user_id;
    const audience = followersOf([`u:${owner}`, `c:${owner}`]);
    const instanceAudience = followersOf(['i']);
    const federated = !!db.prepare(`SELECT 1 FROM videos v WHERE v.id = ? AND ${VIDEO_FEDERATED}`).get(id);
    const u = urls(base);
    const person = u.person(v.username);
    if (federated) {
      const video = videoJson(v, base);
      delete video['@context'];
      if (!v.ap_published_at) {
        deliver(`u:${owner}`, { '@context': CONTEXT, id: u.activity(), type: 'Create', actor: person, to: video.to, cc: video.cc, published: video.published, object: video }, inboxesOf(audience));
        // Channel followers and instance followers (PeerTube mirrors, Mastodon) also get an Announce.
        deliver(`c:${owner}`, { '@context': CONTEXT, id: u.activity(), type: 'Announce', actor: u.group(v.username), to: [PUBLIC, `${u.group(v.username)}/followers`], object: video.id }, inboxesOf(followersOf([`c:${owner}`])));
        deliver('i', { '@context': CONTEXT, id: u.activity(), type: 'Announce', actor: u.instance(), to: [PUBLIC, `${u.instance()}/followers`], object: video.id }, inboxesOf(instanceAudience));
        db.prepare('UPDATE videos SET ap_published_at = ? WHERE id = ?').run(now(), id);
      } else {
        deliver(`u:${owner}`, { '@context': CONTEXT, id: u.activity(), type: 'Update', actor: person, to: video.to, cc: video.cc, object: video }, inboxesOf([...audience, ...instanceAudience]));
      }
    } else if (v.ap_published_at) {
      sendVideoDelete({ id: v.id, user_id: owner, username: v.username, ap_published_at: v.ap_published_at });
      db.prepare('UPDATE videos SET ap_published_at = NULL WHERE id = ?').run(id);
    }
  },
});

/** Tells followers a video is gone. Works after the row was deleted (pass what was known). */
export function sendVideoDelete(v) {
  const base = apBase();
  if (!base || !v.ap_published_at) return;
  const u = urls(base);
  const targets = inboxesOf([...followersOf([`u:${v.user_id}`, `c:${v.user_id}`]), ...followersOf(['i'])]);
  deliver(`u:${v.user_id}`, { '@context': CONTEXT, id: u.activity(), type: 'Delete', actor: u.person(v.username), to: [PUBLIC], object: { id: u.video(v.id), type: 'Tombstone' } }, targets);
}

// ---- comments -------------------------------------------------------------------------------------------

/** A local person commented on a local video: the video's followers (and a remote parent author) get it. */
export function apCommentCreated(commentId) {
  if (!apEnabled()) return;
  enqueueJob('ap.comment', { id: commentId }, { dedupe: `ap-comment:${commentId}` });
}

defineJob('ap.comment', {
  lane: 'network',
  handler: async ({ id }) => {
    const base = apBase();
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    if (!base || !c || c.ap_id || c.status !== 'visible') return; // fediverse comments are already out there
    const author = db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id);
    const v = db.prepare(`SELECT v.* FROM videos v WHERE v.id = ? AND ${VIDEO_FEDERATED}`).get(c.video_id);
    if (!author || author.remote_instance_id || !v) return;
    const note = noteJson(c, base);
    delete note['@context'];
    const targets = followersOf([`u:${v.user_id}`, `c:${v.user_id}`]);
    if (c.parent_id) {
      const parent = db.prepare('SELECT u.ap_actor FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(c.parent_id);
      if (parent?.ap_actor) {
        targets.push(parent.ap_actor);
        note.cc.push(parent.ap_actor);
      }
    }
    deliver(`u:${author.id}`, { '@context': CONTEXT, id: urls(base).activity(), type: 'Create', actor: note.attributedTo, to: note.to, cc: note.cc, object: note }, inboxesOf(targets));
  },
});

export function sendCommentDelete(c, authorUsername, videoOwnerId) {
  const base = apBase();
  if (!base || !apEnabled() || c.ap_id) return;
  const u = urls(base);
  deliver(`u:${c.user_id}`, { '@context': CONTEXT, id: u.activity(), type: 'Delete', actor: u.person(authorUsername), to: [PUBLIC], object: { id: u.comment(c.id), type: 'Tombstone' } },
    inboxesOf(followersOf([`u:${videoOwnerId}`, `c:${videoOwnerId}`])));
}

// ---- follows, likes, notes and flags towards remote actors --------------------------------------------

export async function sendFollow(localActor, remoteActorId) {
  const base = apBase();
  const actor = await getActor(remoteActorId);
  const followId = urls(base).activity();
  db.prepare(
    `INSERT INTO ap_follows (local_actor, remote_actor, follow_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT(local_actor, remote_actor) DO UPDATE SET follow_id = excluded.follow_id, status = CASE WHEN ap_follows.status = 'accepted' THEN 'accepted' ELSE 'pending' END`,
  ).run(localActor, actor.id, followId, now());
  deliver(localActor, { '@context': CONTEXT, id: followId, type: 'Follow', actor: actorUri(localActor, base), object: actor.id }, [actor.inbox]);
  return actor;
}

export async function sendUnfollow(localActor, remoteActorId) {
  const base = apBase();
  const f = db.prepare('SELECT * FROM ap_follows WHERE local_actor = ? AND remote_actor = ?').get(localActor, remoteActorId);
  if (!f) return;
  db.prepare('DELETE FROM ap_follows WHERE local_actor = ? AND remote_actor = ?').run(localActor, remoteActorId);
  const actor = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(remoteActorId);
  if (!actor) return;
  const me = actorUri(localActor, base);
  deliver(localActor, { '@context': CONTEXT, id: urls(base).activity(), type: 'Undo', actor: me, object: { id: f.follow_id, type: 'Follow', actor: me, object: remoteActorId } }, [actor.inbox]);
}

/** Sends any activity from a local actor to the given remote actors' inboxes. */
export function sendTo(localActor, activity, actorIds) {
  return deliver(localActor, { '@context': CONTEXT, id: urls(apBase()).activity(), ...activity }, inboxesOf(actorIds));
}

/** Answers a follow request. */
export function sendAcceptOrReject(localActor, followActivity, remoteActor, accept = true) {
  const base = apBase();
  deliver(localActor, { '@context': CONTEXT, id: urls(base).activity(), type: accept ? 'Accept' : 'Reject', actor: actorUri(localActor, base), object: followActivity }, [remoteActor.inbox]);
}

export { commentApId };
