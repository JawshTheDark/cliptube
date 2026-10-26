import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT_DIR, DIRS, PORT, HOST, LOG_REQUESTS } from './config.js';
import { db, getSettings, userCount } from './db.js';
import { attachUser, authRouter, ensureSetupCode } from './auth.js';
import { videosRouter } from './routes/videos.js';
import { usersRouter, meRouter } from './routes/users.js';
import { adminRouter } from './routes/admin.js';
import { mediaRouter } from './routes/media.js';
import { checkFfmpeg, resumePending } from './media.js';
import { startUploadSweep, uploadsRouter } from './uploads.js';
import { webhooksRouter } from './webhooks.js';
import { apiKeysRouter } from './apikeys.js';
import { startJobs } from './jobs.js';
import { networkProtocolRouter, networkAdminRouter, networkRouter, networkActive, networkPeers, networkInfo, startNetwork } from './network.js';
import { modRouter, reportsRouter, legalAdminRouter, legalPublicRouter } from './moderation.js';
import { privacyRouter } from './privacy.js';
import { registrationMode } from './auth.js';
import './spam.js'; // registers the comment spam checks with the intake pipeline
import { HttpError, escapeHtml } from './util.js';
import { gamesRouter } from './games.js';
import { clipsRouter } from './clips.js';
import { watchingRouter, watchingMediaRouter } from './watching.js';
import { emailPublicRouter, mailAdminRouter, notificationsRouter, startNotifyCleanup } from './notify.js';
import { mailConfigured } from './mail.js';
import { feedsRouter } from './feeds.js';
import { searchRouter, startSearchSync } from './search.js';
import { recommendRouter } from './recommend.js';
import { analyticsRouter } from './stats.js';
import { LOCAL_LIST_COLS, REMOTE_LIST_COLS, mapListRow } from './routes/videos.js';
import { NETWORK_VISIBLE } from './network.js';
import { findGame, gameSlugs, networkGameWhere } from './games.js';
import { apNegotiation, apRouter, apWellKnownRouter } from './ap/routes.js';
import { apNetworkRouter, fediverseAdminRouter, fediverseRouter } from './ap/api.js';
import { startApCleanup } from './ap/inbox.js';
import { apEnabled, apBase } from './ap/common.js';
import { moveRouter } from './ap/move.js';
import { channelExportPublicRouter, transferRouter } from './transfer.js';
import { linksRouter, relMeLinks, startLinkChecks } from './links.js';
import { channelPlaylistsRouter, playlistsRouter } from './playlists.js';
import { partiesRouter, startPartyCleanup } from './parties.js';
import { liveHookRouter, liveMediaRouter, liveRouter, startLiveWatch } from './live.js';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', true);

