/**
 * Notifications: an in-app list (the bell), plus web push and email for the kinds each person opts into.
 * Kinds: upload (a subscribed channel posted, here or on another instance), reply, mention, comment
 * (on your video) and moderation (what happened to your video, report or account).
 * Fan-out and delivery run through the job queue.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, getSettings } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';
import { HttpError, newId, now, str, sha256 } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';
import { sendPush, vapidKeys } from './webpush.js';
import { mailConfigured, sendMail } from './mail.js';

export const KINDS = {
  upload: 'New uploads from channels you subscribe to',
  reply: 'Replies to your comments',
  mention: 'Mentions of you in comments',
  comment: 'Comments on your videos',
  moderation: 'Decisions about your videos, reports and account',
};
const DEFAULT_PREFS = { push: Object.keys(KINDS), email: ['moderation'] };
const RECENT_UPLOAD_MS = 3 * 86400_000;

function prefsOf(u) {
  try {
    const p = JSON.parse(u?.notify_prefs || 'null');
    return p && Array.isArray(p.push) && Array.isArray(p.email) ? p : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

const siteUrl = () => {
  const s = getSettings();
  return (s.public_url || s.network_self_url || '').replace(/\/+$/, '');
};

/** Creates a notification for a local account (ignored if `dedupe` was already used for them). */
export function notify(userId, { kind, title, body = null, url = null, image_url = null, actor_label = null, dedupe = null }) {
  const u = db.prepare('SELECT id, remote_instance_id, status FROM users WHERE id = ?').get(userId);
  if (!u || u.remote_instance_id || u.status !== 'active') return null;
  const id = newId();
  const r = db
    .prepare('INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, url, image_url, actor_label, dedupe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, kind, str(title, 200), body ? str(body, 500) : null, url, image_url, actor_label, dedupe, now());
  if (!r.changes) return null;
  enqueueJob('notify.deliver', { id });
  return id;
}

// ---- fan-out ----------------------------------------------------------------------------------------

/** Tells a channel's subscribers about a new public upload (once per video). */
export function maybeNotifyUpload(videoId) {
  const v = db.prepare('SELECT id, notified_at, status, visibility, moderation_status FROM videos WHERE id = ?').get(videoId);
  if (!v || v.notified_at || v.status !== 'ready' || v.visibility !== 'public' || v.moderation_status) return;
  db.prepare('UPDATE videos SET notified_at = ? WHERE id = ? AND notified_at IS NULL').run(now(), v.id);
  enqueueJob('notify.upload', { id: v.id }, { dedupe: `notify-upload:${v.id}` });
}

defineJob('notify.upload', {
  handler: ({ id }) => {
    const v = db.prepare('SELECT v.*, u.display_name, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(id);
    if (!v) return;
    const subs = db.prepare('SELECT subscriber_id FROM subscriptions WHERE channel_id = ?').all(v.user_id);
    for (const s of subs) {
      notify(s.subscriber_id, {
        kind: 'upload',
        title: `${v.display_name} uploaded: ${v.title}`,
        url: `/watch/${v.id}`,
        image_url: v.thumb_path ? `/media/thumbs/${v.thumb_path}` : null,
        actor_label: v.username,
        dedupe: `upload:${v.id}`,
      });
    }
  },
});

/** A video from another instance was seen for the first time: tell local people subscribed to its channel. */
export function notifyRemoteUpload(instanceId, remoteId) {
  enqueueJob('notify.remote_upload', { instanceId, remoteId }, { dedupe: `notify-remote:${instanceId}:${remoteId}` });
}

defineJob('notify.remote_upload', {
  handler: ({ instanceId, remoteId }) => {
    const r = db
      .prepare('SELECT r.*, p.url AS peer_url FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ?')
      .get(instanceId, remoteId);
    if (!r || r.notified_at) return;
    db.prepare('UPDATE network_videos SET notified_at = ? WHERE instance_id = ? AND remote_id = ?').run(now(), instanceId, remoteId);
    if (now() - r.created_at > RECENT_UPLOAD_MS) return; // an old video we only just learned about
    const subs = db.prepare('SELECT user_id FROM network_subscriptions WHERE instance_id = ? AND username = ?').all(instanceId, r.uploader_username);
    for (const s of subs) {
      notify(s.user_id, {
        kind: 'upload',
        title: `${r.uploader_display_name} uploaded: ${r.title}`,
        url: `/n/${instanceId}/${encodeURIComponent(remoteId)}`,
        image_url: r.thumbnail_url,
        actor_label: `${r.uploader_username}@${new URL(r.peer_url).host}`,
        dedupe: `upload:${r.peer_url}|${remoteId}`,
      });
    }
  },
});

/** Replies, mentions and comments on someone's video, after a comment is posted (and visible). */
export function notifyComment(commentId) {
  enqueueJob('notify.comment', { id: commentId }, { dedupe: `notify-comment:${commentId}` });
}

defineJob('notify.comment', {
  handler: ({ id }) => {
    const c = db
      .prepare('SELECT c.*, u.username, u.display_name, v.title AS video_title, v.user_id AS owner_id FROM comments c JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id WHERE c.id = ?')
      .get(id);
    if (!c || c.status !== 'visible') return;
    const told = new Set([c.user_id]);
    const url = `/watch/${c.video_id}#c-${c.id}`;
    const excerpt = c.body.length > 140 ? `${c.body.slice(0, 137)}…` : c.body;
    if (c.parent_id) {
      const p = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(c.parent_id);
      if (p && !told.has(p.user_id)) {
        told.add(p.user_id);
        notify(p.user_id, { kind: 'reply', title: `${c.display_name} replied to you on "${c.video_title}"`, body: excerpt, url, actor_label: c.username, dedupe: `reply:${c.id}` });
      }
    }
    for (const m of new Set([...c.body.matchAll(/(^|[^\w@])@([A-Za-z0-9_]{3,20})\b/g)].map((x) => x[2].toLowerCase()))) {
      const u = db.prepare('SELECT id FROM users WHERE lower(username) = ? AND remote_instance_id IS NULL').get(m);
      if (u && !told.has(u.id)) {
        told.add(u.id);
        notify(u.id, { kind: 'mention', title: `${c.display_name} mentioned you on "${c.video_title}"`, body: excerpt, url, actor_label: c.username, dedupe: `mention:${c.id}` });
      }
    }
    if (!told.has(c.owner_id)) {
      notify(c.owner_id, { kind: 'comment', title: `${c.display_name} commented on "${c.video_title}"`, body: excerpt, url, actor_label: c.username, dedupe: `comment:${c.id}` });
    }
  },
});

/** Moderation outcomes for the people they concern. */
export function notifyModeration(userId, title, { body = null, url = null, dedupe = null } = {}) {
  if (userId) notify(userId, { kind: 'moderation', title, body, url, dedupe });
}

// ---- delivery: web push and email --------------------------------------------------------------------

defineJob('notify.deliver', {
  maxAttempts: 3,
  handler: async ({ id }) => {
    const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    if (!n) return;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(n.user_id);
    if (!u) return;
    const prefs = prefsOf(u);
    const base = siteUrl();
    const s = getSettings();
    if (prefs.push.includes(n.kind)) {
      const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(u.id);
      for (const sub of subs) {
        try {
          const r = await sendPush(sub, { title: n.title, body: n.body || '', url: n.url || '/', icon: n.image_url || null, tag: n.kind }, { subject: base || 'mailto:admin@localhost' });
          if (r === 'gone') db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
          else db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?').run(now(), sub.endpoint);
        } catch (e) {
          console.warn(`[notify] push to ${new URL(sub.endpoint).host} failed: ${e.message}`);
        }
      }
    }
    if (prefs.email.includes(n.kind) && u.email && u.email_verified_at && mailConfigured(s)) {
      await sendMail({
        to: u.email,
        subject: `${s.site_name}: ${n.title}`.slice(0, 200),
        text: `${n.title}\n\n${n.body ? `${n.body}\n\n` : ''}${n.url ? `${base}${n.url}\n\n` : ''}You get these emails because of your notification settings: ${base}/settings`,
      });
    }
  },
});

defineJob('notify.cleanup', {
  handler: () => {
    db.prepare('DELETE FROM notifications WHERE created_at < ?').run(now() - 120 * 86400_000);
    db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(now());
    enqueueJob('notify.cleanup', {}, { delay: 24 * 3600_000, dedupe: 'notify-cleanup' });
  },
});
export const startNotifyCleanup = () => enqueueJob('notify.cleanup', {}, { delay: 3600_000, dedupe: 'notify-cleanup' });

// ---- API: /api/notifications ----------------------------------------------------------------------------

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const unread = (userId) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;

notificationsRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({
    unread: unread(req.user.id),
    notifications: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, image_url: n.image_url, read: !!n.read_at, created_at: n.created_at })),
  });
});

