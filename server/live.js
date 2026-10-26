/**
 * Live streaming. A MediaMTX container next to OurTube takes the streams (RTMP or SRT, from OBS or a phone
 * app) and repackages them as low-latency HLS without re-encoding. OurTube decides who may publish (every
 * channel has a stream key) and who may read (only OurTube itself, which passes the HLS on to viewers under
 * its own address), notices when a stream starts and ends, runs the live chat, tells subscribers, and turns
 * the recording into a draft video when the stream ends.
 *
 * Off unless LIVE_SERVER (MediaMTX's host name on the Docker network) and LIVE_SECRET (shared with MediaMTX)
 * are set; `docker compose --profile live` runs MediaMTX with docker-compose.yml's settings. Other servers in
 * the network show this server's live streams from GET /api/live/now. Mounted at /api/live, with the HLS at
 * /live/hls/<channel>/.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Router } from 'express';
import { db, getSettings } from './db.js';
import { DATA_DIR, DIRS } from './config.js';
import { requireAuth } from './auth.js';
import { HttpError, newId, newToken, now, str } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';
import { notify } from './notify.js';
import { enqueue, ffmpegBin } from './media.js';
import { indexVideo } from './search.js';
import { findGame } from './games.js';
import { networkPeers } from './network.js';
import { apBase, apEnabled, CONTEXT, PUBLIC, urls } from './ap/common.js';
import { deliver, followersOf } from './ap/deliver.js';
import { inboxesOf } from './ap/actors.js';
import { fireWebhooks, streamEvent } from './webhooks.js';
import {
  REACTIONS, addGuest, ban, broadcast, chat, deleteMessage, isBanned, memberOf, membersOf, messagesOf, openStream, react, viewerCount,
} from './rooms.js';

const run = promisify(execFile);
const LIVE = {
  server: process.env.LIVE_SERVER || '',
  secret: process.env.LIVE_SECRET || '',
  rtmp: process.env.LIVE_RTMP_URL || '',
  srt: process.env.LIVE_SRT_URL || '',
  // Tests point these at a stand-in for MediaMTX.
  api: process.env.LIVE_API_URL || '',
  hls: process.env.LIVE_HLS_URL || '',
  recordings: process.env.LIVE_RECORDINGS_DIR || path.join(DATA_DIR, 'live'),
  endGraceMs: Number(process.env.LIVE_END_GRACE_MS) || 45_000,
};
export const liveEnabled = () => !!(LIVE.server && LIVE.secret);
const apiUrl = (p) => `${LIVE.api || `http://${LIVE.server}:9997`}${p}`;
const hlsUrl = (p) => `${LIVE.hls || `http://${LIVE.server}:8888`}${p}`;
const internalAuth = () => `Basic ${Buffer.from(`cliptube:${LIVE.secret}`).toString('base64')}`;
const roomOf = (username) => `live:${username}`;

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** The public address streamers point OBS at. */
function rtmpBase() {
  if (LIVE.rtmp) return LIVE.rtmp.replace(/\/+$/, '');
  const pub = getSettings().public_url;
  try {
    return `rtmp://${new URL(pub).hostname}/live`;
  } catch {
    return 'rtmp://<this server>/live';
  }
}

const userByName = (username) => db.prepare("SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL AND status = 'active'").get(String(username));
const currentStream = (userId) => db.prepare("SELECT * FROM live_streams WHERE user_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1").get(userId);

/** A channel's live settings, with a stream key made the first time they are needed. */
function channelOf(userId) {
  let ch = db.prepare('SELECT * FROM live_channels WHERE user_id = ?').get(userId);
  if (!ch) {
    db.prepare('INSERT INTO live_channels (user_id, stream_key, updated_at) VALUES (?, ?, ?)').run(userId, newToken().slice(0, 32), now());
    ch = db.prepare('SELECT * FROM live_channels WHERE user_id = ?').get(userId);
  }
  return ch;
}

function streamInfo(s, u, { base = '' } = {}) {
  if (!s) return null;
  const game = s.game_id ? db.prepare('SELECT id, name FROM games WHERE id = ?').get(s.game_id) : null;
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    game: game ? { id: game.id, name: game.name } : null,
    visibility: s.visibility,
    status: s.status,
    started_at: s.started_at,
    ended_at: s.ended_at,
    viewers: s.status === 'live' ? viewerCount(roomOf(u.username)) : 0,
    peak_viewers: s.peak_viewers,
    hls_url: s.status === 'live' ? `${base}/live/hls/${u.username}/index.m3u8` : null,
    url: `${base}/live/${u.username}`,
    video_id: s.video_id,
    channel: { username: u.username, display_name: u.display_name, avatar_url: u.avatar ? `${base}/media/avatars/${u.avatar}` : null },
  };
}