// Keep the raw bytes: network inbox requests are verified against a signature over the exact body.
// ActivityPub posts JSON as application/activity+json or application/ld+json.
app.use(express.json({ limit: '1mb', type: ['application/json', 'application/activity+json', 'application/ld+json'], verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(attachUser);
if (LOG_REQUESTS) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms ${req.user ? '@' + req.user.username : 'anon'}`));
    next();
  });
}

// ---- API --------------------------------------------------------------------

app.get('/api/site', (req, res) => {
  const s = getSettings();
  const mode = registrationMode();
  res.json({
    site_name: s.site_name,
    registration_mode: mode,
    allow_registration: mode !== 'closed',
    show_dislikes: s.show_dislikes === 'true',
    email: mailConfigured(s),
    activitypub: apEnabled(),
    ap_host: apEnabled() ? new URL(apBase(req) || `http://${req.get('host')}`).host : null,
    has_terms: !!s.legal_terms.trim(),
    has_legal: !!(s.legal_contact_email || s.legal_dmca_agent || s.legal_rules || s.legal_terms),
    transparency: s.legal_transparency_public === 'true',
    max_upload_mb: Number(s.max_upload_mb),
    needs_setup: userCount() === 0,
    federation: networkActive(),
    network_peers: networkPeers(),
    network: networkInfo(),
  });
});
app.use(networkProtocolRouter); // /.well-known/cliptube, /api/hub/*, /api/network/{verify,feed,inbox}
app.use(apWellKnownRouter); // WebFinger, NodeInfo, host-meta
app.use('/ap', apRouter); // ActivityPub actors, objects, collections, inboxes
app.use(channelExportPublicRouter); // /api/channel-exports/<id>?token=... (import from a link)
// Remote follow from another fediverse server ("Follow" on Mastodon pointing here): pick it up on Subscriptions.
app.get('/authorize_interaction', (req, res) => res.redirect(`/subscriptions?follow=${encodeURIComponent(String(req.query.uri || '').slice(0, 500))}`));
app.use('/api', legalPublicRouter); // /api/legal, /api/transparency
app.use('/api/auth', authRouter);
app.use('/api/auth', emailPublicRouter); // verify-email, forgot-password, reset-password
app.use('/api/notifications', notificationsRouter);
app.use('/api/search', searchRouter({ LOCAL_LIST_COLS, REMOTE_LIST_COLS, NETWORK_VISIBLE, mapListRow, networkActive, findGame, gameSlugs, networkGameWhere }));
app.use('/api/feed', recommendRouter({ LOCAL_LIST_COLS, REMOTE_LIST_COLS, NETWORK_VISIBLE, mapListRow, networkActive }));
app.use('/api/studio/analytics', analyticsRouter);
app.use('/api/videos', videosRouter);
app.use('/api/games', gamesRouter);
app.use('/api', clipsRouter); // /api/videos/:id/clip, /api/videos/:id/exports, /api/exports/:id
app.use('/api', watchingRouter); // captions, segments, community suggestions
app.use('/api/users', usersRouter);
app.use('/api/users', channelPlaylistsRouter); // /api/users/:username/playlists
app.use('/api/playlists', playlistsRouter);
app.use('/api/parties', partiesRouter);
app.use('/api/live', liveHookRouter); // MediaMTX asks here who may publish and read
app.use('/api/live', liveRouter);
app.use('/live/hls', liveMediaRouter);
app.use('/api/uploads', uploadsRouter); // big files in pieces, for proxies that cap request size
app.use('/api/me/webhooks', webhooksRouter); // each person's webhooks
app.use('/api/me/api-keys', apiKeysRouter); // each person's upload keys (ShareX and the like)
app.use('/api/me', privacyRouter); // exports, account deletion
app.use('/api/me', meRouter);
app.use('/api/me', moveRouter); // aliases and moves
app.use('/api/me', linksRouter); // linked accounts
app.use('/api/me', transferRouter); // channel export and import
app.use('/api/reports', reportsRouter);
app.use('/api/mod', modRouter);
app.use('/api/fediverse', fediverseRouter);
app.use('/api/network', apNetworkRouter); // videos that came from the fediverse
app.use('/api/network', networkRouter);
app.use('/api/admin/network', networkAdminRouter);
app.use('/api/admin/legal', legalAdminRouter);
app.use('/api/admin/mail', mailAdminRouter);
app.use('/api/admin/fediverse', fediverseAdminRouter);
app.use('/api/admin', adminRouter);
app.use('/media', watchingMediaRouter); // HLS, federation MP4, captions, originals
app.use('/media', mediaRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/feeds', feedsRouter); // RSS and Atom
app.use(apNegotiation); // /watch/<id> and /c/<name> as ActivityPub JSON for fediverse servers

// ---- frontend ---------------------------------------------------------------

const dist = path.join(ROOT_DIR, 'web', 'dist');
const indexFile = path.join(dist, 'index.html');

/**
 * Open Graph tags so Discord / Slack / iMessage show a thumbnail and inline player for shared links: a page's
 * address, the video's title and description, and absolute addresses of its thumbnail and MP4.
 */
function ogTags({ url, title, description, image, video, width, height }, settings) {
  const w = width || 1280;
  const h = height || 720;
  const tags = [
    ['og:site_name', settings.site_name],
    ['og:type', 'video.other'],
    ['og:url', url],
    ['og:title', title],
    ['og:description', description],
    image && ['og:image', image],
    image && ['og:image:width', '1280'],
    image && ['og:image:height', String(Math.round((1280 * h) / w))],
    video && ['og:video', video],
    video && ['og:video:secure_url', video],
    video && ['og:video:type', 'video/mp4'],
    video && ['og:video:width', String(w)],
    video && ['og:video:height', String(h)],
    ['twitter:card', video ? 'player' : 'summary_large_image'],
    ['twitter:title', title],
    ['twitter:description', description],
    image && ['twitter:image', image],
    video && ['twitter:player:stream', video],
    video && ['twitter:player:stream:content_type', 'video/mp4'],
  ].filter(Boolean);
  return tags.map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`).join('\n    ') + '\n';
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const webUrl = (u) => (/^https?:\/\/\S+$/.test(String(u || '')) ? u : null);

if (fs.existsSync(indexFile)) {
  // The service worker (web push) must always be fetched fresh.
  app.get('/sw.js', (req, res) => res.sendFile(path.join(dist, 'sw.js'), { headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/javascript; charset=utf-8' } }));
  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }));
  app.get('/{*splat}', (req, res) => {
    const settings = getSettings();
    let html = fs.readFileSync(indexFile, 'utf8');
    let title = settings.site_name;
    const base = (settings.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const m = /^\/watch\/([A-Za-z0-9_-]+)/.exec(req.path);
    if (m) {
      const v = db.prepare('SELECT v.*, u.display_name FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(m[1]);
      if (v && v.visibility !== 'private' && v.status === 'ready') {
        title = `${v.title} - ${settings.site_name}`;
        const alt = apEnabled() && v.visibility === 'public' && v.federate && !v.moderation_status
          ? `<link rel="alternate" type="application/activity+json" href="${escapeHtml(`${apBase(req)}/ap/videos/${v.id}`)}">\n    `
          : '';
        const og = ogTags(
          {
            url: `${base}/watch/${v.id}`,
            title: v.title,
            description: oneLine(v.description) || `${v.display_name} on ${settings.site_name}`,
            image: v.thumb_path && `${base}/media/thumbs/${v.thumb_path}`,
            video: `${base}/media/videos/${v.id}.mp4`,
            width: v.width,
            height: v.height,
          },
          settings,
        );
        html = html.replace('</head>', `    ${alt}${og}</head>`);
      }
    }
    // A clip from another server in the network, shared from here: its card says where it's from, and the
    // thumbnail and video come from that server.
    const n = /^\/n\/(\d+)\/([^/]+)$/.exec(req.path);
    let remoteId = null;
    try {
      remoteId = n && decodeURIComponent(n[2]);
    } catch {}
    const r = remoteId
      ? db.prepare(`SELECT r.*, p.name AS peer_name FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ? AND ${NETWORK_VISIBLE}`).get(Number(n[1]), remoteId)
      : null;
    if (r) {
      title = `${r.title} - ${settings.site_name}`;
      const og = ogTags(
        {
          url: `${base}${req.path}`,
          title: r.title,
          description: oneLine(r.description) || `${r.uploader_display_name || r.uploader_username} on ${r.peer_name}`,
          image: webUrl(r.thumbnail_url),
          video: webUrl(r.video_url),
          width: r.width,
          height: r.height,
        },
        settings,
      );
      html = html.replace('</head>', `    ${og}</head>`);
    }
    const c = /^\/c\/([A-Za-z0-9_]{3,20})$/.exec(req.path);
    const owner = c && apEnabled() ? db.prepare('SELECT id FROM users WHERE username = ? AND remote_instance_id IS NULL').get(c[1]) : null;
    if (owner) {
      // rel="me" names the linked accounts, so Mastodon can verify a profile link back to this page.
      const me = relMeLinks(owner.id).map((u) => `    <link rel="me" href="${escapeHtml(u)}">\n`).join('');
      html = html.replace('</head>', `    <link rel="alternate" type="application/activity+json" href="${escapeHtml(`${apBase(req)}/ap/users/${c[1]}`)}">\n${me}  </head>`);
    }
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
} else {
  app.get('/{*splat}', (req, res) => {
    res.type('text').send(
      'The frontend has not been built yet.\n\n' +
        '  Development: run "npm run dev" and open http://localhost:5173\n' +
        '  Production:  run "npm run build" then "npm start"\n',
    );
  });
}

// ---- errors -----------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
});

// ---- startup ----------------------------------------------------------------

for (const f of fs.readdirSync(DIRS.tmp)) {
  try { fs.unlinkSync(path.join(DIRS.tmp, f)); } catch {}
}
startJobs();
checkFfmpeg();
startUploadSweep();
startNotifyCleanup();
startApCleanup();
startLinkChecks();
startPartyCleanup();
startLiveWatch();
startSearchSync();
resumePending();
startNetwork();

const server = app.listen(PORT, HOST, () => {
  const s = getSettings();
  console.log(`\n${s.site_name} is running`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  Network: http://${i.address}:${PORT}`);
    }
  }
  if (!fs.existsSync(indexFile)) console.log('  (frontend not built yet: "npm run dev" for development, "npm run build" for production)');
  console.log('');
  ensureSetupCode();
});

// Large uploads can take a long time, so disable the default 5 minute request timeout.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 60_000;
