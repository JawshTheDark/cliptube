/**
 * ClipTube federation (protocol v1).
 *
 * Opt-in on both sides. An instance only takes part once its admin turns federation on; until then
 * every endpoint below answers 404. Instance A "follows" instance B to index B's public videos:
 *
 *   1. A's admin enters B's address. A fetches B's /.well-known/cliptube descriptor.
 *   2. A stores a random nonce and POSTs { url: A, name, nonce } to B's /api/federation/follow.
 *   3. B proves the request really came from A by calling A's /api/federation/verify?nonce&target.
 *   4. B records A as a follower (auto-approved in "open" mode, pending in "approval" mode) and
 *      returns a bearer token. A keeps the token and polls /api/federation/status until approved.
 *   5. A periodically pulls B's public video metadata (incremental by updated_at) and prunes
 *      anything B no longer lists. Video files are never copied: viewers stream from B directly.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { db, getSettings, setSetting } from './db.js';
import { ALLOW_PRIVATE_FEDERATION, VERSION } from './config.js';
import { HttpError, now, str, sha256, clampInt, parseTags } from './util.js';
import { requireAdmin } from './auth.js';

export const PROTOCOL = 1;
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const FULL_SYNC_MS = 6 * 3600 * 1000;
const MAX_REMOTE_PER_PEER = 5000;
const PUBLIC_WHERE = "v.status = 'ready' AND v.visibility = 'public' AND v.federate = 1";

export function fedEnabled() {
  return getSettings().federation_enabled === 'true';
}

/** This instance's canonical address: the configured public URL, else the address the request used. */
export function selfUrl(req) {
  const s = getSettings();
  if (s.public_url) return s.public_url.replace(/\/+$/, '').toLowerCase();
  return `${req.protocol}://${req.get('host')}`.toLowerCase();
}

export function normalizeInstanceUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new HttpError(400, 'Enter an instance address');
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

// ---- outbound requests (with SSRF protection) ---------------------------------

function isPrivateIp(ip) {
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

class RemoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchJson(url, { method = 'GET', body, token, timeout = 10000 } = {}) {
  await assertPublicTarget(url);
  const headers = { Accept: 'application/json', 'User-Agent': `ClipTube/${VERSION} (federation v${PROTOCOL})` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.cause?.message || e.message;
    throw new RemoteError(0, why);
  }
  const text = await res.text();
  if (text.length > 16 * 1024 * 1024) throw new RemoteError(res.status, 'response too large');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new RemoteError(res.status, data?.error || `HTTP ${res.status}`);
  if (data === null || typeof data !== 'object') throw new RemoteError(res.status, 'response was not JSON');
  return data;
}

// ---- serialisation ------------------------------------------------------------

function federatedItem(r, base) {
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

/** Shape a cached remote video like a local one, plus a `remote` block the UI uses for links and badges. */
export function serializeRemote(r) {
  return {
    id: `r-${r.peer_id}-${r.remote_id}`,
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
      peer_id: r.peer_id,
      remote_id: r.remote_id,
      peer_name: r.peer_name,
      peer_url: r.peer_url,
      watch_url: r.watch_url,
    },
  };
}

function cleanItem(it, peerUrl) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const sameOrigin = (u) => {
    if (!u) return null;
    try {
      const x = new URL(String(u));
      return x.origin.toLowerCase() === peerUrl && (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null;
    } catch {
      return null;
    }
  };
  const video_url = sameOrigin(it.video_url);
  const watch_url = sameOrigin(it.watch_url);
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
    thumbnail_url: sameOrigin(it.thumbnail_url),
    video_url,
    watch_url,
    uploader_username: username,
    uploader_display_name: str(up.display_name, 50).trim() || username,
    uploader_avatar_url: sameOrigin(up.avatar_url),
    uploader_url: sameOrigin(up.url),
  };
}

// ---- inbound protocol endpoints -----------------------------------------------

export const federationRouter = Router();

function requireEnabled(req, res, next) {
  if (!fedEnabled()) throw new HttpError(404, 'Not found');
  next();
}

const followHits = new Map();
function rateLimit(req, max = 20, windowMs = 3600 * 1000) {
  const key = req.ip || 'unknown';
  const t = now();
  const hits = (followHits.get(key) || []).filter((x) => t - x < windowMs);
  if (hits.length >= max) throw new HttpError(429, 'Too many follow requests, try again later');
  hits.push(t);
  followHits.set(key, hits);
}

