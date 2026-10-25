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
import { resumePending } from './media.js';
import { startJobs } from './jobs.js';
import { networkProtocolRouter, networkAdminRouter, networkRouter, networkActive, networkPeers, networkInfo, startNetwork } from './network.js';
import { modRouter, reportsRouter, legalAdminRouter, legalPublicRouter } from './moderation.js';
import { privacyRouter } from './privacy.js';
import { registrationMode } from './auth.js';
import './spam.js'; // registers the comment spam checks with the intake pipeline
import { HttpError, escapeHtml } from './util.js';

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', true);

// Keep the raw bytes: network inbox requests are verified against a signature over the exact body.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
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
app.use('/api', legalPublicRouter); // /api/legal, /api/transparency
app.use('/api/auth', authRouter);
app.use('/api/videos', videosRouter);
app.use('/api/users', usersRouter);
app.use('/api/me', privacyRouter); // exports, account deletion
app.use('/api/me', meRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/mod', modRouter);
app.use('/api/network', networkRouter);
app.use('/api/admin/network', networkAdminRouter);
app.use('/api/admin/legal', legalAdminRouter);
app.use('/api/admin', adminRouter);
app.use('/media', mediaRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- frontend ---------------------------------------------------------------

const dist = path.join(ROOT_DIR, 'web', 'dist');
const indexFile = path.join(dist, 'index.html');

/** Open Graph tags so Discord / Slack / iMessage show a thumbnail and inline player for shared links. */
function ogTags(v, settings, req) {
  const base = (settings.public_url || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const url = `${base}/watch/${v.id}`;
  const videoUrl = `${base}/media/videos/${v.id}.mp4`;
  const description = (v.description || '').replace(/\s+/g, ' ').trim().slice(0, 200) || `${v.display_name} on ${settings.site_name}`;
  const tags = [
    ['og:site_name', settings.site_name],
    ['og:type', 'video.other'],
    ['og:url', url],
    ['og:title', v.title],
    ['og:description', description],
    v.thumb_path && ['og:image', `${base}/media/thumbs/${v.thumb_path}`],
    v.thumb_path && ['og:image:width', '1280'],
    v.thumb_path && ['og:image:height', String(Math.round((1280 * (v.height || 9)) / (v.width || 16)))],
    ['og:video', videoUrl],
    ['og:video:secure_url', videoUrl],
    ['og:video:type', 'video/mp4'],
    ['og:video:width', String(v.width || 1280)],
    ['og:video:height', String(v.height || 720)],
    ['twitter:card', 'player'],
    ['twitter:title', v.title],
    ['twitter:description', description],
    v.thumb_path && ['twitter:image', `${base}/media/thumbs/${v.thumb_path}`],
    ['twitter:player:stream', videoUrl],
    ['twitter:player:stream:content_type', 'video/mp4'],
  ].filter(Boolean);
  return tags.map(([p, c]) => `<meta property="${p}" content="${escapeHtml(c)}">`).join('\n    ') + '\n';
}

if (fs.existsSync(indexFile)) {
  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true }));
  app.get('/{*splat}', (req, res) => {
    const settings = getSettings();
    let html = fs.readFileSync(indexFile, 'utf8');
    let title = settings.site_name;
    const m = /^\/watch\/([A-Za-z0-9_-]+)/.exec(req.path);
    if (m) {
      const v = db.prepare('SELECT v.*, u.display_name FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(m[1]);
      if (v && v.visibility !== 'private' && v.status === 'ready') {
        title = `${v.title} - ${settings.site_name}`;
        html = html.replace('</head>', `    ${ogTags(v, settings, req)}</head>`);
      }
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
