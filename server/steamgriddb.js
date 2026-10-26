/**
 * Game artwork from SteamGridDB (https://www.steamgriddb.com): covers (their "grids", 2:3), title logos
 * (transparent PNG) and banners (their "heroes"). A moderator picks them, or they are filled in on their own
 * when a game is added. It needs an API key from a SteamGridDB account, which an admin saves under
 * Admin → Games. The chosen images are copied here (covers and banners re-encoded, logos kept transparent),
 * and each one's author is credited on the game's page. Games from a hub's catalog get the hub's artwork.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings } from './db.js';
import { DIRS, VERSION } from './config.js';
import { HttpError, newId } from './util.js';
import { convertImage } from './media.js';
import { defineJob, enqueueJob } from './jobs.js';

// Tests point this at a stand-in server.
const BASE = (process.env.STEAMGRIDDB_BASE_URL || 'https://www.steamgriddb.com/api/v2').replace(/\/+$/, '');
const TEST_HOST = process.env.STEAMGRIDDB_BASE_URL ? new URL(BASE).host : null;
const imageHostOk = (host) => /(^|\.)steamgriddb\.com$/i.test(host) || (!!TEST_HOST && host === TEST_HOST);
const MAX_IMAGE = 25 * 1048576;

/** What each kind of artwork is called there, what we keep, and where. */
export const ART = {
  cover: { path: 'grids', params: { dimensions: '600x900,660x930,342x482', types: 'static' }, convert: 'cover', ext: 'jpg', column: 'artwork' },
  logo: { path: 'logos', params: { types: 'static', mimes: 'image/png' }, convert: 'logo', ext: 'png', column: 'logo' },
  hero: { path: 'heroes', params: { types: 'static' }, convert: 'hero', ext: 'jpg', column: 'hero' },
};
const SAFE = { nsfw: 'false', humor: 'false', epilepsy: 'false' };

export const sgdbConfigured = () => !!getSettings().steamgriddb_api_key;
export const sgdbAuto = () => sgdbConfigured() && getSettings().steamgriddb_auto !== 'false';

