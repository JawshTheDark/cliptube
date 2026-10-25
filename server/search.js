/**
 * Full-text search with SQLite FTS5 over local and network videos (title, description, tags, game,
 * channel), ranked by relevance, with filters for game, length, upload date, where it's hosted and shape.
 * Quoted text is matched as an exact phrase; other words match as prefixes.
 */
import { Router } from 'express';
import { db } from './db.js';
import { clampInt, HttpError } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';

const gameText = (g) => (g ? [g.name, g.id, g.short_name, String(g.aliases || '').replace(/,/g, ' ')].filter(Boolean).join(' ') : '');

/** (Re)indexes one local video; removes it from the index when it no longer exists. */
export function indexVideo(id) {
  db.prepare('DELETE FROM video_search WHERE video_id = ?').run(id);
  const v = db
    .prepare('SELECT v.id, v.title, v.description, v.game_id, u.display_name, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?')
    .get(id);
  if (!v) return;
  const tags = db.prepare("SELECT group_concat(tag, ' ') AS t FROM tags WHERE video_id = ?").get(id).t || '';
  const g = v.game_id ? db.prepare('SELECT * FROM games WHERE id = ?').get(v.game_id) : null;
  db.prepare('INSERT INTO video_search (video_id, title, description, tags, game, channel) VALUES (?, ?, ?, ?, ?, ?)').run(
    v.id, v.title, v.description || '', tags, gameText(g), `${v.display_name} ${v.username}`,
  );
}

export function indexVideosOf(userId) {
  for (const r of db.prepare('SELECT id FROM videos WHERE user_id = ?').all(userId)) indexVideo(r.id);
}

export function indexNetworkVideo(instanceId, remoteId) {
  db.prepare('DELETE FROM network_search WHERE instance_id = ? AND remote_id = ?').run(instanceId, remoteId);
  const r = db.prepare('SELECT * FROM network_videos WHERE instance_id = ? AND remote_id = ?').get(instanceId, remoteId);
  if (!r) return;
  db.prepare('INSERT INTO network_search (instance_id, remote_id, title, description, tags, game, channel) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    instanceId, remoteId, r.title, r.description || '', String(r.tags || '').replace(/,/g, ' '), [r.game_name, r.game_slug].filter(Boolean).join(' '),
    `${r.uploader_display_name} ${r.uploader_username}`,
  );
}

/** Drops index rows of videos that are gone, and indexes anything missing. Cheap; runs at start and hourly. */
export function syncSearchIndex() {
  db.exec('DELETE FROM video_search WHERE video_id NOT IN (SELECT id FROM videos)');
  for (const r of db.prepare('SELECT id FROM videos WHERE id NOT IN (SELECT video_id FROM video_search)').all()) indexVideo(r.id);
  db.exec("DELETE FROM network_search WHERE (instance_id || '|' || remote_id) NOT IN (SELECT instance_id || '|' || remote_id FROM network_videos)");
  for (const r of db.prepare("SELECT instance_id, remote_id FROM network_videos WHERE (instance_id || '|' || remote_id) NOT IN (SELECT instance_id || '|' || remote_id FROM network_search)").all()) {
    indexNetworkVideo(r.instance_id, r.remote_id);
  }
}

defineJob('search.sync', {
  handler: () => {
    syncSearchIndex();
    enqueueJob('search.sync', {}, { delay: 3600_000, dedupe: 'search-sync' });
  },
});
export const startSearchSync = () => enqueueJob('search.sync', {}, { delay: 5000, dedupe: 'search-sync' });

/** Turns what someone typed into an FTS5 query. Returns '' when there is nothing to search for. */
export function ftsQuery(input) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || ''))) && out.length < 16) {
    const words = (m[1] ?? m[2]).match(/[\p{L}\p{N}]+/gu);
    if (!words) continue;
    if (m[1] !== undefined) out.push(`"${words.join(' ')}"`);
    else for (const w of words) out.push(`"${w}"*`);
  }
  return out.join(' ');
}

const DURATIONS = { short: [0, 60], medium: [60, 1200], long: [1200, 1e9] };
const DATES = { day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000, year: 365 * 86400_000 };