notificationsRouter.get('/count', (req, res) => res.json({ unread: unread(req.user.id) }));

notificationsRouter.post('/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : null;
  if (ids) for (const id of ids) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now(), id, req.user.id);
  else db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
  res.json({ unread: unread(req.user.id) });
});

notificationsRouter.get('/settings', (req, res) => {
  const u = db.prepare('SELECT email, email_verified_at, notify_prefs FROM users WHERE id = ?').get(req.user.id);
  res.json({
    kinds: KINDS,
    prefs: prefsOf(u),
    email: u.email || null,
    email_verified: !!u.email_verified_at,
    email_available: mailConfigured(),
    push_key: vapidKeys().publicKey,
    push_devices: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id).n,
  });
});

notificationsRouter.patch('/settings', (req, res) => {
  const b = req.body || {};
  const clean = (list) => (Array.isArray(list) ? [...new Set(list.map(String).filter((k) => KINDS[k]))] : undefined);
  const cur = prefsOf(db.prepare('SELECT notify_prefs FROM users WHERE id = ?').get(req.user.id));
  const next = { push: clean(b.push) ?? cur.push, email: clean(b.email) ?? cur.email };
  db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
  res.json({ prefs: next });
});

// Web push subscriptions from this person's browsers.
notificationsRouter.post('/push', (req, res) => {
  const b = req.body || {};
  let endpoint;
  try {
    endpoint = new URL(String(b.endpoint || ''));
  } catch {
    throw new HttpError(400, 'Bad push endpoint');
  }
  if (endpoint.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|\[)/.test(endpoint.hostname)) throw new HttpError(400, 'Push endpoints must be public HTTPS addresses');
  const p256dh = String(b.keys?.p256dh || '');
  const auth = String(b.keys?.auth || '');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) throw new HttpError(400, 'Bad push keys');
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(endpoint.href, req.user.id, p256dh, auth, str(req.get('user-agent'), 200), now());
  res.status(201).json({ ok: true });
});

