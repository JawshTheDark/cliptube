/**
 * Watch parties: people watching the same videos at the same moment, with chat and reactions.
 *
 * The host starts a party from a video or a playlist and shares its link; anyone with the link can join
 * (people without an account here pick a name). The server keeps the playback state: which video, playing or
 * paused, where it was, and when that was true. Every player works out where it should be from that and its
 * estimate of the server's clock, and corrects itself. The host steers, or lets everyone steer; while the host
 * is away, anyone can. The queue is a playlist of the party's own (kind 'party').
 * Real-time traffic goes through rooms.js. Mounted at /api/parties.
 */
import { Router } from 'express';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, newId, now, str } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';
import { addItem, createPlaylist, parseRef, playlistView, refOf, removeItem, reorder } from './playlists.js';
import {
  REACTIONS, addGuest, ban, broadcast, chat, deleteMessage, dropRoom, isBanned, isOnline, memberOf, membersOf, messagesOf, openStream, react, throttle, wasSeen,
} from './rooms.js';

const MAX_HOSTED = 5;
const IDLE_MS = 24 * 3600_000;
const roomOf = (p) => `party:${p.id}`;
const getParty = (id) => db.prepare('SELECT * FROM parties WHERE id = ?').get(String(id));
const hostOf = (p) => db.prepare('SELECT * FROM users WHERE id = ?').get(p.host_id);
const queueIds = (p) => db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY position, id').all(p.playlist_id).map((x) => x.id);

function stateOf(p) {
  try {
    return JSON.parse(p.state || '{}');
  } catch {
    return {};
  }
}
/** Where playback is now, by the server's clock. */
const positionNow = (s) => Math.max(0, (Number(s.position) || 0) + (s.playing ? (now() - (s.at || now())) / 1000 : 0));

function partyFor(req) {
  const p = getParty(req.params.id);
  if (!p) throw new HttpError(404, 'This watch party has ended');
  return p;
}

/** The member asking. Kicked members stay out. */
function memberFor(req, p, { required = true } = {}) {
  const m = memberOf(req, roomOf(p));
  if (!m) {
    if (required) throw new HttpError(401, 'Join the party first');
    return null;
  }
  if (isBanned(roomOf(p), m.id)) throw new HttpError(403, 'The host removed you from this party');
  return m;
}

const isHost = (p, m) => !!m && m.user_id === p.host_id;
/** Who steers playback and the queue: the host; everyone, when the host allows it; anyone while the host is away. */
const canControl = (p, m) => !!m && (isHost(p, m) || p.control === 'everyone' || !isOnline(roomOf(p), `u:${p.host_id}`));

const queueOf = (p) => playlistView(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.playlist_id), hostOf(p)).items;

function info(p, m) {
  const host = hostOf(p);
  return {
    id: p.id,
    title: p.title,
    control: p.control,
    locked: !!p.locked,
    host: host ? { username: host.username, display_name: host.display_name, member_id: `u:${host.id}` } : null,
    state: stateOf(p),
    queue: queueOf(p),
    messages: messagesOf(roomOf(p)),
    members: membersOf(roomOf(p)),
    reactions: REACTIONS,
    you: m ? { member_id: m.id, name: m.name, guest: m.guest, is_host: isHost(p, m), can_control: canControl(p, m) } : null,
    now: now(),
  };
}

function touch(p) {
  db.prepare('UPDATE parties SET last_active_at = ? WHERE id = ?').run(now(), p.id);
}

function setState(p, patch) {
  const s = { ...stateOf(p), ...patch, at: now() };
  if (s.playing === undefined) s.playing = false;
  db.prepare('UPDATE parties SET state = ?, last_active_at = ? WHERE id = ?').run(JSON.stringify(s), now(), p.id);
  broadcast(roomOf(p), 'state', { ...s, now: now() });
  return s;
}

function queueChanged(p) {
  touch(p);
  broadcast(roomOf(p), 'queue', { queue: queueOf(p) });
}

/** After the queue changed: make sure the state points at something still in it. */
function keepCurrent(p, removedIndex = 0) {
  const s = stateOf(p);
  const ids = queueIds(p);
  if (s.item_id && ids.includes(s.item_id)) return;
  const next = ids[Math.min(removedIndex, ids.length - 1)] ?? null;
  setState(getParty(p.id), { item_id: next, position: 0, playing: false });
}

export const partiesRouter = Router();

