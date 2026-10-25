/**
 * Incoming ActivityPub activities, processed through the job queue after the HTTP signature was checked.
 * Follows of local actors are accepted (subscriptions), comments land in the thread through the same
 * spam checks as local ones, likes and dislikes count, and videos from followed channels or instances go
 * into the network index next to ClipTube peers' videos.
 */
import crypto from 'node:crypto';
import { db, getSettings } from '../db.js';
import { newId, now, str } from '../util.js';
import { defineJob, enqueueJob } from '../jobs.js';
import { intakeComment, intakeLike } from '../intake.js';
import { REPORT_REASONS, createReport } from '../reports.js';
import { notifyComment } from '../notify.js';
import { indexNetworkVideo } from '../search.js';
import { acceptsFromNetwork, isNetworkPeer, peerFollowAnswered, peerFollowReceived, upsertNetworkVideo } from '../network.js';
import { apFetch } from './http.js';
import { PUBLIC, apBase, first, hostOf, htmlToText, idOf, originOf, parseDuration, parseLocal } from './common.js';
import { getActor, instanceFor, isBlockedActor, shadowUser, signer, storeActor } from './actors.js';
import { sendAcceptOrReject, sendVerdict } from './deliver.js';
import { followMove } from './move.js';

/**
 * What this instance accepts from the sender's server: its own switches, plus the network's for other
 * ClipTube instances in the network (the hub's switches cover traffic between members).
 */
const accepts = (actorId) => {
  const inst = actorId ? db.prepare('SELECT * FROM instances WHERE url = ?').get(originOf(actorId)) : null;
  if (inst && isNetworkPeer(inst)) return acceptsFromNetwork();
  const s = getSettings();
  return { comments: s.network_accept_comments === 'true', likes: s.network_accept_likes === 'true', subscriptions: s.network_accept_subscriptions === 'true' };
};

/** A ClipTube peer on protocol 4, which expects an answer to each comment (Accept or Reject). */
const wantsVerdict = (actorId) => {
  const inst = db.prepare('SELECT ap_actor, protocol FROM instances WHERE url = ?').get(originOf(actorId));
  return !!inst?.ap_actor && (inst.protocol || 0) >= 4;
};

/** Queues an activity whose signature was checked. */
export function receive(activity, actorId) {
  const id = String(activity.id || crypto.randomUUID());
  enqueueJob('ap.inbox', { activity, actorId }, { dedupe: `ap-in:${id}` });
}

defineJob('ap.inbox', {
  lane: 'network',
  maxAttempts: 3,
  handler: async ({ activity, actorId }) => {
    if (activity.id) {
      const r = db.prepare('INSERT OR IGNORE INTO ap_seen (id, seen_at) VALUES (?, ?)').run(String(activity.id), now());
      if (!r.changes) return; // already handled
    }
    await handle(activity, actorId);
  },
});

defineJob('ap.seen.cleanup', {
  handler: () => {
    db.prepare('DELETE FROM ap_seen WHERE seen_at < ?').run(now() - 14 * 86400_000);
    enqueueJob('ap.seen.cleanup', {}, { delay: 24 * 3600_000, dedupe: 'ap-seen-cleanup' });
  },
});
export const startApCleanup = () => enqueueJob('ap.seen.cleanup', {}, { delay: 3600_000, dedupe: 'ap-seen-cleanup' });

/** The local actor a URI points at: { key: u:<id>|c:<id>|i, user } or null. */
function localActorOf(uri, base) {
  const p = parseLocal(idOf(uri), base);
  if (!p) return null;
  if (p.kind === 'i') return { key: 'i', user: null };
  if (p.kind !== 'u' && p.kind !== 'c') return null;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(p.name);
  return user ? { key: `${p.kind}:${user.id}`, user } : null;
}

