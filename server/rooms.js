/**
 * Rooms: things people do together in real time, such as a watch party or a live stream's chat. Members
 * follow a room over server-sent events (plain HTTP, so reverse proxies need no WebSocket setup) and act
 * through ordinary POSTs. Signed-in people take part as themselves; anyone else picks a name and gets a
 * guest token for that room. Chat messages are kept (the latest 200 per room) for people who join later.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError, now, str } from './util.js';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const KEEPALIVE_MS = 15_000;
export const REACTIONS = ['👍', '😂', '😮', '😢', '🔥', '❤️', '👏', '🎉'];

/** Live state per room: its open event streams, by member. */
const rooms = new Map(); // room id -> { members: Map(member id -> member) }

function liveRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { id, members: new Map() };
    rooms.set(id, r);
  }
  return r;
}

/**
 * Who is asking, for a room: a signed-in person, or a guest by the token in the `x-room-member` header (or
 * `member` query parameter, for EventSource, which can't set headers). Null when neither.
 */
export function memberOf(req, roomId) {
  if (req.user) {
    return {
      id: `u:${req.user.id}`,
      user_id: req.user.id,
      name: req.user.display_name || req.user.username,
      username: req.user.username,
      avatar_url: req.user.avatar ? `/media/avatars/${req.user.avatar}` : null,
      guest: false,
    };
  }
  const token = String(req.get('x-room-member') || req.query.member || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const g = db.prepare('SELECT * FROM room_guests WHERE token_hash = ? AND room = ?').get(sha256(token), roomId);
  return g ? { id: `g:${g.token_hash.slice(0, 16)}`, user_id: null, name: g.name, username: null, avatar_url: null, guest: true } : null;
}

export const isBanned = (roomId, memberId) => !!db.prepare('SELECT 1 FROM room_bans WHERE room = ? AND member_id = ?').get(roomId, memberId);
/** Whether someone has been in the room before (a locked room still lets them back in). */
export const wasSeen = (roomId, memberId) => !!db.prepare('SELECT 1 FROM room_seen WHERE room = ? AND member_id = ?').get(roomId, memberId);

/** Lets someone without an account into a room under a name of their choosing. Returns their token. */
export function addGuest(roomId, name) {
  const clean = str(name, 32).replace(/\s+/g, ' ').trim();
  if (clean.length < 2) throw new HttpError(400, 'Pick a name of at least 2 characters');
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO room_guests (token_hash, room, name, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), roomId, clean, now());
  return { token, member_id: `g:${sha256(token).slice(0, 16)}`, name: clean };
}

const publicMember = (m) => ({ id: m.id, name: m.name, username: m.username, avatar_url: m.avatar_url, guest: m.guest });

/** The members with an event stream open right now (not counting anonymous viewers). */
export const membersOf = (roomId) => [...(rooms.get(roomId)?.members.values() || [])].filter((m) => !m.anonymous).map(publicMember);
/** Everyone with an event stream open, anonymous viewers included. */
export const viewerCount = (roomId) => rooms.get(roomId)?.members.size || 0;
export const isOnline = (roomId, memberId) => !!rooms.get(roomId)?.members.get(memberId)?.streams.size;

function write(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Sends an event to everyone in the room (or only to `memberId`). */
export function broadcast(roomId, event, data, { memberId = null } = {}) {
  const r = rooms.get(roomId);
  if (!r) return;
  for (const m of r.members.values()) {
    if (memberId && m.id !== memberId) continue;
    for (const res of m.streams) write(res, event, data);
  }
}

/**
 * Opens a member's event stream. `hello` (whatever the room wants a newcomer to know) goes first, then the
 * member list to everyone. The server's clock rides along with every keepalive, for keeping players in sync.
 */
export function openStream(req, res, roomId, member, hello) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const r = liveRoom(roomId);
  let m = r.members.get(member.id);
  const joined = !m;
  if (!m) {
    m = { ...member, streams: new Set() };
    r.members.set(member.id, m);
  }
  m.streams.add(res);
  db.prepare('INSERT OR IGNORE INTO room_seen (room, member_id, first_at) VALUES (?, ?, ?)').run(roomId, member.id, now());
  write(res, 'hello', { ...hello, you: { ...publicMember(m), ...(hello.you || {}) }, now: now() });
  if (joined && !member.anonymous) broadcast(roomId, 'members', { members: membersOf(roomId) });
  else write(res, 'members', { members: membersOf(roomId) });
  const timer = setInterval(() => write(res, 'time', { now: now() }), KEEPALIVE_MS);
  req.on('close', () => {
    clearInterval(timer);
    m.streams.delete(res);
    if (!m.streams.size) {
      r.members.delete(m.id);
      if (!m.anonymous) broadcast(roomId, 'members', { members: membersOf(roomId) });
      if (!r.members.size) rooms.delete(roomId);
    }
  });
}

