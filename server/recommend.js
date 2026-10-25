/**
 * The optional "For you" feed. Every video carries the reason it is there, and viewers steer it:
 * more or less of a game or channel, not interested in a video, hide what they've watched.
 * The default home feed stays chronological; this is only used when someone picks it.
 */
import { Router } from 'express';
import { db, getSettings } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, clampInt, now, str } from './util.js';

const WINDOW_MS = 90 * 86400_000;

export function recommendRouter({ LOCAL_LIST_COLS, REMOTE_LIST_COLS, NETWORK_VISIBLE, mapListRow, networkActive }) {
  const router = Router();
  router.use(requireAuth);

  router.get('/preferences', (req, res) => {
    res.json({ preferences: db.prepare('SELECT kind, target, weight, created_at FROM feed_preferences WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id) });
  });

  router.put('/preferences', (req, res) => {
    const b = req.body || {};
    if (!['game', 'channel', 'tag', 'video'].includes(b.kind)) throw new HttpError(400, 'Kind must be game, channel, tag or video');
    const target = str(b.target, 200).trim();
    if (!target) throw new HttpError(400, 'Missing target');
    const weight = Number(b.weight);
    if (weight === 0) db.prepare('DELETE FROM feed_preferences WHERE user_id = ? AND kind = ? AND target = ?').run(req.user.id, b.kind, target);
    else {
      if (![1, -1, -9].includes(weight)) throw new HttpError(400, 'Weight must be 1 (more), -1 (less), -9 (not interested) or 0 (reset)');
      db.prepare(
        'INSERT INTO feed_preferences (user_id, kind, target, weight, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, kind, target) DO UPDATE SET weight = excluded.weight',
      ).run(req.user.id, b.kind, target, weight, now());
    }
    res.json({ ok: true });
  });

  router.get('/for-you', (req, res) => {
    const limit = clampInt(req.query.limit, 1, 60, 24);
    const offset = clampInt(req.query.offset, 0, 600, 0);
    const hideWatched = req.query.hide_watched === '1';
    const uid = req.user.id;
    const since = now() - WINDOW_MS;
    const site = getSettings().site_name;

    // What this person follows and likes.
    const subs = new Set(db.prepare('SELECT channel_id FROM subscriptions WHERE subscriber_id = ?').all(uid).map((r) => r.channel_id));
    const remoteSubs = new Set(db.prepare('SELECT instance_id, username FROM network_subscriptions WHERE user_id = ?').all(uid).map((r) => `${r.instance_id}|${r.username}`));
    const gameCount = new Map();
    const tagCount = new Map();
    const bump = (m, k, n = 1) => k && m.set(k, (m.get(k) || 0) + n);
    for (const r of db.prepare('SELECT v.game_id FROM likes l JOIN videos v ON v.id = l.video_id WHERE l.user_id = ? AND l.value = 1 ORDER BY l.created_at DESC LIMIT 200').all(uid)) bump(gameCount, r.game_id, 2);
    for (const r of db.prepare('SELECT v.game_id FROM history h JOIN videos v ON v.id = h.video_id WHERE h.user_id = ? ORDER BY h.watched_at DESC LIMIT 200').all(uid)) bump(gameCount, r.game_id, 1);
    for (const r of db.prepare('SELECT t.tag FROM likes l JOIN tags t ON t.video_id = l.video_id WHERE l.user_id = ? AND l.value = 1 ORDER BY l.created_at DESC LIMIT 400').all(uid)) bump(tagCount, r.tag);
    const games = new Map(db.prepare('SELECT id, name FROM games').all().map((g) => [g.id, g.name]));
    const prefs = new Map(db.prepare('SELECT kind, target, weight FROM feed_preferences WHERE user_id = ?').all(uid).map((p) => [`${p.kind}|${p.target}`, p.weight]));
    const watched = new Set(db.prepare('SELECT video_id FROM history WHERE user_id = ?').all(uid).map((r) => r.video_id));
    const likedVideos = db.prepare('SELECT v.title, v.game_id FROM likes l JOIN videos v ON v.id = l.video_id WHERE l.user_id = ? AND l.value = 1 ORDER BY l.created_at DESC LIMIT 20').all(uid);

    const parts = [`SELECT ${LOCAL_LIST_COLS}, (SELECT group_concat(tag, ',') FROM tags t WHERE t.video_id = v.id) AS tag_list FROM videos v JOIN users u ON u.id = v.user_id
      WHERE v.status = 'ready' AND v.visibility = 'public' AND v.moderation_status IS NULL AND v.created_at > ? AND v.user_id != ?`];
    const params = [since, uid];
    if (networkActive()) {
      parts.push(`SELECT ${REMOTE_LIST_COLS}, r.tags AS tag_list FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE ${NETWORK_VISIBLE} AND r.created_at > ?`);
      params.push(since);
    }
    const rows = db.prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY created_at DESC LIMIT 800`).all(...params);

    const t = now();
    const scored = [];
    for (const r of rows) {
      const isLocal = r.src === 'local';
      const channelKey = isLocal ? `channel|${r.user_id}` : `channel|${r.peer_id}:${r.u_username}`;
      const videoKey = isLocal ? `video|${r.vid}` : `video|${r.peer_id}:${r.vid}`;
      if (prefs.get(videoKey) === -9) continue;
      if (hideWatched && isLocal && watched.has(r.vid)) continue;
      const ageDays = (t - r.created_at) / 86400_000;
      let score = 2 * Math.exp(-ageDays / 14) + 0.3 * Math.log10(1 + (r.views || 0)) + 0.1 * Math.min(20, Math.max(0, r.score || 0));
      const reasons = [];
      const subscribed = isLocal ? subs.has(r.user_id) : remoteSubs.has(`${r.peer_id}|${r.u_username}`);
      if (subscribed) reasons.push([4, `New from ${r.u_display}, a channel you subscribe to`]);
      const cw = prefs.get(channelKey);
      if (cw === 1) reasons.push([2, `More from ${r.u_display}, as you asked`]);
      if (cw === -1) score -= 3;
      if (r.game_id) {
        const gw = prefs.get(`game|${r.game_id}`);
        const gname = r.game_name || games.get(r.game_id) || r.game_id;
        if (gw === -1) score -= 3;
        else if (gw === 1) reasons.push([2.5, `More ${gname}, as you asked`]);
        else if (gameCount.get(r.game_id)) {
          const liked = likedVideos.find((l) => l.game_id === r.game_id);
          reasons.push([Math.min(3, 1 + gameCount.get(r.game_id) / 4), liked ? `Because you liked "${liked.title}"` : `Because you watch ${gname}`]);
        }
      }
      const tags = String(r.tag_list || '').split(',').filter(Boolean);
      let tagBest = null;
      for (const tag of tags) {
        if (prefs.get(`tag|${tag}`) === -1) score -= 2;
        const n = tagCount.get(tag) || 0;
        if (n && (!tagBest || n > tagBest[1])) tagBest = [tag, n];
      }
      if (tagBest) reasons.push([Math.min(2, 0.5 + tagBest[1] / 5), `Popular in #${tagBest[0]}`]);
      for (const [w] of reasons) score += w;
      reasons.sort((a, b) => b[0] - a[0]);
      const why = reasons[0]?.[1] || ((r.views || 0) >= 10 ? `Popular on ${isLocal ? site : r.peer_name || 'the network'}` : `New on ${isLocal ? site : r.peer_name || 'the network'}`);
      scored.push({ score, row: r, why, watched: isLocal && watched.has(r.vid), channel: channelKey.slice(8), video: videoKey.slice(6) });
    }
    scored.sort((a, b) => b.score - a.score);
    const page = scored.slice(offset, offset + limit);
    res.json({
      videos: page.map((s) => ({ ...mapListRow(s.row), reason: s.why, watched: s.watched, feed_keys: { channel: s.channel, video: s.video, game: s.row.game_id || null } })),
      has_more: scored.length > offset + limit,
    });
  });

  return router;
}