// Start a party from a video ({ ref }) or a playlist ({ playlist_id }).
partiesRouter.post('/', requireAuth, (req, res) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM parties WHERE host_id = ?').get(req.user.id).n >= MAX_HOSTED) {
    throw new HttpError(400, `You can host up to ${MAX_HOSTED} watch parties at once. End one first.`);
  }
  const b = req.body || {};
  let source = null;
  if (b.playlist_id) {
    source = db.prepare("SELECT * FROM playlists WHERE id = ? AND kind != 'party'").get(String(b.playlist_id));
    if (!source || (source.visibility === 'private' && source.user_id !== req.user.id)) throw new HttpError(404, 'Playlist not found');
  } else if (!b.ref) {
    throw new HttpError(400, 'Pick a video or a playlist to watch together');
  }
  const queue = createPlaylist(req.user.id, { title: 'Watch party', visibility: 'unlisted', kind: 'party' });
  try {
    if (b.ref) addItem(queue, parseRef(b.ref), req.user);
    else {
      for (const it of db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id').all(source.id)) {
        try {
          addItem(queue, parseRef(refOf(it)), req.user);
        } catch {}
      }
    }
  } catch (e) {
    db.prepare('DELETE FROM playlists WHERE id = ?').run(queue.id);
    throw e;
  }
  const first = db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id LIMIT 1').get(queue.id);
  if (!first) {
    db.prepare('DELETE FROM playlists WHERE id = ?').run(queue.id);
    throw new HttpError(400, 'None of those videos can be played');
  }
  const id = newId(9);
  const t = now();
  const title = str(b.title, 100).trim() || (source ? source.title : first.title) || 'Watch party';
  db.prepare('INSERT INTO parties (id, host_id, title, playlist_id, state, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, req.user.id, title, queue.id, JSON.stringify({ item_id: first.id, playing: false, position: 0, at: t }), t, t,
  );
  const p = getParty(id);
  res.status(201).json({ party: info(p, memberOf(req, roomOf(p))) });
});

// Parties you host, so you can get back to them.
partiesRouter.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM parties WHERE host_id = ? ORDER BY last_active_at DESC').all(req.user.id);
  res.json({ parties: rows.map((p) => ({ id: p.id, title: p.title, members: membersOf(roomOf(p)).length, last_active_at: p.last_active_at })) });
});

partiesRouter.get('/:id', (req, res) => {
  const p = partyFor(req);
  res.json({ party: info(p, memberFor(req, p, { required: false })) });
});

// For keeping players in step: the server's clock, to compare with the browser's.
partiesRouter.get('/:id/time', (req, res) => res.json({ now: now() }));

// People without an account here join under a name; their token comes back once.
partiesRouter.post('/:id/join', (req, res) => {
  const p = partyFor(req);
  if (req.user) return res.json({ member_id: `u:${req.user.id}` });
  if (p.locked) throw new HttpError(403, 'The host locked this party: nobody new can join');
  const g = addGuest(roomOf(p), req.body?.name);
  touch(p);
  res.status(201).json(g);
});

partiesRouter.get('/:id/events', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  // A locked party still lets back in people who were already part of it.
  if (p.locked && !isHost(p, m) && !wasSeen(roomOf(p), m.id)) throw new HttpError(403, 'The host locked this party: nobody new can join');
  touch(p);
  openStream(req, res, roomOf(p), m, info(p, m));
});

partiesRouter.post('/:id/control', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  if (!canControl(p, m)) throw new HttpError(403, 'Only the host controls playback');
  throttle(`${roomOf(p)}:${m.id}:control`, 20, 10_000);
  const b = req.body || {};
  const s = stateOf(p);
  const ids = queueIds(p);
  const at = Number.isFinite(Number(b.position)) ? Math.max(0, Number(b.position)) : positionNow(s);
  const i = ids.indexOf(s.item_id);
  let next;
  switch (String(b.action)) {
    case 'play':
      next = { playing: true, position: at };
      break;
    case 'pause':
      next = { playing: false, position: at };
      break;
    case 'seek':
      next = { position: at };
      break;
    case 'select': {
      const id = Number(b.item_id);
      if (!ids.includes(id)) throw new HttpError(404, 'That video is not in the queue');
      next = { item_id: id, position: 0, playing: true };
      break;
    }
    case 'ended':
      // Several players report the end; only the first one for the current video moves the party on.
      if (Number(b.item_id) !== s.item_id) return res.json({ state: s });
    // falls through
    case 'next':
      next = i + 1 < ids.length ? { item_id: ids[i + 1], position: 0, playing: true } : { playing: false, position: b.action === 'ended' ? at : positionNow(s) };
      break;
    case 'prev':
      next = i > 0 ? { item_id: ids[i - 1], position: 0, playing: true } : { position: 0 };
      break;
    default:
      throw new HttpError(400, 'Unknown action');
  }
  res.json({ state: setState(p, next) });
});

// ---- the queue -------------------------------------------------------------------------------------------