// ---- starting, watching and ending a stream ---------------------------------------------------------------

/** A channel started publishing: a new stream, or the same one after a dropped connection. */
function streamStarted(u, ch) {
  const live = currentStream(u.id);
  if (live) {
    db.prepare('UPDATE live_streams SET last_seen_at = ? WHERE id = ?').run(now(), live.id);
    return live;
  }
  const id = newId();
  const t = now();
  db.prepare(
    `INSERT INTO live_streams (id, user_id, title, description, game_id, visibility, status, started_at, last_seen_at, save_recording)
     VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)`,
  ).run(id, u.id, ch.title || `${u.display_name} is live`, ch.description || '', ch.game_id, ch.visibility, t, t, ch.save_recording);
  const s = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(id);
  console.log(`[live] ${u.username} went live (${s.title})`);
  broadcast(roomOf(u.username), 'live', { stream: streamInfo(s, u) });
  if (s.visibility === 'public') {
    enqueueJob('live.announce', { id }, { dedupe: `live-announce:${id}` });
  }
  ensurePolling();
  return s;
}

function streamEnded(s) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  db.prepare("UPDATE live_streams SET status = 'ended', ended_at = ?, peak_viewers = MAX(peak_viewers, ?) WHERE id = ?").run(now(), u ? viewerCount(roomOf(u.username)) : 0, s.id);
  console.log(`[live] ${u?.username} stopped streaming`);
  if (u) broadcast(roomOf(u.username), 'live_ended', { stream: streamInfo(db.prepare('SELECT * FROM live_streams WHERE id = ?').get(s.id), u) });
  enqueueJob('live.recording', { id: s.id }, { dedupe: `live-recording:${s.id}`, delay: 3000 });
}