/** An object that may be embedded or only referenced: fetched from its origin unless embedded by its own server. */
async function resolveObject(obj, actorId) {
  if (obj && typeof obj === 'object' && obj.id && hostOf(obj.id) === hostOf(actorId)) return obj;
  const id = idOf(obj);
  if (!id) return null;
  if (obj && typeof obj === 'object' && !obj.id) return null;
  return apFetch(id, { signer: signer() });
}

async function handle(a, actorId) {
  const base = apBase();
  const type = String(a.type || '');
  switch (type) {
    case 'Follow':
      return onFollow(a, actorId, base);
    case 'Undo':
      return onUndo(a, actorId, base);
    case 'Accept':
    case 'Reject':
      return onAnswer(a, actorId, base, type === 'Accept');
    case 'Create':
      return onCreate(a, actorId, base);
    case 'Announce':
      return onAnnounce(a, actorId, base);
    case 'Update':
      return onUpdate(a, actorId, base);
    case 'Delete':
      return onDelete(a, actorId, base);
    case 'Like':
    case 'Dislike':
    case 'EmojiReact':
      return type === 'EmojiReact' ? null : onLike(a, actorId, base, type === 'Like' ? 1 : -1);
    case 'Flag':
      return onFlag(a, actorId, base);
    case 'Move':
      return onMove(a, actorId);
    default:
      return null;
  }
}

/** An account people here follow moved: follow the new one if it confirms the move (see move.js). */
async function onMove(a, actorId) {
  const origin = idOf(a.object) || actorId;
  if (origin !== actorId) return; // only an account can move itself
  await followMove(origin, idOf(a.target));
}

/**
 * Mastodon starts a reply with @mentions of the people it answers. The thread shows that already, so
 * leading mentions that the note tags are dropped (unless nothing else is left).
 */
export function stripLeadingMentions(text, note) {
  const tags = Array.isArray(note?.tag) ? note.tag : note?.tag ? [note.tag] : [];
  const names = tags.filter((t) => t && t.type === 'Mention' && typeof t.name === 'string').map((t) => t.name.toLowerCase());
  if (!names.length) return text;
  let out = text;
  for (;;) {
    const m = /^@([\w.-]+?)(@[\w-]+(?:\.[\w-]+)+)?(?=[\s,:]|$)[\s,:]*/.exec(out);
    if (!m) break;
    const short = `@${m[1]}`.toLowerCase();
    const full = `${short}${(m[2] || '').toLowerCase()}`;
    if (!names.some((n) => n === full || n === short || n.startsWith(`${short}@`))) break;
    out = out.slice(m[0].length);
  }
  return out.trim() || text;
}

// ---- follows ------------------------------------------------------------------------------------------

async function onFollow(a, actorId, base) {
  const target = localActorOf(a.object, base);
  if (!target) return;
  const actor = await getActor(actorId);
  const follow = { id: a.id, type: 'Follow', actor: actorId, object: idOf(a.object) };
  // Another server following this one: peering (ClipTube) or mirroring (PeerTube), under the admission switches.
  if (target.key === 'i') {
    const decision = await peerFollowReceived(actor, a.id);
    if (decision === 'pending') return;
    if (decision === 'reject') return sendAcceptOrReject('i', follow, actor, false);
  } else if (!accepts(actorId).subscriptions) return sendAcceptOrReject(target.key, follow, actor, false);
  db.prepare(
    'INSERT INTO ap_followers (local_actor, remote_actor, follow_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(local_actor, remote_actor) DO UPDATE SET follow_id = excluded.follow_id',
  ).run(target.key, actorId, a.id || null, now());
  if (target.user) {
    const shadow = shadowUser(actor);
    db.prepare('INSERT OR IGNORE INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)').run(shadow.id, target.user.id, now());
  }
  sendAcceptOrReject(target.key, follow, actor, true);
}