notificationsRouter.delete('/push', (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
  res.json({ ok: true });
});

notificationsRouter.post('/test', (req, res) => {
  notify(req.user.id, { kind: 'moderation', title: 'Test notification', body: 'Notifications work on this device.', url: '/settings' });
  res.json({ ok: true });
});

// ---- email address, checks and password resets ----------------------------------------------------------

function makeToken(userId, purpose, email, hours) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(token), userId, purpose, email, now() + hours * 3600_000);
  return token;
}

function takeToken(token, purpose) {
  const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?').get(sha256(String(token || '')), purpose);
  if (!row || row.expires_at < now()) throw new HttpError(400, 'That link has expired or was already used');
  db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(row.token_hash);
  return row;
}

notificationsRouter.put('/email', async (req, res) => {
  const email = str(req.body?.email, 200).trim().toLowerCase();
  if (!email) {
    db.prepare('UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?').run(req.user.id);
    return res.json({ email: null, email_verified: false });
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new HttpError(400, "That doesn't look like an email address");
  if (!mailConfigured()) throw new HttpError(400, 'This site has no email set up');
  db.prepare('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?').run(email, req.user.id);
  const token = makeToken(req.user.id, 'verify', email, 48);
  const s = getSettings();
  await sendMail({ to: email, subject: `${s.site_name}: confirm your email`, text: `Open this link to confirm ${email} for @${req.user.username}:\n\n${siteUrl()}/verify-email?token=${token}\n\nIf you didn't ask for this, ignore this email.` });
  res.json({ email, email_verified: false, sent: true });
});

export const emailPublicRouter = Router();

emailPublicRouter.post('/verify-email', (req, res) => {
  const row = takeToken(req.body?.token, 'verify');
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id);
  if (!u || u.email !== row.email) throw new HttpError(400, 'The address changed since this link was sent');
  db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), row.user_id);
  res.json({ ok: true });
});

const resetAsks = new Map();
emailPublicRouter.post('/forgot-password', async (req, res) => {
  const who = str(req.body?.login, 200).trim().toLowerCase();
  const ip = req.ip || 'x';
  const asks = (resetAsks.get(ip) || []).filter((t) => now() - t < 3600_000);
  if (asks.length >= 5) throw new HttpError(429, 'Too many requests, try again later');
  resetAsks.set(ip, [...asks, now()]);
  const u = db
    .prepare('SELECT * FROM users WHERE remote_instance_id IS NULL AND (lower(username) = ? OR email = ?) AND email IS NOT NULL AND email_verified_at IS NOT NULL')
    .get(who, who);
  // Same answer either way, so this can't be used to find out who has an account.
  if (u && mailConfigured() && u.status === 'active') {
    const token = makeToken(u.id, 'reset', u.email, 2);
    const s = getSettings();
    await sendMail({
      to: u.email,
      subject: `${s.site_name}: reset your password`,
      text: `Someone asked to reset the password for @${u.username}. Open this link within two hours to choose a new one:\n\n${siteUrl()}/reset-password?token=${token}\n\nIf it wasn't you, ignore this email; your password stays the same.`,
    }).catch((e) => console.warn(`[mail] reset email failed: ${e.message}`));
  }
  res.json({ ok: true, message: 'If that account has a confirmed email address, a reset link is on its way.' });
});

emailPublicRouter.post('/reset-password', async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  const row = takeToken(req.body?.token, 'reset');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), row.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  res.json({ ok: true });
});

// Admin: check the SMTP settings by sending a test email.
export const mailAdminRouter = Router();
mailAdminRouter.use(requireAdmin);
mailAdminRouter.post('/test', async (req, res) => {
  const to = str(req.body?.to, 200).trim();
  try {
    await sendMail({ to, subject: `${getSettings().site_name}: test email`, text: 'Email from ClipTube works.' });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  res.json({ ok: true });
});
