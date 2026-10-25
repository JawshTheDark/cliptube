/**
 * ClipTube network (protocol v2): one hub, any number of member instances.
 *
 * - Every instance has an Ed25519 key pair. Members register with the hub (POST /api/hub/join),
 *   proving they control their address by answering a nonce callback (/api/network/verify).
 * - The hub pulls each member's public videos (/api/network/feed) and serves one combined index
 *   (/api/hub/index) plus a directory of members and their public keys (/api/hub/directory).
 *   Members mirror both. Video files are never copied; viewers stream from the origin.
 * - Likes, comments and subscriptions on another instance's videos are sent straight to that
 *   instance's /api/network/inbox, signed with the sender's key. The receiver checks the
 *   signature against the hub directory, its own block list, the hub's network-wide switches
 *   and its own accept switches. Remote people appear as placeholder accounts "name@host".
 * - The hub admin controls joining (open by default, optional approval, or locked), can ban or
 *   suspend any instance and hide any video network-wide. Every instance can block others.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { db, getSettings, setSetting, transaction } from './db.js';
import { ALLOW_PRIVATE_FEDERATION, VERSION } from './config.js';
import { HttpError, now, str, sha256, clampInt, parseTags, newId } from './util.js';
import { requireAuth, requireAdmin } from './auth.js';
import { intakeComment, intakeLike } from './intake.js';
import { createReport } from './reports.js';

export const PROTOCOL = 2;
const FULL_SYNC_MS = 6 * 3600 * 1000;
const PUBLIC_WHERE = "v.status = 'ready' AND v.visibility = 'public' AND v.federate = 1 AND v.moderation_status IS NULL";
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const S = () => getSettings();
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';

// ---- roles & policy -----------------------------------------------------------

export const isHub = () => S().hub_enabled === 'true';

/** True when this instance shows and exchanges network content (hub, or an approved member). */
export function networkActive() {
  const s = S();
  if (s.hub_enabled === 'true') return true;
  return s.network_enabled === 'true' && s.network_status === 'approved';
}

export function networkRole() {
  const s = S();
  if (s.hub_enabled === 'true') return 'hub';
  return s.network_enabled === 'true' ? 'member' : null;
}

function hubPolicy() {
  const s = S();
  return { comments: s.hub_allow_comments === 'true', likes: s.hub_allow_likes === 'true', subscriptions: s.hub_allow_subscriptions === 'true' };
}

/** The network-wide switches: our own when we are the hub, the hub's (cached) when we are a member. */
export function networkPolicy() {
  if (isHub()) return hubPolicy();
  try {
    return { comments: true, likes: true, subscriptions: true, ...JSON.parse(S().network_policy || '{}') };
  } catch {
    return { comments: true, likes: true, subscriptions: true };
  }
}

/** What this instance accepts from other instances (its own switches combined with the network's). */
export function acceptsFromNetwork() {
  const s = S();
  const p = networkPolicy();
  return {
    comments: p.comments && s.network_accept_comments === 'true',
    likes: p.likes && s.network_accept_likes === 'true',
    subscriptions: p.subscriptions && s.network_accept_subscriptions === 'true',
  };
}

export function networkInfo() {
  const s = S();
  const hub = isHub();
  return {
    role: networkRole(),
    active: networkActive(),
    name: hub ? s.hub_network_name : s.network_name || '',
    announcement: hub ? s.hub_announcement : s.network_announcement || '',
    policy: networkActive() ? networkPolicy() : null,
  };
}

// ---- addresses ------------------------------------------------------------------

export function selfUrl(req) {
  const s = S();
  if (s.public_url) return s.public_url.replace(/\/+$/, '').toLowerCase();
  return `${req.protocol}://${req.get('host')}`.toLowerCase();
}

const storedSelf = () => S().network_self_url || '';
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function normalizeInstanceUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Enter an instance address');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new HttpError(400, 'Only http and https addresses are supported');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, 'That is not a valid address');
  }
  if (u.username || u.password) throw new HttpError(400, 'Addresses with a username or password are not allowed');
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Only http and https addresses are supported');
  return u.origin.toLowerCase();
}

function safeHttpUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
}

function sameOrigin(u, origin) {
  const href = safeHttpUrl(u);
  if (!href) return null;
  return new URL(href).origin.toLowerCase() === origin ? href : null;
}

// ---- outbound requests (with SSRF protection) -------------------------------------

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

class RemoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function assertPublicTarget(url) {
  if (ALLOW_PRIVATE_FEDERATION) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      throw new RemoteError(0, `could not resolve ${host}`);
    }
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new RemoteError(0, `${host} points to a private network address`);
}

async function fetchJson(url, { method = 'GET', body, raw, token, headers = {}, timeout = 10000 } = {}) {
  await assertPublicTarget(url);
  const h = { Accept: 'application/json', 'User-Agent': `ClipTube/${VERSION} (network v${PROTOCOL})`, ...headers };
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  if (payload !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: payload, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new RemoteError(0, e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.cause?.message || e.message);
  }
  const text = await res.text();
  if (text.length > 32 * 1024 * 1024) throw new RemoteError(res.status, 'response too large');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new RemoteError(res.status, data?.error || `HTTP ${res.status}`);
  if (data === null || typeof data !== 'object') throw new RemoteError(res.status, 'response was not JSON');
  return data;
}

// ---- keys -------------------------------------------------------------------------

function ensureKeys() {
  const s = S();
  if (s.instance_public_key && s.instance_private_key) return { pub: s.instance_public_key, priv: s.instance_private_key };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  setSetting('instance_public_key', pub);
  setSetting('instance_private_key', priv);
  return { pub, priv };
}

const signText = (text) => crypto.sign(null, Buffer.from(text), ensureKeys().priv).toString('base64');

function verifySig(buf, sig, pem) {
  try {
    return crypto.verify(null, buf, pem, Buffer.from(String(sig), 'base64'));
  } catch {
    return false;
  }
}

function validPublicKey(pem) {
  try {
    return crypto.createPublicKey(String(pem)).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

// ---- instances --------------------------------------------------------------------

const instByUrl = (url) => db.prepare('SELECT * FROM instances WHERE url = ?').get(url);
const instById = (id) => db.prepare('SELECT * FROM instances WHERE id = ?').get(Number(id));
const instName = (i) => i?.name || hostOf(i?.url) || 'that instance';

/** Makes sure this instance has a row for itself (used by the hub for its own videos and key). */
function ensureSelfInstance(url) {
  const s = S();
  const { pub } = ensureKeys();
  db.prepare('UPDATE instances SET is_self = 0 WHERE is_self = 1 AND url != ?').run(url);
  const existing = instByUrl(url);
  if (existing) {
    db.prepare("UPDATE instances SET is_self = 1, name = ?, description = ?, public_key = ?, hub_status = 'approved', listed = 1, blocked = 0 WHERE id = ?").run(
      s.site_name, s.instance_description, pub, existing.id,
    );
  } else {
    db.prepare("INSERT INTO instances (url, name, description, public_key, is_self, hub_status, created_at) VALUES (?, ?, ?, ?, 1, 'approved', ?)").run(
      url, s.site_name, s.instance_description, pub, now(),
    );
  }
}

/** Placeholder account for a person on another instance, e.g. "bob@clips.example.com". */
function ensureShadowUser(inst, actor) {
  const a = actor && typeof actor === 'object' ? actor : {};
  const username = String(a.username || '');
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Bad actor');
  const handle = `${username}@${hostOf(inst.url)}`;
  const display = str(a.display_name, 50).trim() || username;
  const avatar = sameOrigin(a.avatar_url, inst.url);
  const profile = sameOrigin(a.profile_url, inst.url) || `${inst.url}/c/${username}`;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(handle);
  if (u) {
    if (!u.remote_instance_id) throw new HttpError(409, 'Name clash with a local account');
    db.prepare('UPDATE users SET display_name = ?, remote_avatar_url = ?, remote_profile_url = ?, remote_instance_id = ? WHERE id = ?').run(
      display, avatar, profile, inst.id, u.id,
    );
    return { ...u, display_name: display };
  }
  const id = newId();
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at, remote_instance_id, remote_avatar_url, remote_profile_url) VALUES (?, ?, ?, '!', 0, ?, ?, ?, ?)",
  ).run(id, handle, display, now(), inst.id, avatar, profile);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ---- serialisation ------------------------------------------------------------------

/** A local video as other instances see it (absolute URLs). */
function localItem(r, base) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.tag_list ? r.tag_list.split(',') : [],
    duration: r.duration,
    width: r.width,
    height: r.height,
    views: r.views,
    likes: r.like_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
    thumbnail_url: r.thumb_path ? `${base}/media/thumbs/${r.thumb_path}` : null,
    video_url: `${base}/media/videos/${r.id}.mp4${r.edit_version ? `?v=${r.edit_version}` : ''}`,
    watch_url: `${base}/watch/${r.id}`,
    uploader: {
      username: r.username,
      display_name: r.display_name,
      avatar_url: r.u_avatar ? `${base}/media/avatars/${r.u_avatar}` : null,
      url: `${base}/c/${r.username}`,
    },
  };
}

