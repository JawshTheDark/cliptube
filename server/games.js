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
import { NETWORK_VISIBLE, isHub, networkRole, onHubGames, onLocalVideosChanged } from './network.js';
import { indexVideo } from './search.js';
import { getSettings } from './db.js';
import { ART, applyImage, autoArtwork, bestMatch, clearImage, listImages, queueArtwork, searchGames, sgdbAuto, sgdbConfigured } from './steamgriddb.js';
import { enqueueJob } from './jobs.js';

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
    artwork_url: g.artwork ? `/media/thumbs/${g.artwork}` : g.artwork_url || null,
    logo_url: g.logo ? `/media/thumbs/${g.logo}` : g.logo_url || null, // the title as a transparent logo
    hero_url: g.hero ? `/media/thumbs/${g.hero}` : g.hero_url || null, // a wide banner
    sgdb_id: g.sgdb_id || null,
    credits: artCredits(g),
    from_hub: g.source === 'hub', // managed by the network hub's catalog
    ...(withCounts ? counts(g) : {}),
  };
}

function artCredits(g) {
  try {
    const c = JSON.parse(g.art_credits || 'null');
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

/** Removes a game: its clips stay, without a game. */
function deleteGame(g) {
  const affected = touchGameVideos(g.id);
  db.prepare('UPDATE videos SET game_id = NULL WHERE game_id = ?').run(g.id);
  for (const vid of affected) indexVideo(vid);
  db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
  for (const f of [g.artwork, g.logo, g.hero]) if (f) try { fs.unlinkSync(path.join(DIRS.thumbs, f)); } catch {}
}

/**
 * Files everything under `from` under `into` instead (clips, live channels and streams) and deletes `from`.
 * Where `into` is changed here (this site's own game, or any game on a hub), `from`'s id and aliases become
 * aliases of it, so links and other sites' clips under the old id still find it; on a hub that also
 * tells members to merge their copy at their next sync.
 */
export function mergeGame(from, into, user = null) {
  if (from.id === into.id) throw new HttpError(400, 'Pick another game to merge into');
  db.prepare('UPDATE videos SET game_id = ? WHERE game_id = ?').run(into.id, from.id);
  db.prepare('UPDATE live_channels SET game_id = ? WHERE game_id = ?').run(into.id, from.id);
  db.prepare('UPDATE live_streams SET game_id = ? WHERE game_id = ?').run(into.id, from.id);
  if (into.source !== 'hub' || isHub()) {
    const aliases = cleanAliases([...aliasList(into), from.id, ...aliasList(from)], into.id);
    db.prepare('UPDATE games SET aliases = ? WHERE id = ?').run(aliases, into.id);
  }
  db.prepare('DELETE FROM games WHERE id = ?').run(from.id);
  for (const f of [from.artwork, from.logo, from.hero]) if (f) try { fs.unlinkSync(path.join(DIRS.thumbs, f)); } catch {}
  // Changed clips go out again, so other sites file them under the game's new id too.
  for (const vid of touchGameVideos(into.id)) indexVideo(vid);
  logAction(user, 'game.merge', { targetType: 'game', targetId: into.id, targetLabel: into.name, details: `${from.name} (${from.id}) merged in` });
  return db.prepare('SELECT * FROM games WHERE id = ?').get(into.id);
}

/** A name with case, accents and punctuation set aside, in full (ids stop at 30 characters, names don't). */
const nameKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The hub's catalog, applied on a member: its games are added or updated (the hub's version wins), and
 * games that came from it but are gone there are deleted here as well. Games made here stay.
 */
onHubGames((list, hubUrl) => {
  const hubHost = (() => {
    try {
      return new URL(hubUrl).host;
    } catch {
      return '';
    }
  })();
  const art = (u) => {
    try {
      const x = new URL(String(u || ''));
      return x.host === hubHost && /^https?:$/.test(x.protocol) ? x.href : null;
    } catch {
      return null;
    }
  };
  const seen = new Set();
  let changed = 0;
  for (const raw of list.slice(0, 5000)) {
    const id = slugify(raw?.id);
    const name = str(raw?.name, 80).trim();
    if (!id || id !== raw.id || !name) continue;
    seen.add(id);
    const short = str(raw.short_name, 30).trim() || null;
    const aliases = cleanAliases(raw.aliases, id);
    const artwork = art(raw.artwork_url);
    const logo = art(raw.logo_url);
    const hero = art(raw.hero_url);
    const sgdb = Number.isInteger(Number(raw.sgdb_id)) && Number(raw.sgdb_id) > 0 ? Number(raw.sgdb_id) : null;
    const credits = raw.credits && typeof raw.credits === 'object' ? JSON.stringify(raw.credits).slice(0, 2000) : null;
    const g = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    const vals = [name, short, aliases, artwork, logo, hero, sgdb, credits];
    if (!g) {
      db.prepare("INSERT INTO games (name, short_name, aliases, artwork_url, logo_url, hero_url, sgdb_id, art_credits, id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'hub', ?)").run(...vals, id, now());
      changed++;
    } else if (
      g.source !== 'hub' || g.name !== name || (g.short_name || null) !== short || (g.aliases || '') !== aliases || (g.artwork_url || null) !== artwork ||
      (g.logo_url || null) !== logo || (g.hero_url || null) !== hero || (g.sgdb_id || null) !== sgdb || (g.art_credits || null) !== credits
    ) {
      db.prepare("UPDATE games SET name = ?, short_name = ?, aliases = ?, artwork_url = ?, logo_url = ?, hero_url = ?, sgdb_id = ?, art_credits = ?, source = 'hub' WHERE id = ?").run(...vals, id);
      if (g.name !== name || (g.aliases || '') !== aliases) for (const vid of touchGameVideos(id)) indexVideo(vid);
      changed++;
    }
  }
  const hubGames = db.prepare("SELECT * FROM games WHERE source = 'hub'").all();
  for (const g of hubGames) {
    if (seen.has(g.id)) continue;
    // Merged into another game on the hub, which then lists it as an alias: its clips go there too.
    const into = hubGames.find((h) => seen.has(h.id) && aliasList(h).includes(g.id));
    if (into) mergeGame(g, into);
    else deleteGame(g);
    changed++;
  }
  // A game made here that the hub has too, under the same name or one the hub's game is known by, becomes
  // the hub's (two of one game would split its clips here and across the network).
  const current = db.prepare("SELECT * FROM games WHERE source = 'hub'").all();
  for (const g of db.prepare("SELECT * FROM games WHERE COALESCE(source, '') != 'hub'").all()) {
    const into = current.find((h) => nameKey(h.name) === nameKey(g.name)) || current.find((h) => aliasList(h).includes(g.id) || aliasList(g).includes(h.id));
    if (!into) continue;
    mergeGame(g, into);
    console.log(`[games] ${g.name} (${g.id}) merged into the hub's ${into.name} (${into.id})`);
    changed++;
  }
  if (changed) console.log(`[games] ${changed} change(s) from the hub's catalog`);
});

/** Games from the hub's catalog are changed on the hub, not on a member. */
function ownGame(g) {
  if (g.source === 'hub' && !isHub()) throw new HttpError(403, "This game comes from the network hub's catalog, so it's changed there");
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
  const same = db.prepare('SELECT * FROM games').all().find((g) => nameKey(g.name) === nameKey(name));
  if (same) throw new HttpError(409, `${same.name} is already in the list (${same.id})`);
  db.prepare('INSERT INTO games (id, name, short_name, aliases, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, name, str(b.short_name, 30).trim() || null, cleanAliases(b.aliases, id), user?.id || null, now(),
  );
  logAction(user, 'game.create', { targetType: 'game', targetId: id, targetLabel: name });
  queueArtwork(id); // covers, logo and banner from SteamGridDB, when it's set up
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
  return db.prepare('SELECT id FROM videos WHERE game_id = ?').all(id).map((x) => x.id);
}

export const gamesRouter = Router();

gamesRouter.get('/', (req, res) => {
  const games = db.prepare('SELECT * FROM games ORDER BY name COLLATE NOCASE').all().map((g) => serializeGame(g, true));
  const s = getSettings();
  // Where the catalog comes from: this instance (and, on a hub, the whole network) or a hub.
  res.json({
    games,
    catalog: { is_hub: isHub(), hub_url: networkRole() === 'member' ? s.network_hub_url || null : null },
    steamgriddb: { configured: sgdbConfigured(), auto: sgdbAuto() },
  });
});

// ---- artwork from SteamGridDB (moderators; an admin saves the API key) ------------------------------------

gamesRouter.get('/steamgriddb/search', requireModerator, async (req, res) => {
  res.json({ results: await searchGames(req.query.q) });
});

// Fills in missing artwork for every game of this site's own (not the hub's), in the background.
gamesRouter.post('/steamgriddb/fill', requireModerator, (req, res) => {
  if (!sgdbConfigured()) throw new HttpError(400, 'Add a SteamGridDB API key first (Admin → Games)');
  const rows = db.prepare("SELECT id FROM games WHERE COALESCE(source, '') != 'hub' AND (artwork IS NULL OR logo IS NULL OR hero IS NULL)").all();
  for (const g of rows) enqueueJob('games.artwork', { id: g.id }, { dedupe: `games-artwork:${g.id}` });
  res.status(202).json({ queued: rows.length });
});

const ownGameRow = (req) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  if (!g) throw new HttpError(404, 'Game not found');
  ownGame(g);
  return g;
};