partiesRouter.post('/:id/queue', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  if (!canControl(p, m)) throw new HttpError(403, 'Only the host changes the queue');
  const queue = db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.playlist_id);
  const viewer = req.user || null; // guests can add what anyone may see
  const b = req.body || {};
  if (b.playlist_id) {
    const src = db.prepare("SELECT * FROM playlists WHERE id = ? AND kind != 'party'").get(String(b.playlist_id));
    if (!src || (src.visibility === 'private' && src.user_id !== viewer?.id)) throw new HttpError(404, 'Playlist not found');
    for (const it of db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id').all(src.id)) {
      try {
        addItem(queue, parseRef(refOf(it)), viewer);
      } catch {}
    }
  } else {
    addItem(queue, parseRef(b.ref), viewer);
  }
  if (!stateOf(p).item_id) keepCurrent(p);
  queueChanged(p);
  res.status(201).json({ queue: queueOf(p) });
});

partiesRouter.delete('/:id/queue/:itemId', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  if (!canControl(p, m)) throw new HttpError(403, 'Only the host changes the queue');
  const before = queueIds(p).indexOf(Number(req.params.itemId));
  removeItem(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.playlist_id), req.params.itemId);
  keepCurrent(getParty(p.id), Math.max(0, before));
  queueChanged(p);
  res.json({ queue: queueOf(p) });
});

partiesRouter.put('/:id/queue/order', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  if (!canControl(p, m)) throw new HttpError(403, 'Only the host changes the queue');
  reorder(db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.playlist_id), req.body?.item_ids);
  queueChanged(p);
  res.json({ queue: queueOf(p) });
});

// ---- chat and reactions ----------------------------------------------------------------------------------

partiesRouter.post('/:id/chat', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  touch(p);
  res.status(201).json({ message: chat(roomOf(p), m, req.body?.body) });
});

partiesRouter.delete('/:id/chat/:msgId', (req, res) => {
  const p = partyFor(req);
  const m = memberFor(req, p);
  const msg = db.prepare('SELECT * FROM room_messages WHERE room = ? AND id = ?').get(roomOf(p), Number(req.params.msgId));
  if (!msg) throw new HttpError(404, 'Message not found');
  if (!isHost(p, m) && msg.member_id !== m.id) throw new HttpError(403, 'Only the host removes other people\'s messages');
  deleteMessage(roomOf(p), msg.id);
  res.json({ ok: true });
});

partiesRouter.post('/:id/react', (req, res) => {
  const p = partyFor(req);
  react(roomOf(p), memberFor(req, p), String(req.body?.emoji || ''));
  res.json({ ok: true });
});

// ---- the host --------------------------------------------------------------------------------------------

function hostOnly(req, p) {
  const m = memberFor(req, p);
  if (!isHost(p, m)) throw new HttpError(403, 'Only the host can do that');
  return m;
}

partiesRouter.patch('/:id', (req, res) => {
  const p = partyFor(req);
  hostOnly(req, p);
  const b = req.body || {};
  const title = b.title !== undefined ? str(b.title, 100).trim() || p.title : p.title;
  const control = b.control !== undefined ? (b.control === 'everyone' ? 'everyone' : 'host') : p.control;
  const locked = b.locked !== undefined ? (b.locked ? 1 : 0) : p.locked;
  db.prepare('UPDATE parties SET title = ?, control = ?, locked = ?, last_active_at = ? WHERE id = ?').run(title, control, locked, now(), p.id);
  broadcast(roomOf(p), 'settings', { title, control, locked: !!locked });
  res.json({ party: info(getParty(p.id), memberFor(req, p)) });
});

partiesRouter.post('/:id/kick', (req, res) => {
  const p = partyFor(req);
  hostOnly(req, p);
  const target = String(req.body?.member_id || '');
  if (!target || target === `u:${p.host_id}`) throw new HttpError(400, 'Pick someone else');
  ban(roomOf(p), target);
  res.json({ members: membersOf(roomOf(p)) });
});

/** Ends a party: everyone is told, and its queue, messages and guests are forgotten. */
export function endParty(p) {
  broadcast(roomOf(p), 'ended', {});
  dropRoom(roomOf(p));
  db.prepare('DELETE FROM parties WHERE id = ?').run(p.id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(p.playlist_id);
}

partiesRouter.delete('/:id', (req, res) => {
  const p = partyFor(req);
  hostOnly(req, p);
  endParty(p);
  res.json({ ok: true });
});

// Parties nobody has used for a day end on their own.
defineJob('parties.cleanup', {
  maxAttempts: 1,
  handler: () => {
    try {
      for (const p of db.prepare('SELECT * FROM parties WHERE last_active_at < ?').all(now() - IDLE_MS)) {
        if (!membersOf(roomOf(p)).length) endParty(p);
      }
    } finally {
      enqueueJob('parties.cleanup', {}, { delay: 3600_000, dedupe: 'parties-cleanup' });
    }
  },
});
export const startPartyCleanup = () => enqueueJob('parties.cleanup', {}, { delay: 600_000, dedupe: 'parties-cleanup' });