const LOCAL_FEED_SELECT = `SELECT v.*, u.username, u.display_name, u.avatar AS u_avatar,
    (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count,
    (SELECT group_concat(tag, ',') FROM tags t WHERE t.video_id = v.id) AS tag_list
  FROM videos v JOIN users u ON u.id = v.user_id`;

/** Shape a mirrored network video like a local one, plus a `remote` block for links and badges. */
export function serializeRemote(r) {
  return {
    id: `r-${r.instance_id}-${r.remote_id}`,
    title: r.title,
    description: r.description,
    visibility: 'public',
    status: 'ready',
    duration: r.duration,
    width: r.width,
    height: r.height,
    views: r.views,
    likes: r.likes,
    created_at: r.created_at,
    tags: r.tags ? String(r.tags).split(',').filter(Boolean) : [],
    thumbnail_url: r.thumbnail_url,
    video_url: r.video_url,
    uploader: {
      id: null,
      username: r.uploader_username,
      display_name: r.uploader_display_name,
      avatar_url: r.uploader_avatar_url,
      url: r.uploader_url,
    },
    remote: {
      peer_id: r.instance_id,
      remote_id: r.remote_id,
      peer_name: r.peer_name,
      peer_url: r.peer_url,
      watch_url: r.watch_url,
    },
  };
}

/** SQL filter for network videos this instance shows. */
export const NETWORK_VISIBLE = "p.is_self = 0 AND p.blocked = 0 AND p.hub_status = 'approved' AND p.listed = 1 AND r.hidden = 0";

export function cleanItem(it, origin) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const video_url = sameOrigin(it.video_url, origin);
  const watch_url = sameOrigin(it.watch_url, origin);
  if (!video_url || !watch_url) return null;
  const num = (n) => {
    n = Number(n);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const up = it.uploader && typeof it.uploader === 'object' ? it.uploader : {};
  const username = str(up.username, 40).trim();
  if (!username) return null;
  return {
    remote_id: id,
    title: str(it.title, 120).trim() || 'Untitled',
    description: str(it.description, 5000),
    tags: parseTags(Array.isArray(it.tags) ? it.tags.map((t) => str(t, 40)) : []).join(','),
    duration: num(it.duration),
    width: Math.round(num(it.width)),
    height: Math.round(num(it.height)),
    views: Math.round(num(it.views)),
    likes: Math.round(num(it.likes)),
    created_at: num(it.created_at) || now(),
    updated_at: num(it.updated_at) || now(),
    thumbnail_url: sameOrigin(it.thumbnail_url, origin),
    video_url,
    watch_url,
    uploader_username: username,
    uploader_display_name: str(up.display_name, 50).trim() || username,
    uploader_avatar_url: sameOrigin(up.avatar_url, origin),
    uploader_url: sameOrigin(up.url, origin),
  };
}

const UPSERT_VIDEO = `INSERT INTO network_videos (instance_id, remote_id, title, description, tags, duration, width, height, views, likes,
    created_at, updated_at, thumbnail_url, video_url, watch_url, uploader_username, uploader_display_name, uploader_avatar_url, uploader_url, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(instance_id, remote_id) DO UPDATE SET title = excluded.title, description = excluded.description, tags = excluded.tags,
    duration = excluded.duration, width = excluded.width, height = excluded.height, views = excluded.views, likes = excluded.likes,
    created_at = excluded.created_at, updated_at = excluded.updated_at, thumbnail_url = excluded.thumbnail_url, video_url = excluded.video_url,
    watch_url = excluded.watch_url, uploader_username = excluded.uploader_username, uploader_display_name = excluded.uploader_display_name,
    uploader_avatar_url = excluded.uploader_avatar_url, uploader_url = excluded.uploader_url, fetched_at = excluded.fetched_at`;

function upsertVideo(instanceId, c, t) {
  db.prepare(UPSERT_VIDEO).run(instanceId, c.remote_id, c.title, c.description, c.tags, c.duration, c.width, c.height, c.views, c.likes,
    c.created_at, c.updated_at, c.thumbnail_url, c.video_url, c.watch_url, c.uploader_username, c.uploader_display_name,
    c.uploader_avatar_url, c.uploader_url, t);
}


// ---- protocol endpoints (mounted at the app root) -----------------------------------------

export const networkProtocolRouter = Router();

const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const key = `${bucket}:${req.ip || 'unknown'}`;
  const t = now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) throw new HttpError(429, 'Too many requests, try again later');
  list.push(t);
  hits.set(key, list);
}
setInterval(() => {
  const t = now();
  for (const [k, list] of hits) if (!list.some((x) => t - x < 3600_000)) hits.delete(k);
}, 600_000).unref();

networkProtocolRouter.get('/.well-known/cliptube', (req, res) => {
  const s = S();
  const role = networkRole();
  if (!role) throw new HttpError(404, 'Not found');
  res.json({
    software: 'cliptube',
    version: VERSION,
    protocol: PROTOCOL,
    name: s.site_name,
    description: s.instance_description,
    url: storedSelf() || selfUrl(req),
    public_key: ensureKeys().pub,
    hub: role === 'hub'
      ? { enabled: true, network_name: s.hub_network_name, accepting: s.hub_accept_new === 'true', approval: s.hub_require_approval === 'true', https_only: s.hub_require_https === 'true' }
      : { enabled: false, url: s.network_hub_url },
  });
});

// Member side: proves to the hub that a join request really came from this address.
networkProtocolRouter.get('/api/network/verify', (req, res) => {
  const s = S();
  const nonce = String(req.query.nonce || '');
  let hub = '';
  try {
    hub = normalizeInstanceUrl(req.query.hub);
  } catch {}
  if (!nonce || nonce !== s.network_join_nonce || hub !== s.network_join_hub) throw new HttpError(404, 'Unknown join request');
  res.json({ ok: true });
});

function feedAuth(req) {
  const s = S();
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (s.network_enabled !== 'true' || !m || !s.network_feed_token_hash || sha256(m[1]) !== s.network_feed_token_hash) {
    throw new HttpError(401, 'Not authorised');
  }
}

// Member side: the hub pulls our public videos from here.
networkProtocolRouter.get('/api/network/feed', (req, res) => {
  feedAuth(req);
  const since = Number(req.query.updated_since) || 0;
  const after = String(req.query.after_id || '');
  const limit = clampInt(req.query.limit, 1, 200, 100);
  const rows = db
    .prepare(`${LOCAL_FEED_SELECT} WHERE ${PUBLIC_WHERE} AND (v.updated_at > ? OR (v.updated_at = ? AND v.id > ?)) ORDER BY v.updated_at ASC, v.id ASC LIMIT ?`)
    .all(since, since, after, limit);
  const base = storedSelf() || selfUrl(req);
  const last = rows[rows.length - 1];
  res.json({ items: rows.map((r) => localItem(r, base)), next: rows.length === limit ? { updated_since: last.updated_at, after_id: last.id } : null });
});

networkProtocolRouter.get('/api/network/feed/ids', (req, res) => {
  feedAuth(req);
  res.json({ ids: db.prepare(`SELECT v.id FROM videos v WHERE ${PUBLIC_WHERE}`).all().map((r) => r.id) });
});

// ---- hub endpoints ------------------------------------------------------------------------

function requireHub(req, res, next) {
  if (!isHub()) throw new HttpError(404, 'This instance is not a network hub');
  next();
}

function hubSummary() {
  const s = S();
  return {
    network_name: s.hub_network_name,
    announcement: s.hub_announcement,
    policy: hubPolicy(),
    sync_minutes: Math.max(1, Number(s.hub_sync_minutes) || 10),
  };
}

function memberAuth(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Missing network token');
  const inst = db.prepare('SELECT * FROM instances WHERE hub_token_hash = ?').get(sha256(m[1]));
  if (!inst) throw new HttpError(401, 'Unknown network token; join again');
  db.prepare('UPDATE instances SET last_seen_at = ? WHERE id = ?').run(now(), inst.id);
  return inst;
}

function approvedMember(req) {
  const inst = memberAuth(req);
  if (inst.hub_status !== 'approved') throw new HttpError(403, `This instance is ${inst.hub_status} on the network`);
  return inst;
}