/**
 * Builds the search. Needs the list columns and visibility rule from the video routes, passed in to
 * keep this module free of route imports.
 */
export function searchRouter({ LOCAL_LIST_COLS, REMOTE_LIST_COLS, NETWORK_VISIBLE, mapListRow, networkActive, findGame, gameSlugs, networkGameWhere }) {
  const router = Router();
  router.get('/', (req, res) => {
    const q = ftsQuery(req.query.q);
    const limit = clampInt(req.query.limit, 1, 100, 24);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    const sort = ['relevance', 'new', 'views', 'old'].includes(req.query.sort) ? req.query.sort : q ? 'relevance' : 'new';
    const where = String(req.query.where || 'all');
    const network = networkActive();
    const wantLocal = where === 'all' || where === 'local';
    const peer = /^peer:(\d+)$/.exec(where);
    const wantNetwork = network && (where === 'all' || where === 'network' || !!peer);
    if (!wantLocal && !wantNetwork) return res.json({ videos: [], has_more: false });

    const dur = DURATIONS[req.query.duration];
    const since = DATES[req.query.date] ? Date.now() - DATES[req.query.date] : null;
    const shape = req.query.shape === 'vertical' ? '>' : req.query.shape === 'landscape' ? '<=' : null;
    const game = req.query.game ? findGame(req.query.game) || { id: String(req.query.game), aliases: '' } : null;

    const parts = [];
    const params = [];
    if (wantLocal) {
      const w = ["v.status = 'ready'", "v.visibility = 'public'", 'v.moderation_status IS NULL'];
      const p = [];
      if (q) {
        w.push('video_search MATCH ?');
        p.push(q);
      }
      if (dur) w.push(`v.duration >= ${dur[0]} AND v.duration < ${dur[1]}`);
      if (since) {
        w.push('v.created_at >= ?');
        p.push(since);
      }
      if (shape) w.push(`v.height ${shape} v.width`);
      if (game) {
        w.push('v.game_id = ?');
        p.push(game.id);
      }
      const from = q ? 'video_search JOIN videos v ON v.id = video_search.video_id' : 'videos v';
      const rank = q ? 'bm25(video_search, 0, 10, 1, 4, 6, 3)' : '0';
      parts.push(`SELECT ${LOCAL_LIST_COLS}, ${rank} AS rank FROM ${from} JOIN users u ON u.id = v.user_id WHERE ${w.join(' AND ')}`);
      params.push(...p);
    }
    if (wantNetwork) {
      const w = [NETWORK_VISIBLE];
      const p = [];
      if (q) {
        w.push('network_search MATCH ?');
        p.push(q);
      }
      if (peer) {
        w.push('r.instance_id = ?');
        p.push(Number(peer[1]));
      }
      if (dur) w.push(`r.duration >= ${dur[0]} AND r.duration < ${dur[1]}`);
      if (since) {
        w.push('r.created_at >= ?');
        p.push(since);
      }
      if (shape) w.push(`r.height ${shape} r.width`);
      if (game) {
        const g = networkGameWhere(gameSlugs(game));
        w.push(g.sql);
        p.push(...g.params);
      }
      const from = q
        ? 'network_search JOIN network_videos r ON r.instance_id = network_search.instance_id AND r.remote_id = network_search.remote_id'
        : 'network_videos r';
      const rank = q ? 'bm25(network_search, 0, 0, 10, 1, 4, 6, 3)' : '0';
      parts.push(`SELECT ${REMOTE_LIST_COLS}, ${rank} AS rank FROM ${from} JOIN instances p ON p.id = r.instance_id WHERE ${w.join(' AND ')}`);
      params.push(...p);
    }
    const order = { relevance: 'rank ASC, created_at DESC', new: 'created_at DESC', old: 'created_at ASC', views: 'views DESC, created_at DESC' }[sort];
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    } catch (e) {
      if (/fts5|MATCH/i.test(e.message)) throw new HttpError(400, 'Could not understand that search');
      throw e;
    }
    res.json({ videos: rows.map(mapListRow), has_more: rows.length === limit, network });
  });
  return router;
}