async function onUndo(a, actorId, base) {
  const o = a.object;
  const inner = typeof o === 'object' && o ? o : db.prepare('SELECT * FROM ap_followers WHERE follow_id = ?').get(idOf(o)) ? { type: 'Follow', id: idOf(o) } : null;
  if (!inner) return;
  if (inner.type === 'Follow') {
    const rows = inner.object
      ? [localActorOf(inner.object, base)].filter(Boolean).map((t) => t.key)
      : db.prepare('SELECT local_actor FROM ap_followers WHERE follow_id = ? AND remote_actor = ?').all(inner.id, actorId).map((r) => r.local_actor);
    for (const key of rows) {
      db.prepare('DELETE FROM ap_followers WHERE local_actor = ? AND remote_actor = ?').run(key, actorId);
      const shadow = db.prepare('SELECT user_id FROM ap_actors WHERE id = ?').get(actorId)?.user_id;
      const userId = key.includes(':') ? key.split(':')[1] : null;
      // Still following the other of the account's two actors keeps the subscription.
      if (shadow && userId && !db.prepare("SELECT 1 FROM ap_followers WHERE remote_actor = ? AND local_actor IN (?, ?)").get(actorId, `u:${userId}`, `c:${userId}`)) {
        db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').run(shadow, userId);
      }
    }
  } else if (inner.type === 'Like' || inner.type === 'Dislike') {
    const v = localVideo(inner.object, base);
    const shadow = db.prepare('SELECT user_id FROM ap_actors WHERE id = ?').get(actorId)?.user_id;
    if (v && shadow) db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(shadow, v.id);
  } else if (inner.type === 'Announce') {
    const v = localVideo(inner.object, base);
    if (v) db.prepare('UPDATE videos SET ap_shares = MAX(0, ap_shares - 1) WHERE id = ?').run(v.id);
  }
}

async function onAnswer(a, actorId, base, accepted) {
  const o = a.object;
  const followId = idOf(o);
  let f = followId && db.prepare('SELECT * FROM ap_follows WHERE follow_id = ? AND remote_actor = ?').get(followId, actorId);
  if (!f && o && typeof o === 'object' && o.actor) {
    const me = localActorOf(o.actor, base);
    if (me) f = db.prepare('SELECT * FROM ap_follows WHERE local_actor = ? AND remote_actor = ?').get(me.key, actorId);
  }
  if (!f) return onVerdict(o, actorId, accepted, a);
  db.prepare('UPDATE ap_follows SET status = ? WHERE local_actor = ? AND remote_actor = ?').run(accepted ? 'accepted' : 'rejected', f.local_actor, f.remote_actor);
  // Our instance following a ClipTube peer: that is the peering, and network.js keeps track of it.
  if (f.local_actor === 'i' && db.prepare('SELECT 1 FROM instances WHERE ap_actor = ?').get(actorId)) return peerFollowAnswered(actorId, accepted);
  if (accepted) enqueueJob('ap.backfill', { actor: actorId }, { dedupe: `ap-backfill:${actorId}` });
}

/**
 * The server hosting a video answers a comment someone here sent: Accept once it shows the comment
 * (right away, or when its owner approves a held one), Reject when it refuses it.
 */
function onVerdict(o, actorId, accepted, a) {
  const noteId = idOf(o);
  if (!noteId) return;
  const c = db.prepare('SELECT n.*, r.ap_id AS video_ap_id FROM network_comments n LEFT JOIN network_videos r ON r.instance_id = n.instance_id AND r.remote_id = n.remote_id WHERE n.ap_id = ?').get(noteId);
  if (!c || !c.video_ap_id || hostOf(c.video_ap_id) !== hostOf(actorId)) return; // only the video's own server decides
  const reason = accepted ? null : str(htmlToText(a.summary || a.content || ''), 200).trim() || null;
  db.prepare('UPDATE network_comments SET status = ?, status_reason = ? WHERE id = ?').run(accepted ? 'visible' : 'rejected', reason, c.id);
}