networkProtocolRouter.post('/api/hub/join', requireHub, async (req, res) => {
  rateLimit(req, 'join', 20, 3600_000);
  const s = S();
  const b = req.body || {};
  const url = normalizeInstanceUrl(b.url);
  const me = storedSelf() || selfUrl(req);
  if (url === me) throw new HttpError(400, 'The hub cannot join itself');
  if (s.hub_require_https === 'true' && !url.startsWith('https://') && !ALLOW_PRIVATE_FEDERATION) {
    throw new HttpError(400, 'This network only accepts instances served over HTTPS');
  }
  const nonce = String(b.nonce || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new HttpError(400, 'Bad nonce');
  if (!validPublicKey(b.public_key)) throw new HttpError(400, 'Missing or invalid public key');
  const feedToken = String(b.feed_token || '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(feedToken)) throw new HttpError(400, 'Bad feed token');

  const existing = instByUrl(url);
  if (existing?.hub_status === 'banned') throw new HttpError(403, `This instance is banned from the network${existing.hub_note ? `: ${existing.hub_note}` : ''}`);
  const isMember = existing && ['approved', 'pending', 'suspended'].includes(existing.hub_status);
  if (!isMember && s.hub_accept_new !== 'true') throw new HttpError(403, 'This network is not accepting new instances right now');

  try {
    const r = await fetchJson(`${url}/api/network/verify?nonce=${encodeURIComponent(nonce)}&hub=${encodeURIComponent(me)}`);
    if (!r.ok) throw new Error('not confirmed');
  } catch (e) {
    throw new HttpError(403, `Could not confirm the request came from ${url} (${e.message})`);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const status = isMember ? existing.hub_status : s.hub_require_approval === 'true' ? 'pending' : 'approved';
  const name = str(b.name, 60).trim() || hostOf(url);
  const t = now();
  if (existing) {
    db.prepare(
      'UPDATE instances SET name = ?, description = ?, public_key = ?, feed_token = ?, hub_token_hash = ?, hub_status = ?, version = ?, last_seen_at = ?, is_self = 0 WHERE id = ?',
    ).run(name, str(b.description, 500), String(b.public_key), feedToken, sha256(token), status, str(b.version, 20), t, existing.id);
  } else {
    db.prepare(
      'INSERT INTO instances (url, name, description, public_key, feed_token, hub_token_hash, hub_status, version, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(url, name, str(b.description, 500), String(b.public_key), feedToken, sha256(token), status, str(b.version, 20), t, t);
  }
  console.log(`[network] ${url} joined the hub (${status})`);
  const inst = instByUrl(url);
  if (status === 'approved') schedulePull(inst.id, 1000);
  res.json({ status, note: inst.hub_note || null, token, ...hubSummary() });
});

networkProtocolRouter.get('/api/hub/status', requireHub, (req, res) => {
  const inst = memberAuth(req);
  res.json({ status: inst.hub_status, note: inst.hub_note || null, ...hubSummary() });
});

networkProtocolRouter.post('/api/hub/ping', requireHub, (req, res) => {
  const inst = approvedMember(req);
  schedulePull(inst.id, 3000);
  res.json({ ok: true });
});

networkProtocolRouter.post('/api/hub/leave', requireHub, (req, res) => {
  const inst = memberAuth(req);
  if (inst.hub_status === 'banned') {
    db.prepare('UPDATE instances SET hub_token_hash = NULL, feed_token = NULL WHERE id = ?').run(inst.id); // keep the ban on record
  } else {
    db.prepare('DELETE FROM instances WHERE id = ?').run(inst.id);
  }
  console.log(`[network] ${inst.url} left the hub`);
  res.json({ ok: true });
});

networkProtocolRouter.get('/api/hub/directory', requireHub, (req, res) => {
  approvedMember(req);
  const rows = db
    .prepare("SELECT * FROM instances WHERE (hub_status = 'approved' AND blocked = 0) OR is_self = 1 ORDER BY name COLLATE NOCASE")
    .all();
  res.json({
    instances: rows.map((i) => ({
      url: i.url,
      name: i.name || hostOf(i.url),
      description: i.description,
      public_key: i.is_self ? ensureKeys().pub : i.public_key,
      allow_interactions: !!i.allow_interactions,
      listed: !!i.listed,
      is_hub: !!i.is_self,
      video_count: i.is_self
        ? db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${PUBLIC_WHERE}`).get().n
        : db.prepare('SELECT COUNT(*) AS n FROM network_videos WHERE instance_id = ? AND hidden = 0').get(i.id).n,
    })),
  });
});

/** Every visible video in the network (the hub's own plus all listed members'), oldest change first. */
function hubIndexParts() {
  const s = S();
  const self = db.prepare('SELECT * FROM instances WHERE is_self = 1').get();
  const parts = [];
  const params = [];
  if (s.hub_include_own_videos === 'true' && self) {
    parts.push(`SELECT 'local' AS src, ? AS instance, v.id AS vid, v.title, v.description, v.duration, v.width, v.height, v.views,
        (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS likes, v.created_at, v.updated_at, v.thumb_path, v.edit_version,
        u.username AS u_username, u.display_name AS u_display, u.avatar AS u_avatar,
        (SELECT group_concat(tag, ',') FROM tags t WHERE t.video_id = v.id) AS tags,
        NULL AS thumbnail_url, NULL AS video_url, NULL AS watch_url, NULL AS uploader_avatar_url, NULL AS uploader_url, ? || '|' || v.id AS k
      FROM videos v JOIN users u ON u.id = v.user_id WHERE ${PUBLIC_WHERE}`);
    params.push(self.url, self.url);
  }
  parts.push(`SELECT 'remote', p.url, r.remote_id, r.title, r.description, r.duration, r.width, r.height, r.views, r.likes, r.created_at,
      r.updated_at, NULL, 0, r.uploader_username, r.uploader_display_name, NULL, r.tags, r.thumbnail_url, r.video_url, r.watch_url,
      r.uploader_avatar_url, r.uploader_url, p.url || '|' || r.remote_id
    FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${NETWORK_VISIBLE}`);
  return { sql: parts.join(' UNION ALL '), params, base: self?.url || '' };
}

function indexItem(r, base) {
  if (r.src === 'local') {
    return {
      instance: r.instance,
      ...localItem(
        {
          id: r.vid, title: r.title, description: r.description, tag_list: r.tags, duration: r.duration, width: r.width, height: r.height,
          views: r.views, like_count: r.likes, created_at: r.created_at, updated_at: r.updated_at, thumb_path: r.thumb_path,
          edit_version: r.edit_version, username: r.u_username, display_name: r.u_display, u_avatar: r.u_avatar,
        },
        base,
      ),
    };
  }
  return {
    instance: r.instance,
    id: r.vid,
    title: r.title,
    description: r.description,
    tags: r.tags ? r.tags.split(',') : [],
    duration: r.duration,
    width: r.width,
    height: r.height,
    views: r.views,
    likes: r.likes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    thumbnail_url: r.thumbnail_url,
    video_url: r.video_url,
    watch_url: r.watch_url,
    uploader: { username: r.u_username, display_name: r.u_display, avatar_url: r.uploader_avatar_url, url: r.uploader_url },
  };
}

networkProtocolRouter.get('/api/hub/index', requireHub, (req, res) => {
  approvedMember(req);
  const since = Number(req.query.updated_since) || 0;
  const after = String(req.query.after || '');
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const { sql, params, base } = hubIndexParts();
  const rows = db
    .prepare(`SELECT * FROM (${sql}) WHERE (updated_at > ? OR (updated_at = ? AND k > ?)) ORDER BY updated_at ASC, k ASC LIMIT ?`)
    .all(...params, since, since, after, limit);
  const last = rows[rows.length - 1];
  res.json({ items: rows.map((r) => indexItem(r, base)), next: rows.length === limit ? { updated_since: last.updated_at, after: last.k } : null });
});

networkProtocolRouter.get('/api/hub/index/ids', requireHub, (req, res) => {
  approvedMember(req);
  const { sql, params } = hubIndexParts();
  res.json({ keys: db.prepare(`SELECT k FROM (${sql})`).all(...params).map((r) => r.k) });
});

// ---- hub: pulling member feeds ---------------------------------------------------------------

const pulling = new Set();
const pullTimers = new Map();

function schedulePull(id, delay) {
  clearTimeout(pullTimers.get(id));
  pullTimers.set(
    id,
    setTimeout(() => {
      pullTimers.delete(id);
      const inst = instById(id);
      if (inst) pullMember(inst).catch(() => {});
    }, delay).unref(),
  );
}

async function pullMember(inst, { full = false } = {}) {
  if (!isHub() || inst.is_self || inst.hub_status !== 'approved' || !inst.feed_token || pulling.has(inst.id)) return;
  pulling.add(inst.id);
  const t = now();
  try {
    const cap = Math.max(1, Number(S().hub_max_videos_per_instance) || 5000);
    const isFull = full || !inst.last_full_sync_at || t - inst.last_full_sync_at > FULL_SYNC_MS;
    let since = isFull ? 0 : inst.cursor || 0;
    let after = '';
    let cursor = inst.cursor || 0;
    let skipped = 0;
    let received = 0;
    for (let page = 0; page < 200; page++) {
      const r = await fetchJson(`${inst.url}/api/network/feed?updated_since=${since}&after_id=${encodeURIComponent(after)}&limit=200`, {
        token: inst.feed_token,
        timeout: 30000,
      });
      const items = Array.isArray(r.items) ? r.items : [];
      transaction(() => {
        for (const raw of items) {
          const c = cleanItem(raw, inst.url);
          if (!c) {
            skipped++;
            continue;
          }
          const exists = db.prepare('SELECT 1 FROM network_videos WHERE instance_id = ? AND remote_id = ?').get(inst.id, c.remote_id);
          if (!exists && db.prepare('SELECT COUNT(*) AS n FROM network_videos WHERE instance_id = ?').get(inst.id).n >= cap) {
            skipped++;
            continue;
          }
          upsertVideo(inst.id, c, t);
          if (c.updated_at > cursor) cursor = c.updated_at;
        }
      });
      received += items.length;
      if (!r.next || !items.length) break;
      since = Number(r.next.updated_since) || 0;
      after = String(r.next.after_id || '');
    }
    const ids = await fetchJson(`${inst.url}/api/network/feed/ids`, { token: inst.feed_token, timeout: 30000 });
    if (Array.isArray(ids.ids)) {
      const keep = new Set(ids.ids.map(String));
      const del = db.prepare('DELETE FROM network_videos WHERE instance_id = ? AND remote_id = ?');
      for (const row of db.prepare('SELECT remote_id FROM network_videos WHERE instance_id = ?').all(inst.id)) {
        if (!keep.has(row.remote_id)) del.run(inst.id, row.remote_id);
      }
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM network_videos WHERE instance_id = ?').get(inst.id).n;
    db.prepare(
      'UPDATE instances SET cursor = ?, last_sync_at = ?, last_full_sync_at = CASE WHEN ? THEN ? ELSE last_full_sync_at END, video_count = ?, last_error = ?, fail_count = 0 WHERE id = ?',
    ).run(cursor, t, isFull ? 1 : 0, t, count, skipped ? `${skipped} video(s) skipped (over the per-instance limit or media not hosted on ${inst.url})` : null, inst.id);
    if (received) console.log(`[network] pulled ${received} item(s) from ${inst.url}${isFull ? ' (full)' : ''}`);
  } catch (e) {
    console.warn(`[network] pulling ${inst.url} failed: ${e.message}`);
    db.prepare('UPDATE instances SET last_sync_at = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?').run(t, String(e.message).slice(0, 500), inst.id);
  } finally {
    pulling.delete(inst.id);
  }
}

export async function pullAllMembers() {
  const rows = db.prepare("SELECT * FROM instances WHERE is_self = 0 AND hub_status = 'approved' AND feed_token IS NOT NULL").all();
  for (const inst of rows) await pullMember(inst);
}

// ---- member: joining and syncing with the hub --------------------------------------------------

function clearNetworkMirror() {
  db.exec('DELETE FROM network_videos');
}

/** Joins a hub. `meInput` is this instance's public address (the admin request's, or given on the CLI). */
export async function joinHub(meInput, hubInput) {
  const s = S();
  if (isHub()) throw new HttpError(400, 'This instance is the hub. Turn off hub mode to join a different network.');
  const hubUrl = normalizeInstanceUrl(hubInput || s.network_hub_url);
  const me = normalizeInstanceUrl(meInput);
  if (hubUrl === me) throw new HttpError(400, 'To run the network from this instance, turn on hub mode instead');
  if (!ALLOW_PRIVATE_FEDERATION && !me.startsWith('https://')) {
    throw new HttpError(400, `Other instances need to reach this site over HTTPS, but its address is ${me}. Set the Public URL under Overview first.`);
  }
  const { pub } = ensureKeys();

  let desc;
  try {
    desc = await fetchJson(`${hubUrl}/.well-known/cliptube`);
  } catch (e) {
    throw new HttpError(400, e.status === 404 ? `${hubUrl} is not running a ClipTube network hub` : `Could not reach ${hubUrl}: ${e.message}`);
  }
  if (desc.software !== 'cliptube' || !desc.hub?.enabled) throw new HttpError(400, `${hubUrl} is not running a ClipTube network hub`);

  const nonce = crypto.randomBytes(24).toString('base64url');
  const feedToken = crypto.randomBytes(32).toString('base64url');
  setSetting('network_join_nonce', nonce);
  setSetting('network_join_hub', hubUrl);
  let r;
  try {
    r = await fetchJson(`${hubUrl}/api/hub/join`, {
      method: 'POST',
      body: { url: me, name: s.site_name, description: s.instance_description, public_key: pub, nonce, feed_token: feedToken, version: VERSION },
      timeout: 20000,
    });
  } catch (e) {
    throw new HttpError(400, `The hub did not accept this instance: ${e.message}`);
  } finally {
    setSetting('network_join_nonce', '');
  }
  if (s.network_hub_url !== hubUrl) clearNetworkMirror();
  setSetting('network_hub_url', hubUrl);
  setSetting('network_hub_token', String(r.token));
  setSetting('network_feed_token_hash', sha256(feedToken));
  setSetting('network_self_url', me);
  setSetting('network_enabled', 'true');
  applyHubSummary(r);
  setSetting('network_status', String(r.status));
  setSetting('network_note', r.note || '');
  setSetting('network_cursor', '0');
  setSetting('network_last_full_sync', '0');
  console.log(`[network] joined ${hubUrl} (${r.status})`);
  if (r.status === 'approved') await syncFromHub({ full: true }).catch(() => {});
}

function applyHubSummary(r) {
  setSetting('network_name', str(r.network_name, 60));
  setSetting('network_announcement', str(r.announcement, 1000));
  const p = r.policy && typeof r.policy === 'object' ? r.policy : {};
  setSetting('network_policy', JSON.stringify({ comments: p.comments !== false, likes: p.likes !== false, subscriptions: p.subscriptions !== false }));
  if (r.sync_minutes) setSetting('network_sync_minutes', String(Math.max(1, Math.min(1440, Number(r.sync_minutes) || 10))));
}

export async function leaveHub() {
  const s = S();
  if (s.network_hub_token) {
    try {
      await fetchJson(`${s.network_hub_url}/api/hub/leave`, { method: 'POST', body: {}, token: s.network_hub_token, timeout: 8000 });
    } catch {}
  }
  for (const k of ['network_hub_token', 'network_feed_token_hash', 'network_status', 'network_note', 'network_name', 'network_announcement']) setSetting(k, '');
  setSetting('network_enabled', 'false');
  clearNetworkMirror();
  db.exec('DELETE FROM instances WHERE blocked = 0'); // keep the block list in case of rejoining
}

let memberSyncing = false;

async function refreshDirectory() {
  const s = S();
  const d = await fetchJson(`${s.network_hub_url}/api/hub/directory`, { token: s.network_hub_token, timeout: 20000 });
  const list = Array.isArray(d.instances) ? d.instances : [];
  const self = storedSelf();
  const seen = new Set();
  transaction(() => {
    for (const x of list) {
      let url;
      try {
        url = normalizeInstanceUrl(x.url);
      } catch {
        continue;
      }
      if (!validPublicKey(x.public_key)) continue;
      seen.add(url);
      const existing = instByUrl(url);
      const vals = [str(x.name, 60) || hostOf(url), str(x.description, 500), String(x.public_key), x.allow_interactions === false ? 0 : 1, x.listed === false ? 0 : 1, url === self ? 1 : 0, Number(x.video_count) || 0];
      if (existing) {
        db.prepare("UPDATE instances SET name = ?, description = ?, public_key = ?, allow_interactions = ?, listed = ?, is_self = ?, video_count = ?, hub_status = 'approved' WHERE id = ?").run(...vals, existing.id);
      } else {
        db.prepare("INSERT INTO instances (name, description, public_key, allow_interactions, listed, is_self, video_count, hub_status, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)").run(...vals, url, now());
      }
    }
    for (const row of db.prepare("SELECT id, url FROM instances WHERE hub_status = 'approved'").all()) {
      if (!seen.has(row.url)) {
        db.prepare("UPDATE instances SET hub_status = 'gone' WHERE id = ?").run(row.id);
        db.prepare('DELETE FROM network_videos WHERE instance_id = ?').run(row.id);
      }
    }
  });
}

let lastDirectoryRefresh = 0;
async function refreshDirectoryQuietly() {
  if (isHub() || now() - lastDirectoryRefresh < 60_000) return;
  lastDirectoryRefresh = now();
  try {
    await refreshDirectory();
  } catch {}
}

export async function syncFromHub({ full = false } = {}) {
  const s = S();
  if (isHub() || s.network_enabled !== 'true' || !s.network_hub_token || memberSyncing) return;
  memberSyncing = true;
  const t = now();
  try {
    let st;
    try {
      st = await fetchJson(`${s.network_hub_url}/api/hub/status`, { token: s.network_hub_token });
    } catch (e) {
      if (e.status === 401 || e.status === 404) {
        setSetting('network_status', 'removed');
        setSetting('network_note', e.status === 404 ? 'The hub is no longer running a network' : 'The hub no longer recognises this instance; join again');
        clearNetworkMirror();
        return;
      }
      throw e;
    }
    applyHubSummary(st);
    setSetting('network_status', String(st.status));
    setSetting('network_note', st.note || '');
    if (st.status !== 'approved') {
      clearNetworkMirror();
      setSetting('network_last_sync', String(t));
      setSetting('network_last_error', '');
      return;
    }

    await refreshDirectory();
    lastDirectoryRefresh = t;

    const isFull = full || t - (Number(S().network_last_full_sync) || 0) > FULL_SYNC_MS;
    let since = isFull ? 0 : Number(S().network_cursor) || 0;
    let after = '';
    let cursor = since;
    const self = storedSelf();
    const byUrl = new Map(db.prepare('SELECT id, url, is_self FROM instances').all().map((i) => [i.url, i]));
    for (let page = 0; page < 500; page++) {
      const r = await fetchJson(`${s.network_hub_url}/api/hub/index?updated_since=${since}&after=${encodeURIComponent(after)}&limit=500`, {
        token: s.network_hub_token,
        timeout: 30000,
      });
      const items = Array.isArray(r.items) ? r.items : [];
      transaction(() => {
        for (const raw of items) {
          const inst = byUrl.get(String(raw?.instance || '').toLowerCase());
          if (!inst || inst.is_self || inst.url === self) continue;
          const c = cleanItem(raw, inst.url);
          if (!c) continue;
          upsertVideo(inst.id, c, t);
          if (c.updated_at > cursor) cursor = c.updated_at;
        }
      });
      if (!r.next || !items.length) break;
      since = Number(r.next.updated_since) || 0;
      after = String(r.next.after || '');
    }
    const ids = await fetchJson(`${s.network_hub_url}/api/hub/index/ids`, { token: s.network_hub_token, timeout: 30000 });
    if (Array.isArray(ids.keys)) {
      const keep = new Set(ids.keys.map(String));
      const del = db.prepare('DELETE FROM network_videos WHERE instance_id = ? AND remote_id = ?');
      for (const row of db.prepare('SELECT r.instance_id, r.remote_id, p.url FROM network_videos r JOIN instances p ON p.id = r.instance_id').all()) {
        if (!keep.has(`${row.url}|${row.remote_id}`)) del.run(row.instance_id, row.remote_id);
      }
    }
    setSetting('network_cursor', String(cursor));
    setSetting('network_last_sync', String(t));
    if (isFull) setSetting('network_last_full_sync', String(t));
    setSetting('network_last_error', '');
  } catch (e) {
    console.warn(`[network] sync with hub failed: ${e.message}`);
    setSetting('network_last_sync', String(t));
    setSetting('network_last_error', String(e.message).slice(0, 500));
  } finally {
    memberSyncing = false;
  }
}

let pingTimer = null;
/** Called whenever local public videos change, so the hub picks the change up within seconds. */
export function onLocalVideosChanged() {
  const s = S();
  if (s.hub_enabled === 'true' || s.network_enabled !== 'true' || s.network_status !== 'approved' || !s.network_hub_token) return;
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    const cur = S();
    fetchJson(`${cur.network_hub_url}/api/hub/ping`, { method: 'POST', body: {}, token: cur.network_hub_token }).catch(() => {});
  }, 5000);
  pingTimer.unref?.();
}

export function startNetwork() {
  const loop = async () => {
    try {
      if (isHub()) await pullAllMembers();
      else await syncFromHub();
    } catch {}
    const s = S();
    const minutes = Number(isHub() ? s.hub_sync_minutes : s.network_sync_minutes) || 10;
    setTimeout(loop, Math.max(1, Math.min(1440, minutes)) * 60_000).unref();
  };
  setTimeout(loop, 15_000).unref();
}

// ---- inbox: interactions from other instances --------------------------------------------------

const seenNonces = new Map();
setInterval(() => {
  const cutoff = now() - 20 * 60_000;
  for (const [k, t] of seenNonces) if (t < cutoff) seenNonces.delete(k);
}, 300_000).unref();

const KIND = { like: 'likes', comment: 'comments', comment_delete: 'comments', subscribe: 'subscriptions', unsubscribe: 'subscriptions' };

function inboxVideo(id) {
  const v = db.prepare("SELECT * FROM videos WHERE id = ? AND status = 'ready' AND visibility != 'private'").get(String(id || ''));
  if (!v) throw new HttpError(404, 'Video not found');
  return v;
}

function likeCounts(videoId) {
  return db.prepare('SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes FROM likes WHERE video_id = ?').get(videoId);
}

/** A comment as any viewer sees it (same shape as the local comments API). */
export function publicComment(c, videoOwnerId, pinnedId = null) {
  const remote = !!c.remote_instance_id;
  return {
    id: c.id,
    parent_id: c.parent_id,
    body: c.body,
    created_at: c.created_at,
    status: c.status || 'visible',
    hearted: !!c.hearted,
    pinned: !!pinnedId && pinnedId === c.id,
    author: {
      id: c.user_id,
      username: c.username,
      display_name: c.display_name,
      avatar_url: remote ? c.remote_avatar_url : c.avatar ? `/media/avatars/${c.avatar}` : null,
      profile_url: remote ? c.remote_profile_url : null,
      remote,
    },
    is_uploader: c.user_id === videoOwnerId,
  };
}

const COMMENT_SELECT = 'SELECT c.*, u.username, u.display_name, u.avatar, u.remote_instance_id, u.remote_avatar_url, u.remote_profile_url FROM comments c JOIN users u ON u.id = c.user_id';

networkProtocolRouter.post('/api/network/inbox', async (req, res) => {
  if (!networkActive()) throw new HttpError(404, 'This instance is not part of a network');
  rateLimit(req, 'inbox', 600, 600_000);
  const b = req.body || {};
  let url;
  try {
    url = normalizeInstanceUrl(b.instance);
  } catch {
    throw new HttpError(400, 'Bad instance');
  }
  let inst = instByUrl(url);
  if (!inst || !inst.public_key) {
    await refreshDirectoryQuietly();
    inst = instByUrl(url);
  }
  if (!inst || !inst.public_key || inst.is_self) throw new HttpError(403, 'Your instance is not part of this network');
  if (!req.rawBody || !verifySig(req.rawBody, req.get('x-cliptube-signature'), inst.public_key)) {
    // The key may have been rotated by a re-join: refresh once and retry.
    await refreshDirectoryQuietly();
    inst = instByUrl(url);
    if (!inst?.public_key || !verifySig(req.rawBody, req.get('x-cliptube-signature'), inst.public_key)) throw new HttpError(401, 'Bad signature');
  }
  const ts = Number(b.ts);
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > 10 * 60_000) throw new HttpError(400, 'Request expired (check the server clock)');
  const nonceKey = `${inst.id}:${String(b.nonce || '')}`;
  if (!b.nonce || seenNonces.has(nonceKey)) throw new HttpError(400, 'Duplicate request');
  seenNonces.set(nonceKey, now());

  const site = S().site_name;
  if (inst.blocked) throw new HttpError(403, `${site} has blocked your instance`);
  const t = now();

  // Account deletions are honoured from any known instance, even one that may no longer interact.
  if (b.type === 'actor_delete') {
    const username = String(b.actor?.username || '');
    const r = db.prepare('DELETE FROM users WHERE username = ? AND remote_instance_id = ?').run(`${username}@${hostOf(inst.url)}`, inst.id);
    return res.json({ ok: true, removed: r.changes });
  }

  if (inst.hub_status !== 'approved' || !inst.allow_interactions) throw new HttpError(403, 'Your instance is not allowed to interact on this network');

  // Reports always get through (unless the instance is blocked), whatever the interaction switches say.
  if (b.type === 'report') {
    const handle = `${String(b.actor?.username || 'someone').slice(0, 40)}@${hostOf(inst.url)}`;
    const reason = String(b.reason || 'other');
    if (b.target_type === 'video') {
      const v = db.prepare('SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(String(b.target_id || ''));
      if (!v) throw new HttpError(404, 'Video not found');
      createReport({ targetType: 'video', targetId: v.id, targetTitle: v.title, targetUrl: `/watch/${v.id}`, targetOwner: v.username, reason, details: str(b.details, 2000), reporterLabel: handle, sourceInstanceId: inst.id });
    } else if (b.target_type === 'comment') {
      const c = db.prepare('SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(String(b.target_id || ''));
      if (!c) throw new HttpError(404, 'Comment not found');
      createReport({ targetType: 'comment', targetId: c.id, targetTitle: c.body.slice(0, 200), targetUrl: `/watch/${c.video_id}`, targetOwner: c.username, reason, details: str(b.details, 2000), reporterLabel: handle, sourceInstanceId: inst.id });
    } else {
      throw new HttpError(400, 'Unknown report target');
    }
    return res.status(201).json({ ok: true });
  }

  const kind = KIND[b.type];
  if (!kind) throw new HttpError(400, 'Unknown request type');
  if (!networkPolicy()[kind]) throw new HttpError(403, `The network has turned off ${kind} between instances`);
  if (!acceptsFromNetwork()[kind]) throw new HttpError(403, `${site} does not accept ${kind} from other instances`);

  const actor = ensureShadowUser(inst, b.actor);

  switch (b.type) {
    case 'like': {
      const v = inboxVideo(b.video_id);
      const value = Number(b.value);
      if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value must be 1, -1 or 0');
      if (value !== 0) {
        const verdict = intakeLike({ video: v, author: actor, value, remote: true, instance: inst });
        if (verdict.status === 'rejected') throw new HttpError(403, verdict.reason || 'Not allowed');
      }
      if (value === 0) db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(actor.id, v.id);
      else {
        db.prepare(
          'INSERT INTO likes (user_id, video_id, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, video_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
        ).run(actor.id, v.id, value, t);
      }
      return res.json(likeCounts(v.id));
    }
    case 'comment': {
      const v = inboxVideo(b.video_id);
      const body = str(b.body, 2000).trim();
      if (!body) throw new HttpError(400, 'Comment cannot be empty');
      let parentId = b.parent_id ? String(b.parent_id) : null;
      if (parentId) {
        const p = db.prepare('SELECT id, parent_id FROM comments WHERE id = ? AND video_id = ?').get(parentId, v.id);
        if (!p) throw new HttpError(400, 'That comment no longer exists');
        if (p.parent_id) parentId = p.parent_id;
      }
      const verdict = intakeComment({ video: v, author: actor, body, parentId, remote: true, instance: inst });
      if (verdict.status === 'rejected') throw new HttpError(400, verdict.reason || 'Comment not accepted');
      const id = newId();
      db.prepare('INSERT INTO comments (id, video_id, user_id, parent_id, body, status, held_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, v.id, actor.id, parentId, body, verdict.status, verdict.status === 'held' ? verdict.reason : null, t,
      );
      return res.status(201).json({
        comment: publicComment(db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id), v.user_id),
        held: verdict.status === 'held',
        held_reason: verdict.status === 'held' ? verdict.reason : null,
      });
    }
    case 'comment_delete': {
      const r = db.prepare('DELETE FROM comments WHERE id = ? AND user_id = ?').run(String(b.comment_id || ''), actor.id);
      if (!r.changes) throw new HttpError(404, 'Comment not found');
      return res.json({ ok: true });
    }
    case 'subscribe':
    case 'unsubscribe': {
      const ch = db.prepare('SELECT id FROM users WHERE username = ? AND remote_instance_id IS NULL').get(String(b.channel || ''));
      if (!ch) throw new HttpError(404, 'Channel not found');
      if (b.type === 'subscribe') db.prepare('INSERT OR IGNORE INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)').run(actor.id, ch.id, t);
      else db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').run(actor.id, ch.id);
      return res.json({ subscriber_count: db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(ch.id).n });
    }
    default:
      throw new HttpError(400, 'Unknown request type');
  }
});

// ---- outbound interactions -----------------------------------------------------------------------

async function sendToInstance(inst, type, data, user) {
  if (!networkActive()) throw new HttpError(400, 'This site is not connected to a network');
  if (!inst || inst.is_self) throw new HttpError(404, 'Instance not found');
  const always = type === 'report' || type === 'actor_delete';
  if (inst.blocked && !always) throw new HttpError(403, 'You have blocked this instance');
  if (!always && (inst.hub_status !== 'approved' || !inst.allow_interactions)) throw new HttpError(403, `${instName(inst)} cannot receive likes or comments right now`);
  const kind = KIND[type];
  if (kind && !networkPolicy()[kind]) throw new HttpError(403, `The network has turned off ${kind} between instances`);
  const self = storedSelf();
  if (!self) throw new HttpError(400, 'This site has no network address yet');
  const raw = JSON.stringify({
    type,
    instance: self,
    ts: now(),
    nonce: crypto.randomBytes(12).toString('base64url'),
    actor: {
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url ? `${self}${user.avatar_url}` : null,
      profile_url: `${self}/c/${user.username}`,
    },
    ...data,
  });
  try {
    return await fetchJson(`${inst.url}/api/network/inbox`, { method: 'POST', raw, headers: { 'X-ClipTube-Signature': signText(raw) }, timeout: 15000 });
  } catch (e) {
    const status = e.status === 403 ? 403 : e.status === 404 ? 404 : e.status >= 400 && e.status < 500 ? 400 : 502;
    throw new HttpError(status, `${instName(inst)}: ${e.message}`);
  }
}

/** Forwards a report about another instance's video or comment to that instance. */
export async function sendNetworkReport(instanceId, data, user) {
  const inst = instById(instanceId);
  if (!inst) throw new HttpError(404, 'Instance not found');
  return sendToInstance(inst, 'report', data, user);
}

/** Tells every known instance that a local account was deleted, so they drop its comments and likes. */
export async function announceAccountDeletion(user) {
  if (!networkActive()) return 0;
  let sent = 0;
  for (const inst of db.prepare("SELECT * FROM instances WHERE is_self = 0 AND hub_status = 'approved' AND public_key IS NOT NULL").all()) {
    try {
      await sendToInstance(inst, 'actor_delete', {}, user);
      sent++;
    } catch (e) {
      console.warn(`[network] could not tell ${inst.url} about a deleted account: ${e.message}`);
    }
  }
  return sent;
}

// ---- local API for this instance's own pages (/api/network) -----------------------------------------

export const networkRouter = Router();

export function networkPeers() {
  if (!networkActive()) return [];
  return db
    .prepare(
      `SELECT p.id, p.name, p.url, (SELECT COUNT(*) FROM network_videos r WHERE r.instance_id = p.id AND r.hidden = 0) AS video_count
       FROM instances p WHERE p.is_self = 0 AND p.blocked = 0 AND p.hub_status = 'approved' AND p.listed = 1 ORDER BY p.name COLLATE NOCASE`,
    )
    .all()
    .filter((p) => p.video_count > 0)
    .map((p) => ({ id: p.id, name: p.name || hostOf(p.url), url: p.url, video_count: p.video_count }));
}

networkRouter.get('/peers', (req, res) => res.json({ ...networkInfo(), peers: networkPeers() }));

const REMOTE_SELECT = `SELECT r.*, p.name AS peer_name, p.url AS peer_url FROM network_videos r JOIN instances p ON p.id = r.instance_id`;

function remoteVideo(iid, rid) {
  if (!networkActive()) throw new HttpError(404, 'Video not found');
  const row = db.prepare(`${REMOTE_SELECT} WHERE ${NETWORK_VISIBLE} AND r.instance_id = ? AND r.remote_id = ?`).get(Number(iid), String(rid));
  if (!row) throw new HttpError(404, 'Video not found');
  return { row, inst: instById(row.instance_id) };
}

networkRouter.get('/videos/:iid/:rid', (req, res) => {
  const { row, inst } = remoteVideo(req.params.iid, req.params.rid);
  const related = db
    .prepare(`${REMOTE_SELECT} WHERE ${NETWORK_VISIBLE} AND r.instance_id = ? AND r.remote_id != ? ORDER BY r.created_at DESC LIMIT 12`)
    .all(row.instance_id, row.remote_id);
  const u = req.user;
  const policy = networkPolicy();
  const can = !!inst.allow_interactions;
  res.json({
    video: serializeRemote(row),
    related: related.map(serializeRemote),
    my_like: u ? db.prepare('SELECT value FROM network_likes WHERE user_id = ? AND instance_id = ? AND remote_id = ?').get(u.id, inst.id, row.remote_id)?.value || 0 : 0,
    subscribed: u ? !!db.prepare('SELECT 1 FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').get(u.id, inst.id, row.uploader_username) : false,
    interactions: { likes: can && policy.likes, comments: can && policy.comments, subscriptions: can && policy.subscriptions },
    can_moderate: !!u?.is_admin,
    role: networkRole(),
  });
});

networkRouter.post('/videos/:iid/:rid/like', requireAuth, async (req, res) => {
  const { row, inst } = remoteVideo(req.params.iid, req.params.rid);
  const value = Number(req.body?.value);
  if (![1, -1, 0].includes(value)) throw new HttpError(400, 'value must be 1, -1 or 0');
  const r = await sendToInstance(inst, 'like', { video_id: row.remote_id, value }, req.user);
  if (value === 0) db.prepare('DELETE FROM network_likes WHERE user_id = ? AND instance_id = ? AND remote_id = ?').run(req.user.id, inst.id, row.remote_id);
  else {
    db.prepare(
      'INSERT INTO network_likes (user_id, instance_id, remote_id, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, instance_id, remote_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at',
    ).run(req.user.id, inst.id, row.remote_id, value, now());
  }
  const likes = Number(r.likes) || 0;
  db.prepare('UPDATE network_videos SET likes = ? WHERE instance_id = ? AND remote_id = ?').run(likes, inst.id, row.remote_id);
  res.json({ likes, dislikes: Number(r.dislikes) || 0, my_like: value });
});

/** Maps a comment from another instance into this instance's view of it. */
function mapRemoteComment(c, inst, me) {
  const host = hostOf(inst.url);
  const selfHost = hostOf(storedSelf());
  const a = c?.author && typeof c.author === 'object' ? c.author : {};
  const raw = str(a.username, 80);
  const remoteOnOrigin = raw.includes('@');
  let username = remoteOnOrigin ? raw : `${raw}@${host}`;
  const mine = !!me && username === `${me.username}@${selfHost}`;
  let profile = remoteOnOrigin ? safeHttpUrl(a.profile_url) : `${inst.url}/c/${raw}`;
  if (username.endsWith(`@${selfHost}`)) {
    username = username.slice(0, -(selfHost.length + 1)); // someone from this instance: show and link them locally
    profile = null;
  }
  const avatar = a.avatar_url ? safeHttpUrl(String(a.avatar_url).startsWith('/') ? `${inst.url}${a.avatar_url}` : a.avatar_url) : null;
  return {
    id: str(c.id, 40),
    parent_id: c.parent_id ? str(c.parent_id, 40) : null,
    body: str(c.body, 2000),
    created_at: Number(c.created_at) || 0,
    author: { username, display_name: str(a.display_name, 50) || username, avatar_url: avatar, profile_url: profile, remote: !!profile },
    is_uploader: !!c.is_uploader,
    hearted: !!c.hearted,
    pinned: !!c.pinned,
    status: c.status === "held" ? "held" : "visible",
    can_delete: mine,
  };
}

networkRouter.get('/videos/:iid/:rid/comments', async (req, res) => {
  const { row, inst } = remoteVideo(req.params.iid, req.params.rid);
  let r;
  try {
    r = await fetchJson(`${inst.url}/api/videos/${encodeURIComponent(row.remote_id)}/comments`, { timeout: 10000 });
  } catch (e) {
    throw new HttpError(502, `Could not load comments from ${instName(inst)}: ${e.message}`);
  }
  const comments = (Array.isArray(r.comments) ? r.comments : []).slice(0, 2000).map((c) => mapRemoteComment(c, inst, req.user));
  const accepts = r.network_accepts && typeof r.network_accepts === 'object' ? r.network_accepts : null;
  res.json({
    comments,
    can_post: !!inst.allow_interactions && networkPolicy().comments && (accepts ? accepts.comments !== false : true),
    host_name: instName(inst),
  });
});

networkRouter.post('/videos/:iid/:rid/comments', requireAuth, async (req, res) => {
  const { row, inst } = remoteVideo(req.params.iid, req.params.rid);
  const body = str(req.body?.body, 2000).trim();
  if (!body) throw new HttpError(400, 'Comment cannot be empty');
  const r = await sendToInstance(inst, 'comment', { video_id: row.remote_id, body, parent_id: req.body?.parent_id || null }, req.user);
  res.status(201).json({ comment: mapRemoteComment(r.comment, inst, req.user), held: !!r.held, held_reason: r.held_reason || null });
});

networkRouter.delete('/videos/:iid/:rid/comments/:cid', requireAuth, async (req, res) => {
  const { inst } = remoteVideo(req.params.iid, req.params.rid);
  await sendToInstance(inst, 'comment_delete', { comment_id: String(req.params.cid) }, req.user);
  res.json({ ok: true });
});

networkRouter.get('/channels/:iid/:username', async (req, res) => {
  const inst = instById(req.params.iid);
  if (!networkActive() || !inst || inst.is_self) throw new HttpError(404, 'Channel not found');
  const username = String(req.params.username);
  let count = null;
  try {
    count = (await fetchJson(`${inst.url}/api/users/${encodeURIComponent(username)}`, { timeout: 8000 })).channel?.subscriber_count ?? null;
  } catch {}
  const subscribed = req.user ? !!db.prepare('SELECT 1 FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').get(req.user.id, inst.id, username) : false;
  res.json({ subscriber_count: count, subscribed });
});

async function setRemoteSubscription(req, subscribe) {
  const inst = instById(req.params.iid);
  if (!inst) throw new HttpError(404, 'Channel not found');
  const username = String(req.params.username);
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Bad channel name');
  const r = await sendToInstance(inst, subscribe ? 'subscribe' : 'unsubscribe', { channel: username }, req.user);
  if (subscribe) {
    const v = db.prepare('SELECT * FROM network_videos WHERE instance_id = ? AND uploader_username = ? ORDER BY created_at DESC LIMIT 1').get(inst.id, username);
    db.prepare(
      'INSERT OR REPLACE INTO network_subscriptions (user_id, instance_id, username, display_name, avatar_url, profile_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(req.user.id, inst.id, username, v?.uploader_display_name || username, v?.uploader_avatar_url || null, v?.uploader_url || `${inst.url}/c/${username}`, now());
  } else {
    db.prepare('DELETE FROM network_subscriptions WHERE user_id = ? AND instance_id = ? AND username = ?').run(req.user.id, inst.id, username);
  }
  return { subscribed: subscribe, subscriber_count: r.subscriber_count ?? null };
}

networkRouter.post('/channels/:iid/:username/subscribe', requireAuth, async (req, res) => res.json(await setRemoteSubscription(req, true)));
networkRouter.delete('/channels/:iid/:username/subscribe', requireAuth, async (req, res) => res.json(await setRemoteSubscription(req, false)));

// ---- admin API (/api/admin/network) ------------------------------------------------------------------

export const networkAdminRouter = Router();
networkAdminRouter.use(requireAdmin);

const HUB_FIELDS = {
  network_name: ['hub_network_name', (v) => str(v, 60).trim() || 'ClipTube Network'],
  accept_new: ['hub_accept_new', (v) => (yes(v) ? 'true' : 'false')],
  require_approval: ['hub_require_approval', (v) => (yes(v) ? 'true' : 'false')],
  require_https: ['hub_require_https', (v) => (yes(v) ? 'true' : 'false')],
  allow_comments: ['hub_allow_comments', (v) => (yes(v) ? 'true' : 'false')],
  allow_likes: ['hub_allow_likes', (v) => (yes(v) ? 'true' : 'false')],
  allow_subscriptions: ['hub_allow_subscriptions', (v) => (yes(v) ? 'true' : 'false')],
  include_own_videos: ['hub_include_own_videos', (v) => (yes(v) ? 'true' : 'false')],
  max_videos_per_instance: ['hub_max_videos_per_instance', (v) => String(Math.max(1, Math.min(100000, parseInt(v, 10) || 5000)))],
  sync_minutes: ['hub_sync_minutes', (v) => String(Math.max(1, Math.min(1440, parseInt(v, 10) || 10)))],
  announcement: ['hub_announcement', (v) => str(v, 1000)],
};

function adminState(req) {
  const s = S();
  const hub = isHub();
  const instances = db.prepare('SELECT * FROM instances ORDER BY is_self DESC, name COLLATE NOCASE').all();
  const count = (i) => db.prepare('SELECT COUNT(*) AS n FROM network_videos WHERE instance_id = ?').get(i.id).n;
  return {
    self_url: storedSelf() || selfUrl(req),
    public_url_set: !!s.public_url,
    allow_private: ALLOW_PRIVATE_FEDERATION,
    role: networkRole(),
    active: networkActive(),
    member: {
      enabled: s.network_enabled === 'true',
      hub_url: s.network_hub_url,
      status: s.network_status || null,
      note: s.network_note || null,
      network_name: s.network_name || '',
      announcement: s.network_announcement || '',
      policy: networkPolicy(),
      accept: { comments: s.network_accept_comments === 'true', likes: s.network_accept_likes === 'true', subscriptions: s.network_accept_subscriptions === 'true' },
      last_sync_at: Number(s.network_last_sync) || null,
      last_error: s.network_last_error || null,
      video_count: db.prepare('SELECT COUNT(*) AS n FROM network_videos').get().n,
    },
    hub: {
      enabled: hub,
      settings: Object.fromEntries(Object.entries(HUB_FIELDS).map(([k, [key]]) => {
        const v = s[key];
        return [k, v === 'true' ? true : v === 'false' ? false : v];
      })),
      members: hub
        ? instances.filter((i) => !i.is_self && i.hub_status && i.hub_status !== 'gone').map((i) => ({
            id: i.id, url: i.url, name: i.name || hostOf(i.url), status: i.hub_status, note: i.hub_note, allow_interactions: !!i.allow_interactions,
            listed: !!i.listed, video_count: count(i), last_sync_at: i.last_sync_at, last_seen_at: i.last_seen_at, last_error: i.last_error,
            version: i.version, created_at: i.created_at,
          }))
        : [],
    },
    instances: instances
      .filter((i) => !i.is_self && (i.blocked || (i.hub_status === 'approved' && !hub)))
      .map((i) => ({ id: i.id, url: i.url, name: i.name || hostOf(i.url), blocked: !!i.blocked, block_reason: i.block_reason, video_count: count(i) })),
    hidden: db
      .prepare(`${REMOTE_SELECT} WHERE r.hidden = 1 ORDER BY r.created_at DESC LIMIT 200`)
      .all()
      .map((r) => ({ instance_id: r.instance_id, remote_id: r.remote_id, title: r.title, peer_name: r.peer_name, watch_url: r.watch_url })),
  };
}

networkAdminRouter.get('/', (req, res) => res.json(adminState(req)));

networkAdminRouter.patch('/member', (req, res) => {
  const b = req.body || {};
  for (const k of ['comments', 'likes', 'subscriptions']) {
    if (b[`accept_${k}`] !== undefined) setSetting(`network_accept_${k}`, yes(b[`accept_${k}`]) ? 'true' : 'false');
  }
  if (b.hub_url !== undefined && S().network_enabled !== 'true') setSetting('network_hub_url', normalizeInstanceUrl(b.hub_url));
  res.json(adminState(req));
});

networkAdminRouter.post('/join', async (req, res) => {
  await joinHub(selfUrl(req), req.body?.hub_url);
  res.json(adminState(req));
});

networkAdminRouter.post('/leave', async (req, res) => {
  await leaveHub();
  res.json(adminState(req));
});

networkAdminRouter.post('/sync', async (req, res) => {
  if (isHub()) {
    for (const inst of db.prepare("SELECT * FROM instances WHERE is_self = 0 AND hub_status = 'approved'").all()) await pullMember(inst, { full: true });
  } else {
    await syncFromHub({ full: true });
  }
  res.json(adminState(req));
});

networkAdminRouter.patch('/instances/:id', (req, res) => {
  const inst = instById(req.params.id);
  if (!inst || inst.is_self) throw new HttpError(404, 'Instance not found');
  if (req.body?.blocked !== undefined) {
    db.prepare('UPDATE instances SET blocked = ?, block_reason = ? WHERE id = ?').run(yes(req.body.blocked) ? 1 : 0, yes(req.body.blocked) ? str(req.body.reason, 200) || null : null, inst.id);
  }
  res.json(adminState(req));
});

/** Block an instance by address, even one this server hasn't seen yet. */
networkAdminRouter.post('/instances/block', (req, res) => {
  const url = normalizeInstanceUrl(req.body?.url);
  const existing = instByUrl(url);
  if (existing?.is_self) throw new HttpError(400, 'That is this instance');
  if (existing) db.prepare('UPDATE instances SET blocked = 1, block_reason = ? WHERE id = ?').run(str(req.body?.reason, 200) || null, existing.id);
  else db.prepare("INSERT INTO instances (url, name, blocked, block_reason, hub_status, created_at) VALUES (?, ?, 1, ?, 'gone', ?)").run(url, hostOf(url), str(req.body?.reason, 200) || null, now());
  res.json(adminState(req));
});

/** Turns hub mode on. `meInput` is this instance's public address. */
export function enableHub(meInput) {
  if (S().network_enabled === 'true') throw new HttpError(400, 'Leave your current network before turning on hub mode');
  const me = normalizeInstanceUrl(meInput);
  if (!ALLOW_PRIVATE_FEDERATION && !me.startsWith('https://')) {
    throw new HttpError(400, `Instances need to reach the hub over HTTPS, but this site's address is ${me}. Set the Public URL under Overview first.`);
  }
  ensureKeys();
  setSetting('network_self_url', me);
  ensureSelfInstance(me);
  setSetting('hub_enabled', 'true');
}

export function disableHub() {
  setSetting('hub_enabled', 'false');
}

networkAdminRouter.patch('/hub', (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) {
    if (yes(b.enabled)) enableHub(selfUrl(req));
    else disableHub();
  }
  for (const [field, [key, conv]] of Object.entries(HUB_FIELDS)) if (b[field] !== undefined) setSetting(key, conv(b[field]));
  if (isHub()) ensureSelfInstance(storedSelf() || selfUrl(req));
  res.json(adminState(req));
});

networkAdminRouter.patch('/hub/members/:id', (req, res) => {
  if (!isHub()) throw new HttpError(400, 'Hub mode is off');
  const inst = instById(req.params.id);
  if (!inst || inst.is_self) throw new HttpError(404, 'Instance not found');
  const b = req.body || {};
  const touch = () => db.prepare('UPDATE network_videos SET updated_at = ? WHERE instance_id = ?').run(now(), inst.id); // re-send to members
  if (b.status !== undefined) {
    if (!['approved', 'suspended', 'banned', 'pending'].includes(b.status)) throw new HttpError(400, 'Bad status');
    db.prepare('UPDATE instances SET hub_status = ?, hub_note = ? WHERE id = ?').run(b.status, str(b.note, 300) || null, inst.id);
    if (b.status === 'approved') {
      touch();
      schedulePull(inst.id, 500);
    }
  }
  if (b.allow_interactions !== undefined) db.prepare('UPDATE instances SET allow_interactions = ? WHERE id = ?').run(yes(b.allow_interactions) ? 1 : 0, inst.id);
  if (b.listed !== undefined) {
    db.prepare('UPDATE instances SET listed = ? WHERE id = ?').run(yes(b.listed) ? 1 : 0, inst.id);
    if (yes(b.listed)) touch();
  }
  res.json(adminState(req));
});

networkAdminRouter.post('/hub/members/:id/sync', async (req, res) => {
  const inst = instById(req.params.id);
  if (!inst) throw new HttpError(404, 'Instance not found');
  await pullMember(inst, { full: true });
  res.json(adminState(req));
});

networkAdminRouter.delete('/hub/members/:id', (req, res) => {
  const inst = instById(req.params.id);
  if (!inst || inst.is_self) throw new HttpError(404, 'Instance not found');
  db.prepare('DELETE FROM instances WHERE id = ?').run(inst.id);
  res.json(adminState(req));
});

/** Hide or show one network video. On the hub this removes it from the whole network. */
networkAdminRouter.patch('/videos/:iid/:rid', (req, res) => {
  const hidden = yes(req.body?.hidden) ? 1 : 0;
  const r = db.prepare('UPDATE network_videos SET hidden = ?, updated_at = ? WHERE instance_id = ? AND remote_id = ?').run(hidden, now(), Number(req.params.iid), String(req.params.rid));
  if (!r.changes) throw new HttpError(404, 'Video not found');
  res.json(adminState(req));
});