// The covers, logos or banners SteamGridDB has for this game (or for the SteamGridDB game picked).
gamesRouter.get('/:id/steamgriddb', requireModerator, async (req, res) => {
  const g = ownGameRow(req);
  const kind = ART[req.query.kind] ? String(req.query.kind) : 'cover';
  let sgdbId = Number(req.query.sgdb_id) || g.sgdb_id;
  if (!sgdbId) {
    sgdbId = bestMatch(await searchGames(g.name), g.name)?.id || null;
  }
  res.json({ sgdb_id: sgdbId, kind, images: sgdbId ? await listImages(kind, sgdbId) : [] });
});

gamesRouter.post('/:id/steamgriddb', requireModerator, async (req, res) => {
  const g = ownGameRow(req);
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!ART[kind]) throw new HttpError(400, 'Artwork is cover, logo or hero');
  // Looked up again, so what gets saved (and credited) is SteamGridDB's, not the browser's.
  const image = (await listImages(kind, b.sgdb_id)).find((x) => x.id === Number(b.image_id));
  if (!image) throw new HttpError(404, 'That image is no longer on SteamGridDB');
  await applyImage(g, kind, image, b.sgdb_id);
  logAction(req.user, 'game.update', { targetType: 'game', targetId: g.id, targetLabel: `${g.name}: ${kind} from SteamGridDB` });
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

gamesRouter.post('/:id/steamgriddb/auto', requireModerator, async (req, res) => {
  const g = ownGameRow(req);
  const r = await autoArtwork(g.id, { force: req.body?.force === true });
  res.json({ applied: r.applied, game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

gamesRouter.delete('/:id/art/:kind', requireModerator, (req, res) => {
  const g = ownGameRow(req);
  clearImage(g, String(req.params.kind));
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
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
  ownGame(g);
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, 80).trim() : g.name;
  if (!name) throw new HttpError(400, 'Name the game');
  const short = b.short_name !== undefined ? str(b.short_name, 30).trim() || null : g.short_name;
  const aliases = b.aliases !== undefined ? cleanAliases(b.aliases, g.id) : g.aliases;
  db.prepare('UPDATE games SET name = ?, short_name = ?, aliases = ? WHERE id = ?').run(name, short, aliases, g.id);
  logAction(req.user, 'game.update', { targetType: 'game', targetId: g.id, targetLabel: name });
  if (name !== g.name || aliases !== g.aliases || short !== g.short_name) for (const vid of touchGameVideos(g.id)) indexVideo(vid);
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

gamesRouter.post('/:id/artwork', requireModerator, imageUpload('artwork'), async (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  try {
    if (!g) throw new HttpError(404, 'Game not found');
    ownGame(g);
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
  ownGame(g);
  if (g.artwork) try { fs.unlinkSync(path.join(DIRS.thumbs, g.artwork)); } catch {}
  db.prepare('UPDATE games SET artwork = NULL WHERE id = ?').run(g.id);
  res.json({ game: serializeGame(db.prepare('SELECT * FROM games WHERE id = ?').get(g.id), true) });
});

// Two entries for one game: the first one's clips move to the second, and the first goes.
gamesRouter.post('/:id/merge', requireModerator, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  if (!g) throw new HttpError(404, 'Game not found');
  ownGame(g);
  const into = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.body?.into || ''));
  if (!into) throw new HttpError(404, 'The game to merge into was not found');
  res.json({ game: serializeGame(mergeGame(g, into, req.user), true) });
});

gamesRouter.delete('/:id', requireModerator, (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(String(req.params.id));
  if (!g) throw new HttpError(404, 'Game not found');
  ownGame(g);
  // On the hub, this takes the game out of every member's catalog at their next sync.
  deleteGame(g);
  logAction(req.user, 'game.delete', { targetType: 'game', targetId: g.id, targetLabel: g.name });
  res.json({ ok: true });
});
