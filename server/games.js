/**
 * Games: a per-instance list (name, short name, aliases, artwork) that videos can be filed under.
 * The game id is a slug that also travels with videos across the network, so other instances can
 * group clips by game even when their own list spells the name differently (via aliases).
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { DIRS } from './config.js';
import { requireModerator } from './auth.js';
import { HttpError, now, str } from './util.js';
import { imageUpload, discard } from './uploads.js';
import { convertImage } from './media.js';
import { logAction } from './reports.js';
import { NETWORK_VISIBLE, onLocalVideosChanged } from './network.js';

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}

const aliasList = (g) => String(g?.aliases || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Every slug that means this game: its id and its aliases. */
export function gameSlugs(g) {
  return [g.id, ...aliasList(g)];
}

/** SQL (and params) matching network videos filed under any of these slugs, by game field or tag. */
export function networkGameWhere(slugs) {
  const ors = [`r.game_slug IN (${slugs.map(() => '?').join(', ')})`];
  const params = [...slugs];
  for (const s of slugs) {
    ors.push("(',' || r.tags || ',') LIKE ?");
    params.push(`%,${s},%`);
  }
  return { sql: `(${ors.join(' OR ')})`, params };
}

function counts(g) {
  const local = db
    .prepare("SELECT COUNT(*) AS n FROM videos v WHERE v.game_id = ? AND v.status = 'ready' AND v.visibility = 'public' AND v.moderation_status IS NULL")
    .get(g.id).n;
  const w = networkGameWhere(gameSlugs(g));
  const network = db
    .prepare(`SELECT COUNT(*) AS n FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${NETWORK_VISIBLE} AND ${w.sql}`)
    .get(...w.params).n;
  return { video_count: local, network_count: network };
}

export function serializeGame(g, withCounts = false) {
  return {
    id: g.id,
    name: g.name,
    short_name: g.short_name || null,
    aliases: aliasList(g),
    artwork_url: g.artwork ? `/media/thumbs/${g.artwork}` : null,
    ...(withCounts ? counts(g) : {}),
  };
}

/** Finds a game by id, name, short name or alias. */
export function findGame(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const slug = slugify(raw);
  const direct = db.prepare('SELECT * FROM games WHERE id = ? OR id = ?').get(raw, slug);
  if (direct) return direct;
  const lower = raw.toLowerCase();
  for (const g of db.prepare('SELECT * FROM games').all()) {
    if (g.name.toLowerCase() === lower || (g.short_name || '').toLowerCase() === lower || aliasList(g).includes(slug)) return g;
  }
  return null;
}

