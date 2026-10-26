// Outgoing webhooks, each person's own: when they publish a video or start a public live stream, this site
// POSTs it to the addresses they set up in Settings, for their bots, bridges and chat channels. Each webhook picks
// its events and a format: the full event as JSON, or a ready-made message for Discord or Slack (and Mattermost,
// which reads Slack's). With a secret, every delivery is signed (X-OurTube-Signature: sha256=<HMAC of the body>,
// also sent as X-ClipTube-Signature from before the rename). Failed deliveries are tried again through the job queue.
//
// Anyone signed in can make this server send requests this way, so a webhook may not point into the server's
// own network (localhost, the LAN, its other containers): the address is checked when it is saved, and the
// address actually connected to is checked again on every delivery. Admins may, for bots on their own machine.
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Router } from 'express';
import { db, getSettings } from './db.js';
import { ALLOW_PRIVATE_FEDERATION, VERSION } from './config.js';
import { requireAuth } from './auth.js';
import { defineJob, enqueueJob } from './jobs.js';
import { isPrivateIp } from './util.js';
import { apBase } from './ap/common.js';
import { HttpError, newId, now, str } from './util.js';

export const EVENTS = {
  'video.published': 'You publish a video (public, and done processing)',
  'live.started': 'You start a public live stream',
};
const FORMATS = {
  json: 'JSON: the whole event, for bots and bridges',
  discord: 'Discord: a message for a Discord webhook',
  slack: 'Slack: a message for Slack or Mattermost',
};
const MAX_PER_PERSON = 10;
const TESTS_PER_10_MIN = 10;

const siteBase = () => apBase() || '';
const iso = (t) => (t ? new Date(Number(t)).toISOString() : null);
const eventsOf = (hook) => String(hook.events || '').split(',').filter((e) => EVENTS[e]);

function view(hook) {
  return {
    id: hook.id,
    url: hook.url,
    format: hook.format,
    events: eventsOf(hook),
    enabled: !!hook.enabled,
    has_secret: !!hook.secret,
    created_at: hook.created_at,
    last_attempt_at: hook.last_attempt_at,
    last_status: hook.last_status,
    last_error: hook.last_error,
    last_ok_at: hook.last_ok_at,
  };
}

/** What a video.published event says about the video. */
export function videoEvent(videoId) {
  const v = db
    .prepare('SELECT v.*, u.username, u.display_name, u.avatar FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?')
    .get(videoId);
  if (!v) return null;
  const base = siteBase();
  const game = v.game_id ? db.prepare('SELECT id, name FROM games WHERE id = ?').get(v.game_id) || null : null;
  return {
    video: {
      id: v.id,
      title: v.title,
      description: v.description || '',
      url: `${base}/watch/${v.id}`,
      thumbnail_url: v.thumb_path ? `${base}/media/thumbs/${v.thumb_path}` : null,
      video_url: `${base}/media/videos/${v.id}.mp4`,
      duration: v.duration || null,
      width: v.width || null,
      height: v.height || null,
      game,
      tags: db.prepare('SELECT tag FROM tags WHERE video_id = ? ORDER BY tag').all(v.id).map((t) => t.tag),
      published_at: iso(v.published_at || v.created_at),
      channel: channelOf(v, base),
    },
  };
}

/** What a live.started event says about the stream. */
export function streamEvent(s, u) {
  const base = siteBase();
  const game = s.game_id ? db.prepare('SELECT id, name FROM games WHERE id = ?').get(s.game_id) || null : null;
  return {
    stream: {
      id: s.id,
      title: s.title,
      description: s.description || '',
      url: `${base}/live/${u.username}`,
      game,
      started_at: iso(s.started_at),
      channel: channelOf(u, base),
    },
  };
}

function channelOf(u, base) {
  return {
    username: u.username,
    display_name: u.display_name || u.username,
    url: `${base}/c/${u.username}`,
    avatar_url: u.avatar ? `${base}/media/avatars/${u.avatar}` : null,
  };
}

