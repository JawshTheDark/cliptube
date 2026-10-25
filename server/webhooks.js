// Outgoing webhooks: when a video is published or a public live stream starts, this site POSTs it to the
// addresses its admins set up, for bots, bridges and chat channels. Each webhook picks its events and a format:
// the full event as JSON, or a ready-made message for Discord or Slack (and Mattermost, which reads Slack's).
// With a secret, every delivery is signed (X-ClipTube-Signature: sha256=<HMAC of the body>). Failed deliveries
// are tried again through the job queue.
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, getSettings } from './db.js';
import { VERSION } from './config.js';
import { requireAdmin } from './auth.js';
import { defineJob, enqueueJob } from './jobs.js';
import { logAction } from './reports.js';
import { apBase } from './ap/common.js';
import { HttpError, newId, now, str } from './util.js';

export const EVENTS = {
  'video.published': 'A video is published (public, and done processing)',
  'live.started': 'A public live stream starts',
};
const FORMATS = {
  json: 'JSON: the whole event, for bots and bridges',
  discord: 'Discord: a message for a Discord webhook',
  slack: 'Slack: a message for Slack or Mattermost',
};
const MAX_WEBHOOKS = 20;

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
    'User-Agent': `ClipTube/${VERSION} (webhook)`,
    'X-ClipTube-Event': event,
    'X-ClipTube-Delivery': deliveryId,
  };
  if (hook.secret) headers['X-ClipTube-Signature'] = `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`;
  const t = now();
  let status = 0;
  let error = null;
  try {
    const res = await fetch(hook.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    status = res.status;
    const answer = await res.text().catch(() => '');
    if (status < 200 || status >= 300) error = `HTTP ${status}${answer ? `: ${answer.replace(/\s+/g, ' ').slice(0, 150)}` : ''}`;
  } catch (e) {
    error = e.name === 'TimeoutError' ? 'No answer within 10 seconds' : e.cause?.code || e.message;
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

/** Queues a delivery of this event to every webhook that wants it. */
export function fireWebhooks(event, data) {
  if (!data) return;
  const key = data.video?.id || data.stream?.id || newId();
  for (const hook of db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all()) {
    if (!eventsOf(hook).includes(event)) continue;
    enqueueJob('webhook.deliver', { webhookId: hook.id, event, data, deliveryId: newId() }, { dedupe: `webhook:${hook.id}:${event}:${key}` });
  }
}

// ---- Admin -----------------------------------------------------------------------------------------------

function cleanUrl(input) {
  const raw = String(input || '').trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Enter the full address, starting with https://');
  }
  if (!/^https?:$/.test(u.protocol) || raw.length > 500) throw new HttpError(400, 'The address must start with https:// or http://');
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
function ownHook(id) {
  const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(String(id));
  if (!hook) throw new HttpError(404, 'Webhook not found');
  return hook;
}

export const webhooksAdminRouter = Router();
webhooksAdminRouter.use(requireAdmin);

webhooksAdminRouter.get('/', (req, res) => {
  res.json({
    webhooks: db.prepare('SELECT * FROM webhooks ORDER BY created_at').all().map(view),
    events: EVENTS,
    formats: FORMATS,
    public_url: siteBase() || null,
  });
});

webhooksAdminRouter.post('/', (req, res) => {
  const b = req.body || {};
  if (db.prepare('SELECT COUNT(*) AS n FROM webhooks').get().n >= MAX_WEBHOOKS) throw new HttpError(400, `At most ${MAX_WEBHOOKS} webhooks`);
  const hook = {
    id: newId(),
    url: cleanUrl(b.url),
    format: cleanFormat(b.format),
    events: cleanEvents(b.events || Object.keys(EVENTS)),
    secret: str(b.secret, 200).trim() || null,
  };
  db.prepare('INSERT INTO webhooks (id, url, format, events, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(
    hook.id, hook.url, hook.format, hook.events, hook.secret, now(),
  );
  logAction(req.user, 'webhook.create', { targetType: 'webhook', targetId: hook.id, targetLabel: hook.url });
  res.status(201).json({ webhook: view(ownHook(hook.id)) });
});

webhooksAdminRouter.patch('/:id', (req, res) => {
  const hook = ownHook(req.params.id);
  const b = req.body || {};
  const next = {
    url: b.url !== undefined ? cleanUrl(b.url) : hook.url,
    format: b.format !== undefined ? cleanFormat(b.format) : hook.format,
    events: b.events !== undefined ? cleanEvents(b.events) : hook.events,
    enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : hook.enabled,
    // The secret is never shown again: empty clears it, leaving it out keeps it.
    secret: b.secret !== undefined ? str(b.secret, 200).trim() || null : hook.secret,
  };
  db.prepare('UPDATE webhooks SET url = ?, format = ?, events = ?, enabled = ?, secret = ? WHERE id = ?').run(
    next.url, next.format, next.events, next.enabled, next.secret, hook.id,
  );
  res.json({ webhook: view(ownHook(hook.id)) });
});

webhooksAdminRouter.delete('/:id', (req, res) => {
  const hook = ownHook(req.params.id);
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(hook.id);
  logAction(req.user, 'webhook.delete', { targetType: 'webhook', targetId: hook.id, targetLabel: hook.url });
  res.status(204).end();
});

// Sends a test right away, with the latest public video as the example when there is one.
webhooksAdminRouter.post('/:id/test', async (req, res) => {
  const hook = ownHook(req.params.id);
  const latest = db.prepare("SELECT id FROM videos WHERE visibility = 'public' AND status = 'ready' AND moderation_status IS NULL ORDER BY created_at DESC LIMIT 1").get();
  const r = await deliver(hook, 'test', (latest && videoEvent(latest.id)) || {});
  res.json({ ...r, webhook: view(ownHook(hook.id)) });
});
