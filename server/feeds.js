/**
 * RSS 2.0 and Atom feeds of public videos: the whole instance, one channel, or one game.
 *   /feeds/videos.atom      /feeds/channel/<username>.atom      /feeds/game/<id>.atom   (or .rss)
 * Entries carry the thumbnail and the MP4 as an enclosure, so podcast-style and video feed readers work.
 */
import { Router } from 'express';
import { db, getSettings } from './db.js';
import { HttpError, escapeHtml } from './util.js';

const esc = (s) => escapeHtml(String(s ?? ''));
const LIMIT = 50;

function baseUrl(req) {
  const s = getSettings();
  return (s.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

const SELECT = `SELECT v.*, u.username, u.display_name, (SELECT group_concat(tag, ',') FROM tags t WHERE t.video_id = v.id) AS tag_list,
  (SELECT name FROM games g WHERE g.id = v.game_id) AS game_name
  FROM videos v JOIN users u ON u.id = v.user_id
  WHERE v.status = 'ready' AND v.visibility = 'public' AND v.moderation_status IS NULL`;

function videoUrl(v) {
  return `/media/videos/${v.id}.mp4${v.edit_version ? `?v=${v.edit_version}` : ''}`;
}

function atom({ base, self, title, subtitle, link, videos }) {
  const updated = new Date(videos[0]?.updated_at || videos[0]?.created_at || Date.now()).toISOString();
  const entries = videos.map((v) => {
    const watch = `${base}/watch/${v.id}`;
    const thumb = v.thumb_path ? `${base}/media/thumbs/${v.thumb_path}` : null;
    const tags = String(v.tag_list || '').split(',').filter(Boolean);
    return `  <entry>
    <id>${esc(watch)}</id>
    <title>${esc(v.title)}</title>
    <link rel="alternate" type="text/html" href="${esc(watch)}"/>
    <link rel="enclosure" type="video/mp4" length="${v.size_bytes || 0}" href="${esc(base + videoUrl(v))}"/>
    <published>${new Date(v.published_at || v.created_at).toISOString()}</published>
    <updated>${new Date(v.updated_at || v.created_at).toISOString()}</updated>
    <author><name>${esc(v.display_name)}</name><uri>${esc(`${base}/c/${v.username}`)}</uri></author>
    <summary type="text">${esc(v.description || '')}</summary>
${v.game_name ? `    <category term="${esc(v.game_name)}" label="Game"/>\n` : ''}${tags.map((t) => `    <category term="${esc(t)}"/>`).join('\n')}${tags.length ? '\n' : ''}    <media:group>
      <media:title>${esc(v.title)}</media:title>
      <media:content url="${esc(base + videoUrl(v))}" type="video/mp4" medium="video" duration="${Math.round(v.duration || 0)}" width="${v.width || 0}" height="${v.height || 0}"/>
${thumb ? `      <media:thumbnail url="${esc(thumb)}"/>\n` : ''}      <media:description>${esc(v.description || '')}</media:description>
    </media:group>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>${esc(self)}</id>
  <title>${esc(title)}</title>
${subtitle ? `  <subtitle>${esc(subtitle)}</subtitle>\n` : ''}  <link rel="self" type="application/atom+xml" href="${esc(self)}"/>
  <link rel="alternate" type="text/html" href="${esc(link)}"/>
  <updated>${updated}</updated>
  <generator>ClipTube</generator>
${entries.join('\n')}
</feed>
`;
}

function rss({ base, self, title, subtitle, link, videos }) {
  const items = videos.map((v) => {
    const watch = `${base}/watch/${v.id}`;
    const thumb = v.thumb_path ? `${base}/media/thumbs/${v.thumb_path}` : null;
    return `    <item>
      <title>${esc(v.title)}</title>
      <link>${esc(watch)}</link>
      <guid isPermaLink="true">${esc(watch)}</guid>
      <pubDate>${new Date(v.published_at || v.created_at).toUTCString()}</pubDate>
      <dc:creator>${esc(v.display_name)}</dc:creator>
      <description>${esc(v.description || '')}</description>
      <enclosure url="${esc(base + videoUrl(v))}" length="${v.size_bytes || 0}" type="video/mp4"/>
      <media:content url="${esc(base + videoUrl(v))}" type="video/mp4" medium="video" duration="${Math.round(v.duration || 0)}"/>
${thumb ? `      <media:thumbnail url="${esc(thumb)}"/>\n` : ''}    </item>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(link)}</link>
    <description>${esc(subtitle || title)}</description>
    <atom:link href="${esc(self)}" rel="self" type="application/rss+xml"/>
    <generator>ClipTube</generator>
${items.join('\n')}
  </channel>
</rss>
`;
}

function send(req, res, format, data) {
  const body = format === 'rss' ? rss(data) : atom(data);
  res.set('Content-Type', format === 'rss' ? 'application/rss+xml; charset=utf-8' : 'application/atom+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(body);
}

export const feedsRouter = Router();

feedsRouter.get(['/videos.atom', '/videos.rss'], (req, res) => {
  const base = baseUrl(req);
  const s = getSettings();
  const format = req.path.endsWith('.rss') ? 'rss' : 'atom';
  const videos = db.prepare(`${SELECT} ORDER BY v.created_at DESC LIMIT ${LIMIT}`).all();
  send(req, res, format, { base, self: `${base}/feeds/videos.${format}`, title: s.site_name, subtitle: s.instance_description, link: base, videos });
});

feedsRouter.get('/channel/:file', (req, res) => {
  const m = /^([A-Za-z0-9_]{3,20})\.(atom|rss)$/.exec(String(req.params.file));
  if (!m) throw new HttpError(404, 'Not found');
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(m[1]);
  if (!u) throw new HttpError(404, 'Channel not found');
  const base = baseUrl(req);
  const videos = db.prepare(`${SELECT} AND v.user_id = ? ORDER BY v.created_at DESC LIMIT ${LIMIT}`).all(u.id);
  send(req, res, m[2], { base, self: `${base}/feeds/channel/${u.username}.${m[2]}`, title: `${u.display_name} on ${getSettings().site_name}`, subtitle: u.bio, link: `${base}/c/${u.username}`, videos });
});

// A public or unlisted playlist: its videos from this site, newest additions first.
feedsRouter.get('/playlist/:file', (req, res) => {
  const m = /^([A-Za-z0-9_-]{1,40})\.(atom|rss)$/.exec(String(req.params.file));
  if (!m) throw new HttpError(404, 'Not found');
  const p = db.prepare("SELECT p.*, u.display_name FROM playlists p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.kind = 'user' AND p.visibility != 'private'").get(m[1]);
  if (!p) throw new HttpError(404, 'Playlist not found');
  const base = baseUrl(req);
  const videos = db
    .prepare(`${SELECT.replace("v.visibility = 'public'", "v.visibility != 'private'")} AND v.id IN (SELECT video_id FROM playlist_items WHERE playlist_id = ?)
      ORDER BY (SELECT added_at FROM playlist_items i WHERE i.playlist_id = ? AND i.video_id = v.id) DESC LIMIT ${LIMIT}`)
    .all(p.id, p.id);
  send(req, res, m[2], { base, self: `${base}/feeds/playlist/${p.id}.${m[2]}`, title: `${p.title} by ${p.display_name}`, subtitle: p.description, link: `${base}/playlist/${p.id}`, videos });
});

feedsRouter.get('/game/:file', (req, res) => {
  const m = /^([a-z0-9-]{1,30})\.(atom|rss)$/.exec(String(req.params.file));
  if (!m) throw new HttpError(404, 'Not found');
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(m[1]);
  if (!g) throw new HttpError(404, 'Game not found');
  const base = baseUrl(req);
  const videos = db.prepare(`${SELECT} AND v.game_id = ? ORDER BY v.created_at DESC LIMIT ${LIMIT}`).all(g.id);
  send(req, res, m[2], { base, self: `${base}/feeds/game/${g.id}.${m[2]}`, title: `${g.name} clips on ${getSettings().site_name}`, link: `${base}/g/${g.id}`, videos });
});