function cleanAliases(input, id) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (const a of list) {
    const s = slugify(a);
    if (s && s !== id && !out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out.join(',');
}

export function createGame(b, user) {
  const name = str(b.name, 80).trim();
  if (!name) throw new HttpError(400, 'Name the game');
  const id = slugify(b.id || b.short_name || name);
  if (!id) throw new HttpError(400, 'The name needs at least one letter or number');
  if (db.prepare('SELECT 1 FROM games WHERE id = ?').get(id)) throw new HttpError(409, 'That game is already in the list');
  db.prepare('INSERT INTO games (id, name, short_name, aliases, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, name, str(b.short_name, 30).trim() || null, cleanAliases(b.aliases, id), user?.id || null, now(),
  );
  logAction(user, 'game.create', { targetType: 'game', targetId: id, targetLabel: name });
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
}

/**
 * The game id for an upload or edit. Anyone can pick a game from the list; moderators can also
 * type a new name, which adds it. undefined = leave unchanged, null = no game.
 */
export function resolveGame(input, user) {
  if (input === undefined) return undefined;
  if (input === null || String(input).trim() === '') return null;
  const g = findGame(input);
  if (g) return g.id;
  if (!user?.is_moderator) throw new HttpError(400, `"${str(input, 60).trim()}" isn't in this site's game list yet. Ask a moderator to add it.`);
  return createGame({ name: input }, user).id;
}

/** Bumps videos filed under a game so the network picks up the change (rename, deletion). */
function touchGameVideos(id) {
  const r = db.prepare('UPDATE videos SET updated_at = ? WHERE game_id = ?').run(now(), id);
  if (r.changes) onLocalVideosChanged();
}

export const gamesRouter = Router();

gamesRouter.get('/', (req, res) => {
  const games = db.prepare('SELECT * FROM games ORDER BY name COLLATE NOCASE').all().map((g) => serializeGame(g, true));
  res.json({ games });
});

gamesRouter.get('/:id', (req, res) => {
  const g = findGame(req.params.id);
  if (g) return res.json({ game: serializeGame(g, true) });
  // A game only other instances use: still browsable from their videos.
  const slug = slugify(req.params.id);
  const remote = slug && db.prepare('SELECT game_name FROM network_videos WHERE game_slug = ? AND game_name IS NOT NULL LIMIT 1').get(slug);
  if (!remote) throw new HttpError(404, 'Game not found');
  const w = networkGameWhere([slug]);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${NETWORK_VISIBLE} AND ${w.sql}`).get(...w.params).n;
  res.json({ game: { id: slug, name: remote.game_name, short_name: null, aliases: [], artwork_url: null, video_count: 0, network_count: n, remote_only: true } });
});

gamesRouter.post('/', requireModerator, (req, res) => {
  res.status(201).json({ game: serializeGame(createGame(req.body || {}, req.user), true) });
});

gamesRouter.patch('/:id', requireModerator, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  if (!g) throw new HttpError(404, 'Game not found');
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, 80).trim() : g.name;
  if (!name) throw new HttpError(400, 'Name the game');
  const short = b.short_name !== undefined ? str(b.short_name, 30).trim() || null : g.short_name;
  const aliases = b.aliases !== undefined ? cleanAliases(b.aliases, g.id) : g.aliases;
  db.prepare('UPDATE games SET name = ?, short_name = ?, aliases = ? WHERE id = ?').run(name, short, aliases, g.id);
  logAction(req.user, 'game.update', { targetType: 'game', targetId: g.id, targetLabel: name });
  if (name !== g.name) touchGameVideos(g.id);
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

gamesRouter.post('/:id/artwork', requireModerator, imageUpload('artwork'), async (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  try {
    if (!g) throw new HttpError(404, 'Game not found');
    if (!req.file) throw new HttpError(400, 'No image was received');
    const name = `game-${g.id}-${Date.now()}.jpg`;
    try {
      await convertImage(req.file.path, path.join(DIRS.thumbs, name), 'cover');
    } catch (e) {
      throw new HttpError(400, `Could not read that image: ${e.message}`);
    }
    if (g.artwork) try { fs.unlinkSync(path.join(DIRS.thumbs, g.artwork)); } catch {}
    db.prepare('UPDATE games SET artwork = ? WHERE id = ?').run(name, g.id);
  } finally {
    discard(req.file);
  }
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

gamesRouter.delete('/:id/artwork', requireModerator, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  if (!g) throw new HttpError(404, 'Game not found');
  if (g.artwork) try { fs.unlinkSync(path.join(DIRS.thumbs, g.artwork)); } catch {}
  db.prepare('UPDATE games SET artwork = NULL WHERE id = ?').run(g.id);
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

gamesRouter.delete('/:id', requireModerator, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  if (!g) throw new HttpError(404, 'Game not found');
  touchGameVideos(g.id);
  db.prepare('UPDATE videos SET game_id = NULL WHERE game_id = ?').run(g.id);
  db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
  if (g.artwork) try { fs.unlinkSync(path.join(DIRS.thumbs, g.artwork)); } catch {}
  logAction(req.user, 'game.delete', { targetType: 'game', targetId: g.id, targetLabel: g.name });
  res.json({ ok: true });
});