// A name by its letters and digits alone, so "Call of Duty Black Ops 7" is "Call of Duty: Black Ops 7".
const sameName = (s) => String(s || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The SteamGridDB game a name means: the same name ignoring case and punctuation, else the first verified one. */
export function bestMatch(found, name) {
  const want = sameName(name);
  return (want && found.find((x) => sameName(x.name) === want)) || found.find((x) => x.verified) || found[0] || null;
}

async function call(p, params = {}) {
  const key = getSettings().steamgriddb_api_key;
  if (!key) throw new HttpError(400, 'Add a SteamGridDB API key first (Admin → Games)');
  const qs = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetch(`${BASE}${p}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': `OurTube/${VERSION}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new HttpError(502, `Could not reach SteamGridDB: ${e.cause?.code || e.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'SteamGridDB refused the API key. Check it under Admin → Games.');
  if (res.status === 404) return [];
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.success) throw new HttpError(502, `SteamGridDB answered ${res.status}${j?.errors ? `: ${[].concat(j.errors).join(', ')}` : ''}`);
  return Array.isArray(j.data) ? j.data : [];
}

/** Games on SteamGridDB matching a name. */
export async function searchGames(q) {
  const term = String(q || '').trim().slice(0, 100);
  if (!term) return [];
  const list = await call(`/search/autocomplete/${encodeURIComponent(term)}`);
  return list.slice(0, 12).map((g) => ({
    id: Number(g.id),
    name: String(g.name || ''),
    year: Number(g.release_date) > 0 ? new Date(Number(g.release_date) * 1000).getUTCFullYear() : null,
    verified: !!g.verified,
  }));
}

/** Covers, logos or banners for a SteamGridDB game, best first (as SteamGridDB ranks them). */
export async function listImages(kind, sgdbId) {
  const k = ART[kind];
  if (!k) throw new HttpError(400, 'Artwork is cover, logo or hero');
  const id = Number(sgdbId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Pick a SteamGridDB game first');
  const list = await call(`/${k.path}/game/${id}`, { ...k.params, ...SAFE });
  return list.slice(0, 48).map((i) => ({
    id: Number(i.id),
    url: String(i.url || ''),
    thumb: String(i.thumb || i.url || ''),
    width: Number(i.width) || null,
    height: Number(i.height) || null,
    style: Array.isArray(i.style) ? i.style.join(', ') : i.style || null,
    score: Number(i.score) || 0,
    author: i.author?.name ? String(i.author.name).slice(0, 80) : null,
  }));
}

const credits = (g) => {
  try {
    const c = JSON.parse(g.art_credits || '{}');
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
};

/** Copies one image here as the game's cover, logo or banner, crediting its author. */
export async function applyImage(game, kind, image, sgdbId = null) {
  const k = ART[kind];
  if (!k) throw new HttpError(400, 'Artwork is cover, logo or hero');
  let u;
  try {
    u = new URL(String(image?.url || ''));
  } catch {
    throw new HttpError(400, 'Bad image address');
  }
  if (!/^https?:$/.test(u.protocol) || !imageHostOk(u.host)) throw new HttpError(400, 'Images come from SteamGridDB only');
  let res;
  try {
    res = await fetch(u, { headers: { 'User-Agent': `OurTube/${VERSION}` }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  } catch (e) {
    throw new HttpError(502, `Could not download the image: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw new HttpError(502, `Could not download the image (${res.status})`);
  if (Number(res.headers.get('content-length')) > MAX_IMAGE) throw new HttpError(400, 'That image is too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new HttpError(400, 'That image is too large');
  const tmp = path.join(DIRS.tmp, `sgdb-${newId()}`);
  const name = `game-${game.id}-${kind}-${Date.now()}.${k.ext}`;
  fs.writeFileSync(tmp, buf);
  try {
    await convertImage(tmp, path.join(DIRS.thumbs, name), k.convert); // re-encoded, never served as downloaded
  } catch (e) {
    throw new HttpError(400, `Could not read that image: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const fresh = db.prepare('SELECT * FROM games WHERE id = ?').get(game.id) || game;
  const old = fresh[k.column];
  db.prepare(`UPDATE games SET ${k.column} = ?, sgdb_id = COALESCE(?, sgdb_id), art_credits = ? WHERE id = ?`).run(
    name, sgdbId ? Number(sgdbId) : null, JSON.stringify({ ...credits(fresh), [kind]: { source: 'SteamGridDB', author: image.author || null } }), game.id,
  );
  if (old && old !== name) fs.rmSync(path.join(DIRS.thumbs, old), { force: true });
  return db.prepare('SELECT * FROM games WHERE id = ?').get(game.id);
}

/** Forgets a game's cover, logo or banner. */
export function clearImage(game, kind) {
  const k = ART[kind];
  if (!k) throw new HttpError(400, 'Artwork is cover, logo or hero');
  if (game[k.column]) fs.rmSync(path.join(DIRS.thumbs, game[k.column]), { force: true });
  const c = credits(game);
  delete c[kind];
  db.prepare(`UPDATE games SET ${k.column} = NULL, art_credits = ? WHERE id = ?`).run(JSON.stringify(c), game.id);
}

/**
 * Fills in what a game is missing (or everything, with `force`): finds it on SteamGridDB by name unless it
 * is linked already, then takes the best-ranked cover, logo and banner.
 */
export async function autoArtwork(gameId, { force = false, kinds = Object.keys(ART) } = {}) {
  let g = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!g || g.source === 'hub' || !sgdbConfigured()) return { applied: [] };
  let sgdbId = g.sgdb_id;
  if (!sgdbId) {
    const pick = bestMatch(await searchGames(g.name), g.name);
    if (!pick) return { applied: [], sgdb_id: null };
    sgdbId = pick.id;
    db.prepare('UPDATE games SET sgdb_id = ? WHERE id = ?').run(sgdbId, g.id);
  }
  const applied = [];
  for (const kind of kinds) {
    g = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!g || (g[ART[kind].column] && !force)) continue;
    const best = (await listImages(kind, sgdbId))[0];
    if (best) {
      await applyImage(g, kind, best, sgdbId);
      applied.push(kind);
    }
  }
  return { applied, sgdb_id: sgdbId };
}

defineJob('games.artwork', {
  maxAttempts: 3,
  handler: async ({ id, force = false }) => {
    const r = await autoArtwork(id, { force });
    if (r.applied.length) console.log(`[games] SteamGridDB artwork for ${id}: ${r.applied.join(', ')}`);
  },
});

/** Queues artwork for a new game, when an API key is set and filling in is on. */
export function queueArtwork(gameId) {
  if (sgdbAuto()) enqueueJob('games.artwork', { id: gameId }, { dedupe: `games-artwork:${gameId}` });
}