/** Checks with MediaMTX which streams are still coming in; one gone longer than the grace period has ended. */
async function poll() {
  const live = db.prepare("SELECT s.*, u.username FROM live_streams s JOIN users u ON u.id = s.user_id WHERE s.status = 'live'").all();
  if (!live.length) return false;
  let items;
  try {
    const res = await fetch(apiUrl('/v3/paths/list'), { headers: { Authorization: internalAuth() }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = (await res.json()).items || [];
  } catch (e) {
    // MediaMTX is down or restarting: streams that never come back end after the grace period all the same.
    items = null;
  }
  const ready = new Set((items || []).filter((p) => p.ready).map((p) => p.name));
  for (const s of live) {
    const n = viewerCount(roomOf(s.username));
    if (items && ready.has(`live/${s.username}`)) {
      db.prepare('UPDATE live_streams SET last_seen_at = ?, peak_viewers = MAX(peak_viewers, ?) WHERE id = ?').run(now(), n, s.id);
      broadcast(roomOf(s.username), 'viewers', { viewers: n });
    } else if (now() - s.last_seen_at > LIVE.endGraceMs) {
      streamEnded(s);
    }
  }
  return true;
}

let polling = null;
function ensurePolling() {
  if (polling || !liveEnabled()) return;
  polling = setInterval(async () => {
    try {
      if (!(await poll())) {
        clearInterval(polling);
        polling = null;
      }
    } catch (e) {
      console.warn(`[live] poll failed: ${e.message}`);
    }
  }, Number(process.env.LIVE_POLL_MS) || 5000);
  polling.unref?.();
}
/** At startup: keep watching streams that were live when the server stopped. */
export function startLiveWatch() {
  if (liveEnabled() && db.prepare("SELECT 1 FROM live_streams WHERE status = 'live' LIMIT 1").get()) ensurePolling();
}

// Subscribers hear about it here; fediverse followers get a post with the link.
defineJob('live.announce', {
  maxAttempts: 2,
  handler: ({ id }) => {
    const s = db.prepare('SELECT s.*, u.username, u.display_name FROM live_streams s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(id);
    if (!s || s.status !== 'live') return;
    for (const sub of db.prepare('SELECT subscriber_id FROM subscriptions WHERE channel_id = ?').all(s.user_id)) {
      notify(sub.subscriber_id, { kind: 'live', title: `${s.display_name} is live: ${s.title}`, url: `/live/${s.username}`, actor_label: s.username, dedupe: `live:${s.id}` });
    }
    fireWebhooks('live.started', streamEvent(s, s), s.user_id);
    const base = apBase();
    if (!apEnabled() || !base) return;
    const x = urls(base);
    const link = `${base}/live/${s.username}`;
    const note = {
      id: `${base}/ap/live/${s.id}`,
      type: 'Note',
      attributedTo: x.person(s.username),
      to: [PUBLIC],
      cc: [`${x.person(s.username)}/followers`],
      published: new Date(s.started_at).toISOString(),
      url: link,
      content: `<p>🔴 Live now: ${escapeHtml(s.title)}</p><p><a href="${link}">${link}</a></p>`,
    };
    deliver(`u:${s.user_id}`, { '@context': CONTEXT, id: `${note.id}/create`, type: 'Create', actor: note.attributedTo, to: note.to, cc: note.cc, object: note }, inboxesOf(followersOf([`u:${s.user_id}`, `c:${s.user_id}`])));
  },
});
const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The recording files MediaMTX wrote for a stream (fMP4 segments, by start time). */
function recordingsOf(s, username) {
  const dir = path.join(LIVE.recordings, 'live', username);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'));
  } catch {
    return [];
  }
  const from = s.started_at - 120_000;
  const to = (s.ended_at || now()) + 120_000;
  return names
    .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((x) => x.mtime >= from && x.mtime <= to)
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((x) => x.file);
}

// When a stream ends: its recording becomes a draft video (or is thrown away when the streamer chose so).
defineJob('live.recording', {
  lane: 'media',
  maxAttempts: 2,
  handler: async ({ id }) => {
    const s = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(id);
    const u = s && db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!s || !u || s.video_id) return;
    const files = recordingsOf(s, u.username);
    const drop = () => files.forEach((f) => fs.rmSync(f, { force: true }));
    if (!s.save_recording || !files.length) return drop();
    const vid = newId();
    const out = path.join(DIRS.originals, `${vid}.mp4`);
    if (files.length === 1) {
      fs.copyFileSync(files[0], out);
    } else {
      const list = path.join(DIRS.tmp, `live-${vid}.txt`);
      fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      try {
        await run(ffmpegBin, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
      } finally {
        fs.rmSync(list, { force: true });
      }
    }
    const size = fs.statSync(out).size;
    const t = now();
    const title = str(s.title, 120) || 'Live stream';
    db.prepare(
      `INSERT INTO videos (id, user_id, title, description, visibility, status, original_name, original_path, size_bytes, created_at, updated_at, game_id, allow_clips, draft, draft_visibility)
       VALUES (?, ?, ?, ?, 'private', 'queued', ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
    ).run(vid, u.id, title, s.description || '', `${title}.mp4`, `${vid}.mp4`, size, t, t, s.game_id, s.visibility === 'unlisted' ? 'unlisted' : 'public');
    db.prepare('UPDATE live_streams SET video_id = ? WHERE id = ?').run(vid, s.id);
    indexVideo(vid);
    enqueue(vid);
    drop();
    notify(u.id, { kind: 'upload', title: `Your stream "${title}" was saved as a draft`, url: `/studio/edit/${vid}`, dedupe: `live-saved:${s.id}` });
  },
});

// ---- MediaMTX asks: may this publish or read? ------------------------------------------------------------

const authFails = new Map(); // ip -> timestamps
export const liveHookRouter = Router();

liveHookRouter.post('/auth', (req, res) => {
  if (!liveEnabled() || !same(req.query.secret, LIVE.secret)) return res.status(403).end();
  const b = req.body || {};
  const internal = b.user === 'cliptube' && same(b.password, LIVE.secret);
  const action = String(b.action || '');
  if (action !== 'publish') return res.status(internal ? 200 : 401).end();

  const ip = String(b.ip || 'unknown');
  const fails = (authFails.get(ip) || []).filter((t) => now() - t < 600_000);
  if (fails.length >= 20) return res.status(429).end();
  const m = /^live\/([A-Za-z0-9_]{3,20})$/.exec(String(b.path || ''));
  const u = m && userByName(m[1]);
  const ch = u && db.prepare('SELECT * FROM live_channels WHERE user_id = ?').get(u.id);
  let key = '';
  try {
    key = new URLSearchParams(String(b.query || '')).get('key') || '';
  } catch {}
  key = key || b.password || b.token || '';
  if (!ch || !same(key, ch.stream_key)) {
    authFails.set(ip, [...fails, now()]);
    return res.status(401).end();
  }
  streamStarted(u, ch);
  res.status(200).end();
});

// ---- viewers: the HLS, through this server's address -----------------------------------------------------

export const liveMediaRouter = Router();

liveMediaRouter.get('/:username/*rest', (req, res) => {
  if (!liveEnabled()) return res.status(404).end();
  const u = userByName(req.params.username);
  const s = u && currentStream(u.id);
  const rest = [].concat(req.params.rest || []).join('/');
  if (!s || !/^[A-Za-z0-9_.\-/]+$/.test(rest) || rest.includes('..')) return res.status(404).end();
  let qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  // MediaMTX first redirects to see whether the player keeps cookies. This server passes none on, so it asks for
  // the cookie-less answer straight away, which carries each viewer's session in the playlist's links instead.
  if (rest === 'index.m3u8' && !/[?&](session|cookieCheck)=/.test(qs)) qs = `${qs ? `${qs}&` : '?'}cookieCheck=1`;
  const up = http.get(hlsUrl(`/live/${u.username}/${rest}${qs}`), { headers: { Authorization: internalAuth() } }, (r) => {
    res.status(r.statusCode || 502);
    for (const h of ['content-type', 'cache-control', 'content-length']) if (r.headers[h]) res.set(h, r.headers[h]);
    const loc = r.headers.location;
    if (loc?.startsWith(`/live/${u.username}/`)) res.set('Location', `/live/hls/${loc.slice('/live/'.length)}`);
    // Other servers' pages play it too.
    res.set('Access-Control-Allow-Origin', '*');
    r.pipe(res);
  });
  up.on('error', () => !res.headersSent && res.status(502).end());
  req.on('close', () => up.destroy());
});

// ---- the API ---------------------------------------------------------------------------------------------

export const liveRouter = Router();

liveRouter.get('/me', requireAuth, (req, res) => {
  const ch = channelOf(req.user.id);
  const s = currentStream(req.user.id) || db.prepare('SELECT * FROM live_streams WHERE user_id = ? ORDER BY started_at DESC LIMIT 1').get(req.user.id);
  const game = ch.game_id ? db.prepare('SELECT id, name FROM games WHERE id = ?').get(ch.game_id) : null;
  res.json({
    enabled: liveEnabled(),
    server_url: rtmpBase(),
    stream_key: `${req.user.username}?key=${ch.stream_key}`,
    srt_url: LIVE.srt ? `${LIVE.srt}?streamid=publish:live/${req.user.username}:cliptube:${ch.stream_key}` : null,
    settings: { title: ch.title, description: ch.description, game: game ? game.name : '', visibility: ch.visibility, save_recording: !!ch.save_recording },
    stream: streamInfo(s, req.user),
  });
});

liveRouter.patch('/me', requireAuth, (req, res) => {
  const ch = channelOf(req.user.id);
  const b = req.body || {};
  const title = b.title !== undefined ? str(b.title, 120).trim() : ch.title;
  const description = b.description !== undefined ? str(b.description, 2000) : ch.description;
  const visibility = b.visibility !== undefined ? (b.visibility === 'unlisted' ? 'unlisted' : 'public') : ch.visibility;
  const save = b.save_recording !== undefined ? (b.save_recording ? 1 : 0) : ch.save_recording;
  let gameId = ch.game_id;
  if (b.game !== undefined) gameId = String(b.game || '').trim() ? findGame(b.game)?.id || null : null;
  db.prepare('UPDATE live_channels SET title = ?, description = ?, game_id = ?, visibility = ?, save_recording = ?, updated_at = ? WHERE user_id = ?').run(
    title, description, gameId, visibility, save, now(), req.user.id,
  );
  // Changes reach a stream that is on right now too.
  const s = currentStream(req.user.id);
  if (s) {
    db.prepare('UPDATE live_streams SET title = ?, description = ?, game_id = ?, visibility = ?, save_recording = ? WHERE id = ?').run(
      title || s.title, description, gameId, visibility, save, s.id,
    );
    broadcast(roomOf(req.user.username), 'live', { stream: streamInfo(db.prepare('SELECT * FROM live_streams WHERE id = ?').get(s.id), req.user) });
  }
  res.json({ ok: true });
});

liveRouter.post('/me/key', requireAuth, (req, res) => {
  channelOf(req.user.id);
  db.prepare('UPDATE live_channels SET stream_key = ?, updated_at = ? WHERE user_id = ?').run(newToken().slice(0, 32), now(), req.user.id);
  res.json({ ok: true });
});

const peerLive = new Map(); // peer url -> { at, streams }
async function networkLive() {
  const out = [];
  await Promise.all(
    networkPeers().map(async (p) => {
      const hit = peerLive.get(p.url);
      if (hit && now() - hit.at < 30_000) return out.push(...hit.streams);
      let streams = [];
      try {
        const r = await fetch(`${p.url}/api/live/now?local=1`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) streams = ((await r.json()).live || []).slice(0, 20).map((s) => ({ ...s, remote: { peer_id: p.id, peer_name: p.name, peer_url: p.url } }));
      } catch {}
      peerLive.set(p.url, { at: now(), streams });
      out.push(...streams);
    }),
  );
  return out;
}

// Who is live: public streams here, and (unless ?local=1) on the other servers in the network.
liveRouter.get('/now', async (req, res) => {
  const base = apBase(req) || '';
  const here = db
    .prepare("SELECT s.*, u.username, u.display_name, u.avatar FROM live_streams s JOIN users u ON u.id = s.user_id WHERE s.status = 'live' AND s.visibility = 'public' ORDER BY s.started_at DESC")
    .all()
    .map((s) => streamInfo(s, s, { base }));
  res.json({ enabled: liveEnabled(), live: here, network: req.query.local === '1' ? [] : await networkLive() });
});

function liveTarget(req) {
  const u = userByName(req.params.username);
  if (!u) throw new HttpError(404, 'Channel not found');
  return u;
}

liveRouter.get('/:username', (req, res) => {
  const u = liveTarget(req);
  const s = currentStream(u.id);
  const last = s || db.prepare("SELECT * FROM live_streams WHERE user_id = ? AND visibility = 'public' ORDER BY started_at DESC LIMIT 1").get(u.id);
  res.json({
    enabled: liveEnabled(),
    live: !!s,
    stream: streamInfo(s, u),
    last: !s && last ? streamInfo(last, u) : null,
    channel: { username: u.username, display_name: u.display_name, avatar_url: u.avatar ? `/media/avatars/${u.avatar}` : null },
    you: memberOf(req, roomOf(u.username)),
    is_owner: !!req.user && req.user.id === u.id,
  });
});

// Live chat and the viewer count. Anyone may watch; chatting needs an account here or a guest name.
liveRouter.get('/:username/events', (req, res) => {
  const u = liveTarget(req);
  const room = roomOf(u.username);
  let m = memberOf(req, room);
  if (m && isBanned(room, m.id)) m = null;
  const member = m || { id: `a:${newId(6)}`, name: 'viewer', anonymous: true };
  const s = currentStream(u.id);
  openStream(req, res, room, member, { stream: streamInfo(s, u), messages: messagesOf(room), reactions: REACTIONS, viewers: viewerCount(room) + 1, you: m ? { member_id: m.id, name: m.name } : null });
});

liveRouter.post('/:username/join', (req, res) => {
  const u = liveTarget(req);
  if (req.user) return res.json({ member_id: `u:${req.user.id}` });
  res.status(201).json(addGuest(roomOf(u.username), req.body?.name));
});

function chatter(req, u) {
  const m = memberOf(req, roomOf(u.username));
  if (!m) throw new HttpError(401, 'Sign in or pick a name to chat');
  if (isBanned(roomOf(u.username), m.id)) throw new HttpError(403, 'You were removed from this chat');
  return m;
}
const canModerate = (req, u) => !!req.user && (req.user.id === u.id || req.user.is_moderator || req.user.is_admin);

liveRouter.post('/:username/chat', (req, res) => {
  const u = liveTarget(req);
  res.status(201).json({ message: chat(roomOf(u.username), chatter(req, u), req.body?.body) });
});

liveRouter.post('/:username/react', (req, res) => {
  const u = liveTarget(req);
  react(roomOf(u.username), chatter(req, u), String(req.body?.emoji || ''));
  res.json({ ok: true });
});

liveRouter.delete('/:username/chat/:msgId', (req, res) => {
  const u = liveTarget(req);
  const room = roomOf(u.username);
  const msg = db.prepare('SELECT * FROM room_messages WHERE room = ? AND id = ?').get(room, Number(req.params.msgId));
  if (!msg) throw new HttpError(404, 'Message not found');
  const m = memberOf(req, room);
  if (!canModerate(req, u) && (!m || m.id !== msg.member_id)) throw new HttpError(403, 'Only the streamer and moderators remove other people\'s messages');
  deleteMessage(room, msg.id);
  res.json({ ok: true });
});

liveRouter.post('/:username/ban', (req, res) => {
  const u = liveTarget(req);
  if (!canModerate(req, u)) throw new HttpError(403, 'Only the streamer and moderators remove people from the chat');
  const target = String(req.body?.member_id || '');
  if (!target || target === `u:${u.id}`) throw new HttpError(400, 'Pick someone else');
  ban(roomOf(u.username), target);
  res.json({ members: membersOf(roomOf(u.username)) });
});