/** Closes a member's streams (kicked) or everyone's (the room ended). */
export function closeStreams(roomId, memberId = null) {
  const r = rooms.get(roomId);
  if (!r) return;
  for (const m of [...r.members.values()]) {
    if (memberId && m.id !== memberId) continue;
    for (const res of m.streams) res.end();
    r.members.delete(m.id);
  }
  if (!r.members.size) rooms.delete(roomId);
  else broadcast(roomId, 'members', { members: membersOf(roomId) });
}

export function ban(roomId, memberId) {
  db.prepare('INSERT OR IGNORE INTO room_bans (room, member_id, created_at) VALUES (?, ?, ?)').run(roomId, memberId, now());
  closeStreams(roomId, memberId);
}

// ---- chat and reactions ----------------------------------------------------------------------------------

const recent = new Map(); // `${room}:${member}:${kind}` -> timestamps
export function throttle(key, max, windowMs) {
  const t = now();
  const list = (recent.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) throw new HttpError(429, 'Slow down a little');
  list.push(t);
  recent.set(key, list);
}
setInterval(() => {
  const t = now();
  for (const [k, list] of recent) if (!list.some((x) => t - x < 60_000)) recent.delete(k);
}, 60_000).unref();

const serializeMessage = (m) => ({ id: m.id, member_id: m.member_id, name: m.name, body: m.body, created_at: m.created_at });

export function chat(roomId, member, body) {
  const text = str(body, 500).trim();
  if (!text) throw new HttpError(400, 'Say something first');
  throttle(`${roomId}:${member.id}:chat`, 5, 5000);
  const r = db.prepare('INSERT INTO room_messages (room, member_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(roomId, member.id, member.name, text, now());
  db.prepare('DELETE FROM room_messages WHERE room = ? AND id <= (SELECT id FROM room_messages WHERE room = ? ORDER BY id DESC LIMIT 1 OFFSET 200)').run(roomId, roomId);
  const msg = serializeMessage(db.prepare('SELECT * FROM room_messages WHERE id = ?').get(r.lastInsertRowid));
  broadcast(roomId, 'chat', msg);
  return msg;
}

export function deleteMessage(roomId, id) {
  db.prepare('DELETE FROM room_messages WHERE room = ? AND id = ?').run(roomId, Number(id));
  broadcast(roomId, 'chat_deleted', { id: Number(id) });
}

export const messagesOf = (roomId, limit = 100) =>
  db.prepare('SELECT * FROM (SELECT * FROM room_messages WHERE room = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(roomId, limit).map(serializeMessage);

export function react(roomId, member, emoji) {
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, 'Unknown reaction');
  throttle(`${roomId}:${member.id}:react`, 10, 5000);
  broadcast(roomId, 'react', { emoji, name: member.name, member_id: member.id });
}

/** Forgets a room's guests, bans and messages (the room is over). */
export function dropRoom(roomId) {
  closeStreams(roomId);
  db.prepare('DELETE FROM room_guests WHERE room = ?').run(roomId);
  db.prepare('DELETE FROM room_bans WHERE room = ?').run(roomId);
  db.prepare('DELETE FROM room_messages WHERE room = ?').run(roomId);
  db.prepare('DELETE FROM room_seen WHERE room = ?').run(roomId);
}