function follower(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Missing federation token');
  const f = db.prepare('SELECT * FROM followers WHERE token_hash = ?').get(sha256(m[1]));
  if (!f) throw new HttpError(401, 'Unknown federation token');
  db.prepare('UPDATE followers SET last_seen_at = ? WHERE id = ?').run(now(), f.id);
  return f;
}

function approvedFollower(req) {
  const f = follower(req);
  if (f.status !== 'approved') throw new HttpError(403, f.status === 'blocked' ? 'Access revoked' : 'Not approved yet');
  return f;
}

federationRouter.get('/.well-known/cliptube', requireEnabled, (req, res) => {
  const s = getSettings();
  res.json({
    software: 'cliptube',
    version: VERSION,
    protocol: PROTOCOL,
    name: s.site_name,
    description: s.instance_description,
    url: selfUrl(req),
    federation: { enabled: true, mode: s.federation_mode },
    stats: { videos: db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${PUBLIC_WHERE}`).get().n },
  });
});

/** Step 3 of the handshake: confirms we really did ask `target` to accept a follow with this nonce. */
federationRouter.get('/api/federation/verify', requireEnabled, (req, res) => {
  const nonce = String(req.query.nonce || '');
  if (!nonce) throw new HttpError(404, 'Not found');
  const p = db.prepare('SELECT id, url FROM peers WHERE nonce = ?').get(nonce);
  let target = '';
  try {
    target = normalizeInstanceUrl(req.query.target);
  } catch {}
  if (!p || p.url !== target) throw new HttpError(404, 'Unknown follow request');
  res.json({ ok: true });
});

federationRouter.post('/api/federation/follow', requireEnabled, async (req, res) => {
  rateLimit(req);
  const url = normalizeInstanceUrl(req.body?.url);
  const nonce = String(req.body?.nonce || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new HttpError(400, 'Bad nonce');
  const me = selfUrl(req);
  if (url === me) throw new HttpError(400, 'An instance cannot follow itself');

  try {
    const r = await fetchJson(`${url}/api/federation/verify?nonce=${encodeURIComponent(nonce)}&target=${encodeURIComponent(me)}`);
    if (!r.ok) throw new Error('not confirmed');
  } catch (e) {
    throw new HttpError(403, `Could not confirm the request came from ${url} (${e.message})`);
  }

  const existing = db.prepare('SELECT * FROM followers WHERE url = ?').get(url);
  if (existing?.status === 'blocked') throw new HttpError(403, 'This instance is not accepting follows from you');
  const s = getSettings();
  const token = crypto.randomBytes(32).toString('base64url');
  const status = existing?.status === 'approved' || s.federation_mode === 'open' ? 'approved' : 'pending';
  const name = str(req.body?.name, 60).trim() || new URL(url).host;
  if (existing) {
    db.prepare('UPDATE followers SET name = ?, token_hash = ?, status = ? WHERE id = ?').run(name, sha256(token), status, existing.id);
  } else {
    db.prepare('INSERT INTO followers (url, name, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?)').run(url, name, sha256(token), status, now());
  }
  console.log(`[federation] ${url} followed us (${status})`);
  res.json({ status, token, name: s.site_name });
});

federationRouter.get('/api/federation/status', requireEnabled, (req, res) => {
  const f = follower(req);
  res.json({ status: f.status === 'blocked' ? 'rejected' : f.status });
});

federationRouter.post('/api/federation/unfollow', requireEnabled, (req, res) => {
  const f = follower(req);
  db.prepare('DELETE FROM followers WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

federationRouter.get('/api/federation/videos', requireEnabled, (req, res) => {
  approvedFollower(req);
  const since = Number(req.query.updated_since) || 0;
  const after = String(req.query.after_id || '');
  const limit = clampInt(req.query.limit, 1, 200, 100);
  const rows = db
    .prepare(
      `SELECT v.*, u.username, u.display_name, u.avatar AS u_avatar,
         (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count,
         (SELECT group_concat(tag, ',') FROM tags t WHERE t.video_id = v.id) AS tag_list
       FROM videos v JOIN users u ON u.id = v.user_id
       WHERE ${PUBLIC_WHERE} AND (v.updated_at > ? OR (v.updated_at = ? AND v.id > ?))
       ORDER BY v.updated_at ASC, v.id ASC LIMIT ?`,
    )
    .all(since, since, after, limit);
  const base = selfUrl(req);
  const last = rows[rows.length - 1];
  res.json({
    items: rows.map((r) => federatedItem(r, base)),
    next: rows.length === limit ? { updated_since: last.updated_at, after_id: last.id } : null,
  });
});

federationRouter.get('/api/federation/ids', requireEnabled, (req, res) => {
  approvedFollower(req);
  res.json({ ids: db.prepare(`SELECT v.id FROM videos v WHERE ${PUBLIC_WHERE}`).all().map((r) => r.id) });
});

// ---- outbound: following and syncing peers -------------------------------------------

function getPeer(id) {
  return db.prepare('SELECT * FROM peers WHERE id = ?').get(Number(id));
}

function publicPeer(p) {
  return {
    id: p.id,
    url: p.url,
    name: p.name || new URL(p.url).host,
    description: p.description,
    status: p.status,
    paused: !!p.paused,
    video_count: p.video_count,
    last_sync_at: p.last_sync_at,
    last_error: p.last_error,
    fail_count: p.fail_count,
    created_at: p.created_at,
  };
}

export async function followPeer(input, req) {
  if (!fedEnabled()) throw new HttpError(400, 'Turn on federation first');
  const url = normalizeInstanceUrl(input);
  const me = selfUrl(req);
  if (url === me) throw new HttpError(400, 'That is this instance');

  let desc;
  try {
    desc = await fetchJson(`${url}/.well-known/cliptube`);
  } catch (e) {
    throw new HttpError(400, e.status === 404 ? `${url} is not a ClipTube instance with federation turned on` : `Could not reach ${url}: ${e.message}`);
  }
  if (desc.software !== 'cliptube') throw new HttpError(400, `${url} is not a ClipTube instance`);

  const nonce = crypto.randomBytes(24).toString('base64url');
  const name = str(desc.name, 60).trim() || new URL(url).host;
  const description = str(desc.description, 500);
  const existing = db.prepare('SELECT * FROM peers WHERE url = ?').get(url);
  let id;
  if (existing) {
    db.prepare('UPDATE peers SET nonce = ?, name = ?, description = ? WHERE id = ?').run(nonce, name, description, existing.id);
    id = existing.id;
  } else {
    id = Number(
      db.prepare("INSERT INTO peers (url, name, description, nonce, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(url, name, description, nonce, now())
        .lastInsertRowid,
    );
  }

  try {
    const r = await fetchJson(`${url}/api/federation/follow`, { method: 'POST', body: { url: me, name: getSettings().site_name, nonce }, timeout: 20000 });
    if (!r.token) throw new Error('no token returned');
    const status = r.status === 'approved' ? 'approved' : 'pending';
    db.prepare('UPDATE peers SET token = ?, status = ?, nonce = NULL, last_error = NULL, fail_count = 0 WHERE id = ?').run(String(r.token), status, id);
  } catch (e) {
    db.prepare('UPDATE peers SET nonce = NULL, status = ?, last_error = ? WHERE id = ?').run(existing?.token ? existing.status : 'error', e.message, id);
    throw new HttpError(400, `${name} did not accept the follow request: ${e.message}`);
  }
  const peer = getPeer(id);
  if (peer.status === 'approved') syncPeer(peer).catch(() => {});
  return peer;
}

export async function unfollowPeer(id) {
  const p = getPeer(id);
  if (!p) throw new HttpError(404, 'Peer not found');
  if (p.token) {
    try {
      await fetchJson(`${p.url}/api/federation/unfollow`, { method: 'POST', body: {}, token: p.token, timeout: 5000 });
    } catch {}
  }
  db.prepare('DELETE FROM peers WHERE id = ?').run(p.id);
}

const syncing = new Set();

export async function syncPeer(peer) {
  if (!fedEnabled() || peer.paused || !peer.token || syncing.has(peer.id)) return;
  syncing.add(peer.id);
  const t = now();
  try {
    let st;
    try {
      st = await fetchJson(`${peer.url}/api/federation/status`, { token: peer.token });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        db.prepare("UPDATE peers SET status = 'rejected', video_count = 0, last_sync_at = ?, last_error = ? WHERE id = ?").run(t, `They revoked access (${e.message})`, peer.id);
        db.prepare('DELETE FROM remote_videos WHERE peer_id = ?').run(peer.id);
        return;
      }
      throw e;
    }
    const status = ['approved', 'pending', 'rejected'].includes(st.status) ? st.status : 'pending';
    db.prepare('UPDATE peers SET status = ? WHERE id = ?').run(status, peer.id);
    if (status !== 'approved') {
      if (status === 'rejected') {
        db.prepare('DELETE FROM remote_videos WHERE peer_id = ?').run(peer.id);
        db.prepare('UPDATE peers SET video_count = 0 WHERE id = ?').run(peer.id);
      }
      db.prepare('UPDATE peers SET last_sync_at = ?, last_error = NULL, fail_count = 0 WHERE id = ?').run(t, peer.id);
      return;
    }

    const full = !peer.last_full_sync_at || t - peer.last_full_sync_at > FULL_SYNC_MS;
    let since = full ? 0 : peer.cursor || 0;
    let after = '';
    let cursor = peer.cursor || 0;
    let received = 0;
    let skipped = 0;
    const upsert = db.prepare(`INSERT INTO remote_videos (peer_id, remote_id, title, description, tags, duration, width, height, views, likes,
        created_at, updated_at, thumbnail_url, video_url, watch_url, uploader_username, uploader_display_name, uploader_avatar_url, uploader_url, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, remote_id) DO UPDATE SET title = excluded.title, description = excluded.description, tags = excluded.tags,
        duration = excluded.duration, width = excluded.width, height = excluded.height, views = excluded.views, likes = excluded.likes,
        created_at = excluded.created_at, updated_at = excluded.updated_at, thumbnail_url = excluded.thumbnail_url, video_url = excluded.video_url,
        watch_url = excluded.watch_url, uploader_username = excluded.uploader_username, uploader_display_name = excluded.uploader_display_name,
        uploader_avatar_url = excluded.uploader_avatar_url, uploader_url = excluded.uploader_url, fetched_at = excluded.fetched_at`);

    for (let page = 0; page < 100 && received < MAX_REMOTE_PER_PEER; page++) {
      const r = await fetchJson(
        `${peer.url}/api/federation/videos?updated_since=${since}&after_id=${encodeURIComponent(after)}&limit=100`,
        { token: peer.token, timeout: 30000 },
      );
      const items = Array.isArray(r.items) ? r.items : [];
      db.exec('BEGIN');
      try {
        for (const raw of items) {
          const c = cleanItem(raw, peer.url);
          if (!c) {
            skipped++;
            continue;
          }
          upsert.run(peer.id, c.remote_id, c.title, c.description, c.tags, c.duration, c.width, c.height, c.views, c.likes, c.created_at,
            c.updated_at, c.thumbnail_url, c.video_url, c.watch_url, c.uploader_username, c.uploader_display_name, c.uploader_avatar_url,
            c.uploader_url, t);
          if (c.updated_at > cursor) cursor = c.updated_at;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      received += items.length;
      if (!r.next || !items.length) break;
      since = Number(r.next.updated_since) || 0;
      after = String(r.next.after_id || '');
    }

    // Drop videos the peer deleted or made private.
    const ids = await fetchJson(`${peer.url}/api/federation/ids`, { token: peer.token, timeout: 30000 });
    if (Array.isArray(ids.ids)) {
      const keep = new Set(ids.ids.map(String));
      const del = db.prepare('DELETE FROM remote_videos WHERE peer_id = ? AND remote_id = ?');
      for (const row of db.prepare('SELECT remote_id FROM remote_videos WHERE peer_id = ?').all(peer.id)) {
        if (!keep.has(row.remote_id)) del.run(peer.id, row.remote_id);
      }
    }

    const count = db.prepare('SELECT COUNT(*) AS n FROM remote_videos WHERE peer_id = ?').get(peer.id).n;
    const note = skipped ? `${skipped} item(s) skipped because their media is not hosted on ${peer.url}` : null;
    db.prepare(
      'UPDATE peers SET cursor = ?, last_sync_at = ?, last_full_sync_at = CASE WHEN ? THEN ? ELSE last_full_sync_at END, video_count = ?, last_error = ?, fail_count = 0 WHERE id = ?',
    ).run(cursor, t, full ? 1 : 0, t, count, note, peer.id);
    if (received) console.log(`[federation] synced ${received} item(s) from ${peer.url}${full ? ' (full)' : ''}`);
  } catch (e) {
    console.warn(`[federation] sync with ${peer.url} failed: ${e.message}`);
    db.prepare('UPDATE peers SET last_sync_at = ?, last_error = ?, fail_count = fail_count + 1 WHERE id = ?').run(t, String(e.message).slice(0, 500), peer.id);
  } finally {
    syncing.delete(peer.id);
  }
}

export async function syncAll() {
  if (!fedEnabled()) return;
  const peers = db.prepare('SELECT * FROM peers WHERE paused = 0 AND token IS NOT NULL').all();
  for (const p of peers) await syncPeer(p);
}

export function startFederation() {
  setTimeout(() => syncAll().catch(() => {}), 15_000).unref();
  setInterval(() => syncAll().catch(() => {}), SYNC_INTERVAL_MS).unref();
}

export function networkPeers() {
  if (!fedEnabled()) return [];
  return db
    .prepare("SELECT * FROM peers WHERE status = 'approved' AND paused = 0 ORDER BY name COLLATE NOCASE")
    .all()
    .map((p) => ({ id: p.id, name: p.name || new URL(p.url).host, url: p.url, video_count: p.video_count }));
}

// ---- public network API (for this instance's own frontend) -----------------------------

export const networkRouter = Router();

networkRouter.get('/peers', (req, res) => res.json({ enabled: fedEnabled(), peers: networkPeers() }));

networkRouter.get('/videos/:peerId/:remoteId', (req, res) => {
  if (!fedEnabled()) throw new HttpError(404, 'Video not found');
  const sel = `SELECT r.*, p.name AS peer_name, p.url AS peer_url FROM remote_videos r JOIN peers p ON p.id = r.peer_id
    WHERE p.status = 'approved' AND p.paused = 0`;
  const row = db.prepare(`${sel} AND r.peer_id = ? AND r.remote_id = ?`).get(Number(req.params.peerId), String(req.params.remoteId));
  if (!row) throw new HttpError(404, 'Video not found');
  const related = db.prepare(`${sel} AND r.peer_id = ? AND r.remote_id != ? ORDER BY r.created_at DESC LIMIT 12`).all(row.peer_id, row.remote_id);
  res.json({ video: serializeRemote(row), related: related.map(serializeRemote) });
});

// ---- admin API ------------------------------------------------------------------

export const federationAdminRouter = Router();
federationAdminRouter.use(requireAdmin);

function adminState(req) {
  const s = getSettings();
  const peerUrls = new Set(db.prepare('SELECT url FROM peers').all().map((p) => p.url));
  return {
    settings: { enabled: s.federation_enabled === 'true', mode: s.federation_mode, description: s.instance_description },
    self_url: selfUrl(req),
    public_url_set: !!s.public_url,
    allow_private: ALLOW_PRIVATE_FEDERATION,
    peers: db.prepare('SELECT * FROM peers ORDER BY created_at').all().map(publicPeer),
    followers: db
      .prepare('SELECT * FROM followers ORDER BY created_at')
      .all()
      .map((f) => ({
        id: f.id, url: f.url, name: f.name || new URL(f.url).host, status: f.status,
        created_at: f.created_at, last_seen_at: f.last_seen_at, following_back: peerUrls.has(f.url),
      })),
  };
}

federationAdminRouter.get('/', (req, res) => res.json(adminState(req)));

federationAdminRouter.patch('/', (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) setSetting('federation_enabled', b.enabled ? 'true' : 'false');
  if (b.mode !== undefined) {
    if (!['approval', 'open'].includes(b.mode)) throw new HttpError(400, 'Mode must be approval or open');
    setSetting('federation_mode', b.mode);
  }
  if (b.description !== undefined) setSetting('instance_description', str(b.description, 500));
  if (b.enabled) syncAll().catch(() => {});
  res.json(adminState(req));
});

federationAdminRouter.post('/peers', async (req, res) => {
  await followPeer(req.body?.url, req);
  res.status(201).json(adminState(req));
});

federationAdminRouter.post('/peers/:id/sync', async (req, res) => {
  const p = getPeer(req.params.id);
  if (!p) throw new HttpError(404, 'Peer not found');
  if (!p.token) await followPeer(p.url, req);
  else await syncPeer({ ...p, last_full_sync_at: 0 });
  res.json(adminState(req));
});

federationAdminRouter.patch('/peers/:id', (req, res) => {
  const p = getPeer(req.params.id);
  if (!p) throw new HttpError(404, 'Peer not found');
  if (req.body?.paused !== undefined) db.prepare('UPDATE peers SET paused = ? WHERE id = ?').run(req.body.paused ? 1 : 0, p.id);
  res.json(adminState(req));
});

federationAdminRouter.delete('/peers/:id', async (req, res) => {
  await unfollowPeer(req.params.id);
  res.json(adminState(req));
});

federationAdminRouter.patch('/followers/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM followers WHERE id = ?').get(Number(req.params.id));
  if (!f) throw new HttpError(404, 'Follower not found');
  const status = req.body?.status;
  if (!['approved', 'blocked', 'pending'].includes(status)) throw new HttpError(400, 'Status must be approved, blocked or pending');
  db.prepare('UPDATE followers SET status = ? WHERE id = ?').run(status, f.id);
  res.json(adminState(req));
});

federationAdminRouter.delete('/followers/:id', (req, res) => {
  db.prepare('DELETE FROM followers WHERE id = ?').run(Number(req.params.id));
  res.json(adminState(req));
});