/** One line for people: what happened, and the link (chat apps then show the page's own preview). */
function messageFor(event, data) {
  if (event === 'video.published') return `${data.video.channel.display_name} posted a new video: ${data.video.title}\n${data.video.url}`;
  if (event === 'live.started') return `${data.stream.channel.display_name} is live: ${data.stream.title}\n${data.stream.url}`;
  return `Webhook test from ${getSettings().site_name}: this webhook works.`;
}

// ---- Delivery ------------------------------------------------------------------------------------------

const mayReachPrivate = (userId) => ALLOW_PRIVATE_FEDERATION || !!db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId)?.is_admin;

/** A DNS lookup that leaves out private addresses, so the address connected to is the address checked. */
const publicLookup = (hostname, options, cb) =>
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error(`${hostname} points to a private network address`), { code: 'EPRIVATE' }));
    if (options.all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });

/** Refuses an address in this server's own network, unless private ones are allowed. */
async function checkAddress(url, allowPrivate) {
  if (allowPrivate) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, `Could not find ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, `${host} is in a private network, which webhooks can't reach`);
}

function post(url, headers, body, allowPrivate) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return reject(new Error(`${host} is in a private network`));
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, ...(allowPrivate ? {} : { lookup: publicLookup }), timeout: 10_000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (text.length < 1000) text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('No answer within 10 seconds')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Sends one delivery now and records how it went. */
async function deliver(hook, event, data, deliveryId = newId()) {
  const s = getSettings();
  const text = messageFor(event, data);
  const body = JSON.stringify(
    hook.format === 'discord'
      ? { username: str(s.site_name, 80), content: text.slice(0, 2000) }
      : hook.format === 'slack'
        ? { username: str(s.site_name, 80), text }
        : { event, delivery: deliveryId, sent_at: new Date().toISOString(), site: { name: s.site_name, url: siteBase() || null }, ...data },
  );
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': `OurTube/${VERSION} (webhook)`,
    'X-OurTube-Event': event,
    'X-OurTube-Delivery': deliveryId,
  };
  if (hook.secret) headers['X-OurTube-Signature'] = `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`;
  // The same headers under the old name, for receivers set up before the rename.
  for (const k of ['Event', 'Delivery', 'Signature']) if (headers[`X-OurTube-${k}`]) headers[`X-ClipTube-${k}`] = headers[`X-OurTube-${k}`];
  const t = now();
  let status = 0;
  let error = null;
  try {
    const r = await post(hook.url, headers, body, mayReachPrivate(hook.user_id));
    status = r.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}${r.text ? `: ${r.text.replace(/\s+/g, ' ').slice(0, 150)}` : ''}`;
  } catch (e) {
    error = e.message;
  }
  db.prepare('UPDATE webhooks SET last_attempt_at = ?, last_status = ?, last_error = ?, last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END WHERE id = ?').run(
    t, status || null, error, error ? 0 : 1, t, hook.id,
  );
  return { ok: !error, status: status || null, error };
}

defineJob('webhook.deliver', {
  lane: 'network',
  maxAttempts: 5,
  handler: async ({ webhookId, event, data, deliveryId }) => {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND enabled = 1').get(webhookId);
    if (!hook || !eventsOf(hook).includes(event)) return;
    const r = await deliver(hook, event, data, deliveryId);
    if (!r.ok) throw new Error(r.error);
  },
});

/** Queues a delivery of this event to each of this person's webhooks that wants it. */
export function fireWebhooks(event, data, userId) {
  if (!data || !userId) return;
  const key = data.video?.id || data.stream?.id || newId();
  for (const hook of db.prepare('SELECT * FROM webhooks WHERE enabled = 1 AND user_id = ?').all(userId)) {
    if (!eventsOf(hook).includes(event)) continue;
    enqueueJob('webhook.deliver', { webhookId: hook.id, event, data, deliveryId: newId() }, { dedupe: `webhook:${hook.id}:${event}:${key}` });
  }
}

// ---- Settings ------------------------------------------------------------------------------------------

async function cleanUrl(input, userId) {
  const raw = String(input || '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Enter the full address, starting with https://');
  }
  if (!/^https?:$/.test(u.protocol) || raw.length > 500) throw new HttpError(400, 'The address must start with https:// or http://');
  if (u.username || u.password) throw new HttpError(400, 'Put a password in the secret, not in the address');
  await checkAddress(u.href, mayReachPrivate(userId));
  return u.href;
}
function cleanEvents(input) {
  const list = (Array.isArray(input) ? input : String(input || '').split(',')).map((e) => String(e).trim()).filter((e) => EVENTS[e]);
  if (!list.length) throw new HttpError(400, `Pick at least one event: ${Object.keys(EVENTS).join(', ')}`);
  return [...new Set(list)].join(',');
}
function cleanFormat(input) {
  const f = String(input || 'json');
  if (!FORMATS[f]) throw new HttpError(400, `The format must be ${Object.keys(FORMATS).join(', ')}`);
  return f;
}
function ownHook(id, user) {
  const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(String(id), user.id);
  if (!hook) throw new HttpError(404, 'Webhook not found');
  return hook;
}

const tests = new Map(); // user id -> recent test times
export const webhooksRouter = Router();
webhooksRouter.use(requireAuth);

webhooksRouter.get('/', (req, res) => {
  res.json({
    webhooks: db.prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at').all(req.user.id).map(view),
    events: EVENTS,
    formats: FORMATS,
    public_url: siteBase() || null,
  });
});

webhooksRouter.post('/', async (req, res) => {
  const b = req.body || {};
  if (db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?').get(req.user.id).n >= MAX_PER_PERSON) {
    throw new HttpError(400, `At most ${MAX_PER_PERSON} webhooks each`);
  }
  const hook = {
    id: newId(),
    url: await cleanUrl(b.url, req.user.id),
    format: cleanFormat(b.format),
    events: cleanEvents(b.events || Object.keys(EVENTS)),
    secret: str(b.secret, 200).trim() || null,
  };
  db.prepare('INSERT INTO webhooks (id, user_id, url, format, events, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
    hook.id, req.user.id, hook.url, hook.format, hook.events, hook.secret, now(),
  );
  res.status(201).json({ webhook: view(ownHook(hook.id, req.user)) });
});

webhooksRouter.patch('/:id', async (req, res) => {
  const hook = ownHook(req.params.id, req.user);
  const b = req.body || {};
  const next = {
    url: b.url !== undefined ? await cleanUrl(b.url, req.user.id) : hook.url,
    format: b.format !== undefined ? cleanFormat(b.format) : hook.format,
    events: b.events !== undefined ? cleanEvents(b.events) : hook.events,
    enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : hook.enabled,
    // The secret is never shown again: empty clears it, leaving it out keeps it.
    secret: b.secret !== undefined ? str(b.secret, 200).trim() || null : hook.secret,
  };
  db.prepare('UPDATE webhooks SET url = ?, format = ?, events = ?, enabled = ?, secret = ? WHERE id = ?').run(
    next.url, next.format, next.events, next.enabled, next.secret, hook.id,
  );
  res.json({ webhook: view(ownHook(hook.id, req.user)) });
});

webhooksRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(ownHook(req.params.id, req.user).id);
  res.status(204).end();
});

// Sends a test right away, with your latest public video as the example when there is one.
webhooksRouter.post('/:id/test', async (req, res) => {
  const hook = ownHook(req.params.id, req.user);
  const recent = (tests.get(req.user.id) || []).filter((t) => now() - t < 600_000);
  if (recent.length >= TESTS_PER_10_MIN) throw new HttpError(429, 'That is a lot of tests; try again in a few minutes');
  tests.set(req.user.id, [...recent, now()]);
  const latest = db
    .prepare("SELECT id FROM videos WHERE user_id = ? AND visibility = 'public' AND status = 'ready' AND moderation_status IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(req.user.id);
  const r = await deliver(hook, 'test', (latest && videoEvent(latest.id)) || {});
  res.json({ ...r, webhook: view(ownHook(hook.id, req.user)) });
});