/** Is any local actor following this remote actor (or the instance actor following its server)? */
function followed(actorId) {
  return !!db.prepare("SELECT 1 FROM ap_follows WHERE remote_actor = ? AND status = 'accepted'").get(actorId);
}
function followedServer(actorId) {
  return !!db
    .prepare("SELECT 1 FROM ap_follows f JOIN ap_actors a ON a.id = f.remote_actor WHERE f.status = 'accepted' AND f.local_actor = 'i' AND a.domain = ?")
    .get(hostOf(actorId));
}

// ---- videos from the fediverse ----------------------------------------------------------------------------

function bestMp4(links) {
  const mp4 = links.filter((l) => l && l.type === 'Link' && /^video\/mp4/.test(l.mediaType || '') && typeof l.href === 'string' && /^https?:/.test(l.href));
  if (!mp4.length) return null;
  const ranked = [...mp4].sort((x, y) => (Number(y.height) || 0) - (Number(x.height) || 0));
  return ranked.find((l) => (Number(l.height) || 0) <= 1080) || ranked[ranked.length - 1];
}

/** Puts a remote Video into the network index. Returns the network video key, or null if it doesn't qualify. */
export async function ingestVideo(obj) {
  if (!obj || obj.type !== 'Video' || typeof obj.id !== 'string') return null;
  const owners = (Array.isArray(obj.attributedTo) ? obj.attributedTo : [obj.attributedTo]).filter(Boolean);
  const channelId = idOf(owners.find((x) => typeof x === 'object' && x.type === 'Group') || owners[0]);
  if (!channelId || hostOf(channelId) !== hostOf(obj.id) || isBlockedActor(obj.id)) return null;
  if (!(Array.isArray(obj.to) ? obj.to : [obj.to]).concat(obj.cc || []).includes(PUBLIC)) return null; // public videos only
  const links = Array.isArray(obj.url) ? obj.url : obj.url ? [obj.url] : [];
  const mp4 = bestMp4(links);
  const hls = links.find((l) => l && l.mediaType === 'application/x-mpegURL' && typeof l.href === 'string' && /\.m3u8(\?|$)/.test(l.href));
  if (!mp4 && !hls) return null;
  const channel = await getActor(channelId);
  const inst = instanceFor(obj.id);
  const html = links.find((l) => l && l.mediaType === 'text/html')?.href || obj.id;
  const icons = (Array.isArray(obj.icon) ? obj.icon : obj.icon ? [obj.icon] : []).filter((i) => i && idOf(i.url));
  const thumb = icons.sort((x, y) => (Number(y.width) || 0) - (Number(x.width) || 0))[0];
  // ClipTube videos keep their own id, so a video also known through the ClipTube network is one row.
  const clipTubeId = /\/ap\/videos\/([A-Za-z0-9_-]{4,40})$/.exec(new URL(obj.id).pathname)?.[1];
  const remoteId = clipTubeId || (typeof obj.uuid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(obj.uuid) ? obj.uuid : crypto.createHash('sha256').update(obj.id).digest('base64url').slice(0, 22));
  const game = obj.game && typeof obj.game === 'object' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(String(obj.game.slug || '')) ? obj.game : null;
  const tags = (Array.isArray(obj.tag) ? obj.tag : [])
    .filter((t) => t?.type === 'Hashtag' && t.name)
    .map((t) => String(t.name).replace(/^#/, '').toLowerCase().slice(0, 30))
    .slice(0, 15);
  const published = Date.parse(obj.published) || now();
  const item = {
    remote_id: remoteId,
    title: str(obj.name, 120).trim() || 'Untitled',
    description: str(obj.mediaType === 'text/markdown' ? obj.content : htmlToText(obj.content), 5000),
    tags: tags.join(','),
    duration: parseDuration(obj.duration),
    width: Math.round(Number(mp4?.width) || 0) || Math.round((Number(mp4?.height) || 0) * (Number(obj.aspectRatio) || 16 / 9)),
    height: Math.round(Number(mp4?.height) || 0),
    views: Math.max(0, Math.round(Number(obj.views) || 0)),
    // ClipTube sends its counts (the `counts` extension); others may embed a collection with totalItems.
    likes: Number.isFinite(Number(obj.counts?.likes))
      ? Math.max(0, Math.round(Number(obj.counts.likes)))
      : typeof obj.likes === 'number'
        ? obj.likes
        : Number(obj.likes?.totalItems) || 0,
    created_at: published,
    updated_at: Date.parse(obj.updated) || published,
    thumbnail_url: thumb ? idOf(thumb.url) : null,
    video_url: mp4?.href || hls.href,
    watch_url: html,
    uploader_username: channel.username,
    uploader_display_name: channel.name || channel.username,
    uploader_avatar_url: channel.icon_url,
    uploader_url: channel.url || channel.id,
    game_slug: game ? game.slug : null,
    game_name: game ? str(game.name, 80).trim() || game.slug : null,
  };
  upsertNetworkVideo(inst.id, item, now(), inst.url);
  db.prepare(
    `UPDATE network_videos SET ap_id = ?, origin_type = 'activitypub', hls_url = ?, ap_actor = ?, comments_enabled = ?
     WHERE instance_id = ? AND remote_id = ?`,
  ).run(obj.id, hls?.href || null, channel.id, obj.commentsEnabled === false || obj.commentsPolicy === 2 ? 0 : 1, inst.id, remoteId);
  indexNetworkVideo(inst.id, remoteId);
  return { instanceId: inst.id, remoteId };
}

defineJob('ap.backfill', {
  lane: 'network',
  maxAttempts: 3,
  handler: async ({ actor }) => {
    const a = await getActor(actor, { refresh: true });
    if (!a.outbox) return;
    const box = await apFetch(a.outbox, { signer: signer() });
    let page = box.orderedItems || box.items ? box : box.first ? (typeof box.first === 'object' ? box.first : await apFetch(box.first, { signer: signer() })) : null;
    let seen = 0;
    for (let n = 0; page && n < 3 && seen < 50; n++) {
      for (const it of page.orderedItems || page.items || []) {
        if (seen >= 50) break;
        const act = typeof it === 'string' ? null : it;
        const obj = act && (act.type === 'Create' || act.type === 'Announce') ? act.object : act;
        try {
          const video = await resolveObject(obj, a.id);
          if (video?.type === 'Video' && (await ingestVideo(video))) seen++;
        } catch {}
      }
      page = page.next ? await apFetch(idOf(page.next), { signer: signer() }).catch(() => null) : null;
    }
    if (seen) console.log(`[ap] imported ${seen} video(s) from ${a.id}`);
  },
});

// ---- creates, announces, updates, deletes -------------------------------------------------------------

function localVideo(uri, base) {
  const p = parseLocal(idOf(uri), base);
  return p?.kind === 'video' ? db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id) : null;
}

async function onCreate(a, actorId, base) {
  const obj = await resolveObject(a.object, actorId);
  if (!obj) return;
  if (obj.type === 'Video') {
    // PeerTube posts as the account; people usually follow the channel. Either counts.
    const owners = (Array.isArray(obj.attributedTo) ? obj.attributedTo : [obj.attributedTo]).map(idOf).filter(Boolean);
    if (followed(actorId) || owners.some(followed) || followedServer(actorId)) await ingestVideo(obj);
    return;
  }
  if (obj.type === 'Note' || obj.type === 'Comment') return onNote(obj, actorId, base);
}

/** A reply: to a local video or comment, or to a fediverse video we index. */
async function onNote(note, actorId, base) {
  if (typeof note.id !== 'string' || hostOf(note.id) !== hostOf(actorId)) return;
  const authorId = idOf(note.attributedTo) || actorId;
  if (originOf(authorId) !== originOf(actorId)) return;
  const replyTo = idOf(note.inReplyTo);
  if (!replyTo) return;
  const body = str(stripLeadingMentions(htmlToText(note.content).trim(), note), 2000).trim();
  if (!body) return;
  const actor = await getActor(authorId);
  const author = shadowUser(actor);
  if (author.status !== 'active') return; // a silenced or suspended remote account

  // On a local video, directly or as a reply to one of its comments.
  let video = localVideo(replyTo, base);
  let parentId = null;
  if (!video) {
    const p = parseLocal(replyTo, base);
    const parent = p?.kind === 'comment' ? db.prepare('SELECT * FROM comments WHERE id = ?').get(p.id) : db.prepare('SELECT * FROM comments WHERE ap_id = ?').get(replyTo);
    if (parent) {
      video = db.prepare('SELECT * FROM videos WHERE id = ?').get(parent.video_id);
      parentId = parent.parent_id || parent.id;
    }
  }
  if (video) {
    const verdictTo = wantsVerdict(actor.id) ? actor : null;
    const refuse = (reason) => verdictTo && sendVerdict(`u:${video.user_id}`, note.id, verdictTo, false, reason);
    if (!accepts(actor.id).comments || video.visibility === 'private') return refuse('Comments from other instances are turned off here');
    if (db.prepare('SELECT 1 FROM comments WHERE ap_id = ?').get(note.id)) return;
    const inst = instanceFor(actor.id);
    const verdict = intakeComment({ video, author, body, parentId, remote: true, instance: inst });
    if (verdict.status === 'rejected') return refuse(verdict.reason || 'Not accepted');
    const id = newId();
    db.prepare('INSERT INTO comments (id, video_id, user_id, parent_id, body, status, held_reason, ap_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, video.id, author.id, parentId, body, verdict.status, verdict.status === 'held' ? verdict.reason : null, note.id, Date.parse(note.published) || now(),
    );
    if (verdict.status === 'visible') {
      notifyComment(id);
      if (verdictTo) sendVerdict(`u:${video.user_id}`, note.id, verdictTo, true);
    }
    // A held comment gets its Accept when the owner approves it (or a Reject when it is deleted instead).
    return;
  }
  // On a fediverse video in our index (or a reply in its thread).
  let nv = db.prepare('SELECT instance_id, remote_id FROM network_videos WHERE ap_id = ?').get(replyTo);
  let parent = null;
  if (!nv) {
    parent = db.prepare('SELECT * FROM network_comments WHERE ap_id = ?').get(replyTo);
    if (parent) nv = { instance_id: parent.instance_id, remote_id: parent.remote_id };
  }
  if (!nv) return;
  db.prepare(
    'INSERT OR IGNORE INTO network_comments (id, instance_id, remote_id, ap_id, in_reply_to, parent_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(newId(), nv.instance_id, nv.remote_id, note.id, replyTo, parent ? parent.parent_id || parent.id : null, author.id, body, Date.parse(note.published) || now());
}

async function onAnnounce(a, actorId, base) {
  const target = idOf(a.object);
  const v = localVideo(target, base);
  if (v) {
    db.prepare('UPDATE videos SET ap_shares = ap_shares + 1 WHERE id = ?').run(v.id);
    return;
  }
  // Channels and instances we follow announce their videos (PeerTube does this for every upload).
  if (!(followed(actorId) || followedServer(actorId))) return;
  const obj = await resolveObject(a.object, actorId).catch(() => null);
  if (obj?.type === 'Video') await ingestVideo(obj);
}

async function onUpdate(a, actorId, base) {
  const o = a.object;
  if (!o || typeof o !== 'object') return;
  if (['Person', 'Group', 'Application', 'Service', 'Organization'].includes(o.type)) {
    if (o.id === actorId) storeActor(o, actorId);
    return;
  }
  if (o.type === 'Video' && hostOf(o.id) === hostOf(actorId) && db.prepare('SELECT 1 FROM network_videos WHERE ap_id = ?').get(o.id)) {
    await ingestVideo(o);
    return;
  }
  if ((o.type === 'Note' || o.type === 'Comment') && hostOf(o.id) === hostOf(actorId)) {
    const body = str(stripLeadingMentions(htmlToText(o.content).trim(), o), 2000).trim();
    if (!body) return;
    db.prepare('UPDATE comments SET body = ? WHERE ap_id = ?').run(body, o.id);
    db.prepare('UPDATE network_comments SET body = ? WHERE ap_id = ?').run(body, o.id);
  }
}

async function onDelete(a, actorId, base) {
  const target = idOf(a.object);
  if (!target) return;
  if (target === actorId) {
    // The account itself was deleted: drop everything it did here.
    const row = db.prepare('SELECT * FROM ap_actors WHERE id = ?').get(actorId);
    if (row?.user_id) db.prepare('DELETE FROM users WHERE id = ?').run(row.user_id);
    db.prepare('DELETE FROM ap_followers WHERE remote_actor = ?').run(actorId);
    db.prepare('DELETE FROM ap_follows WHERE remote_actor = ?').run(actorId);
    db.prepare('DELETE FROM network_videos WHERE ap_actor = ?').run(actorId);
    db.prepare('DELETE FROM ap_actors WHERE id = ?').run(actorId);
    return;
  }
  // A comment sent the v3 way lives here under our own id: its author can still delete it.
  const local = parseLocal(target, base);
  if (local?.kind === 'comment') {
    const actor = await getActor(actorId).catch(() => null);
    if (actor) db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(local.id, shadowUser(actor).id);
    return;
  }
  if (hostOf(target) !== hostOf(actorId)) return;
  db.prepare('DELETE FROM comments WHERE ap_id = ?').run(target);
  db.prepare('DELETE FROM network_comments WHERE ap_id = ?').run(target);
  db.prepare('DELETE FROM network_videos WHERE ap_id = ?').run(target);
}

async function onLike(a, actorId, base, value) {
  const v = localVideo(a.object, base);
  if (!v || !accepts(actorId).likes) return;
  const actor = await getActor(actorId);
  const shadow = shadowUser(actor);
  if (shadow.status !== 'active') return;
  const verdict = intakeLike({ video: v, author: shadow, value, remote: true, instance: instanceFor(actorId) });
  if (verdict.status === 'rejected') return;
  db.prepare(
    'INSERT INTO likes (user_id, video_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
  ).run(shadow.id, v.id, value, now());
}

async function onFlag(a, actorId, base) {
  const inst = instanceFor(actorId);
  const objects = (Array.isArray(a.object) ? a.object : [a.object]).map(idOf).filter(Boolean);
  const details = str(a.content || a.summary, 2000);
  const reporter = `${hostOf(actorId)} (${isNetworkPeer(inst) ? 'network' : 'fediverse'})`;
  // ClipTube sends the reason as its own field; anyone else's report counts as "other".
  const reason = typeof a.reason === 'string' && REPORT_REASONS[a.reason] ? a.reason : 'other';
  for (const o of objects) {
    const p = parseLocal(o, base);
    if (p?.kind === 'video') {
      const v = db.prepare('SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(p.id);
      if (v) createReport({ targetType: 'video', targetId: v.id, targetTitle: v.title, targetUrl: `/watch/${v.id}`, targetOwner: v.username, reason, details, reporterLabel: reporter, sourceInstanceId: inst.id });
    } else if (p?.kind === 'comment') {
      const c = db.prepare('SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(p.id);
      if (c) createReport({ targetType: 'comment', targetId: c.id, targetTitle: c.body.slice(0, 200), targetUrl: `/watch/${c.video_id}`, targetOwner: c.username, reason, details, reporterLabel: reporter, sourceInstanceId: inst.id });
    } else if (p?.kind === 'u' || p?.kind === 'c') {
      const u = db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(p.name);
      if (u) createReport({ targetType: 'user', targetId: u.id, targetTitle: u.display_name, targetUrl: `/c/${u.username}`, targetOwner: u.username, reason, details, reporterLabel: reporter, sourceInstanceId: inst.id });
    }
  }
}
