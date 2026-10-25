/**
 * Creator analytics, kept as aggregates only: views per day, watch time per day, where views came from
 * (a site name or a page of this site, never a full address or a person), and a retention curve built
 * from which parts of a video were played. Anonymous viewers count too.
 */
import { Router } from 'express';
import { db } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, clampInt } from './util.js';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const INTERNAL = new Set(['home', 'trending', 'search', 'channel', 'watch', 'subscriptions', 'network', 'game', 'history', 'liked', 'notifications', 'studio', 'compare']);

/** Where a view came from: a page of this site, another site's host name, or "direct". */
export function viewSource({ from, ref }, selfHost) {
  if (from && INTERNAL.has(String(from))) return `site:${from}`;
  try {
    const u = new URL(String(ref || ''));
    if (!/^https?:$/.test(u.protocol)) return 'direct';
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (selfHost && host === selfHost.replace(/^www\./, '')) return 'site:other';
    return host.slice(0, 100) || 'direct';
  } catch {
    return 'direct';
  }
}

export function recordView(videoId, source) {
  const d = day();
  db.prepare('INSERT INTO video_stats_daily (video_id, day, views) VALUES (?, ?, 1) ON CONFLICT(video_id, day) DO UPDATE SET views = views + 1').run(videoId, d);
  db.prepare('INSERT INTO video_referrers (video_id, day, source, views) VALUES (?, ?, ?, 1) ON CONFLICT(video_id, day, source) DO UPDATE SET views = views + 1').run(videoId, d, source);
}

const lastWatch = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, t] of lastWatch) if (t < cutoff) lastWatch.delete(k);
}, 60_000).unref();

/** Playback report from the player: seconds watched and which 2% parts of the video were reached. */
export function recordWatch(v, body, ip) {
  const key = `${ip}|${v.id}`;
  if (Date.now() - (lastWatch.get(key) || 0) < 5000) return false;
  lastWatch.set(key, Date.now());
  const seconds = Math.max(0, Math.min(Number(body?.seconds) || 0, Math.max(30, (v.duration || 0) * 3)));
  const buckets = [...new Set((Array.isArray(body?.buckets) ? body.buckets : []).map(Number).filter((b) => Number.isInteger(b) && b >= 0 && b < 50))];
  if (seconds >= 1) {
    db.prepare('INSERT INTO video_stats_daily (video_id, day, watch_seconds) VALUES (?, ?, ?) ON CONFLICT(video_id, day) DO UPDATE SET watch_seconds = watch_seconds + excluded.watch_seconds').run(
      v.id, day(), Math.round(seconds),
    );
  }
  const ins = db.prepare('INSERT INTO video_retention (video_id, bucket, samples) VALUES (?, ?, 1) ON CONFLICT(video_id, bucket) DO UPDATE SET samples = samples + 1');
  for (const b of buckets) ins.run(v.id, b);
  return true;
}

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

/** Analytics for one video (?video=) or the whole channel. Owners and admins only. */
analyticsRouter.get('/', (req, res) => {
  const days = clampInt(req.query.days, 7, 365, 28);
  const from = day(Date.now() - (days - 1) * 86400_000);
  let ids;
  let video = null;
  if (req.query.video) {
    video = db.prepare('SELECT id, user_id, title, duration, views FROM videos WHERE id = ?').get(String(req.query.video));
    if (!video || !(video.user_id === req.user.id || req.user.is_admin)) throw new HttpError(404, 'Video not found');
    ids = [video.id];
  } else {
    ids = db.prepare('SELECT id FROM videos WHERE user_id = ?').all(req.user.id).map((r) => r.id);
  }
  if (!ids.length) return res.json({ days, daily: [], referrers: [], retention: [], totals: { views: 0, watch_seconds: 0 }, top: [] });
  const marks = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT day, SUM(views) AS views, SUM(watch_seconds) AS watch_seconds FROM video_stats_daily WHERE video_id IN (${marks}) AND day >= ? GROUP BY day`)
    .all(...ids, from);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = day(Date.now() - i * 86400_000);
    const r = byDay.get(d);
    daily.push({ day: d, views: r?.views || 0, watch_seconds: r?.watch_seconds || 0 });
  }
  const referrers = db
    .prepare(`SELECT source, SUM(views) AS views FROM video_referrers WHERE video_id IN (${marks}) AND day >= ? GROUP BY source ORDER BY views DESC LIMIT 12`)
    .all(...ids, from);
  let retention = [];
  if (video) {
    const r = db.prepare('SELECT bucket, samples FROM video_retention WHERE video_id = ? ORDER BY bucket').all(video.id);
    const start = Math.max(1, r.find((x) => x.bucket === 0)?.samples || Math.max(0, ...r.map((x) => x.samples)));
    const map = new Map(r.map((x) => [x.bucket, x.samples]));
    retention = r.length ? Array.from({ length: 50 }, (_, b) => ({ at: b * 2, share: Math.min(1, (map.get(b) || 0) / start) })) : [];
  }
  const top = video
    ? []
    : db
        .prepare(
          `SELECT v.id, v.title, COALESCE(SUM(s.views), 0) AS views, COALESCE(SUM(s.watch_seconds), 0) AS watch_seconds FROM videos v
           LEFT JOIN video_stats_daily s ON s.video_id = v.id AND s.day >= ? WHERE v.user_id = ? GROUP BY v.id ORDER BY views DESC LIMIT 10`,
        )
        .all(from, req.user.id);
  res.json({
    days,
    video: video ? { id: video.id, title: video.title, duration: video.duration, views: video.views } : null,
    daily,
    referrers,
    retention,
    totals: { views: daily.reduce((s, d) => s + d.views, 0), watch_seconds: daily.reduce((s, d) => s + d.watch_seconds, 0) },
    top,
  });
});
