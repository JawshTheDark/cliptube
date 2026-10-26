// Admin -> Debugging: what an admin, or whoever helps them, needs when something goes wrong. Versions and
// runtime, FFmpeg, disk and the database, the job queue, the network and ActivityPub, live streaming, email,
// update checks, and the server's recent warnings and errors. Nothing secret is included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { db, getSettings, setSetting } from './db.js';
import { DATA_DIR, DIRS, VERSION } from './config.js';
import { requireAdmin } from './auth.js';
import { ffmpegBin, ffprobeBin, run } from './media.js';
import { jobStats } from './jobs.js';
import { networkInfo, networkPeers } from './network.js';
import { apBase, apEnabled } from './ap/common.js';
import { liveEnabled, liveReachable } from './live.js';
import { mailConfigured } from './mail.js';
import { checkForUpdate, updateState } from './updates.js';

const STARTED = Date.now();

// ---- recent warnings and errors ------------------------------------------------------------------

const LOG_SIZE = 200;
const logLines = [];
const asText = (a) => {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};
/** Keeps the last warnings and errors the server logs, for the Debugging tab. Call once, at startup. */
export function captureLogs() {
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logLines.push({ at: Date.now(), level, text: args.map(asText).join(' ').slice(0, 2000) });
      if (logLines.length > LOG_SIZE) logLines.shift();
      original(...args);
    };
  }
}

// ---- slow facts, cached ----------------------------------------------------------------------------

let toolsCache = null;
async function tools() {
  if (toolsCache && Date.now() - toolsCache.at < 10 * 60_000) return toolsCache.value;
  const versionOf = async (bin) => {
    try {
      return (await run(bin, ['-version'])).stdout.split('\n')[0].split(' Copyright')[0].trim();
    } catch (e) {
      return `not working: ${e.message}`;
    }
  };
  let encoders = [];
  try {
    const out = (await run(ffmpegBin, ['-hide_banner', '-encoders'])).stdout;
    encoders = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'h264_videotoolbox'].filter((e) => out.includes(` ${e} `));
  } catch {}
  const value = {
    ffmpeg: { path: ffmpegBin, version: await versionOf(ffmpegBin) },
    ffprobe: { path: ffprobeBin, version: await versionOf(ffprobeBin) },
    encoder: getSettings().encoder,
    hardware_encoders_built_in: encoders,
  };
  toolsCache = { at: Date.now(), value };
  return value;
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
          files++;
        } catch {}
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

let storageCache = null;
function storage() {
  if (storageCache && Date.now() - storageCache.at < 60_000) return storageCache.value;
  const folders = Object.fromEntries(Object.entries(DIRS).map(([k, d]) => [k, dirSize(d)]));
  const dbBytes = ['cliptube.db', 'cliptube.db-wal', 'cliptube.db-shm'].reduce((n, f) => {
    try {
      return n + fs.statSync(path.join(DATA_DIR, f)).size;
    } catch {
      return n;
    }
  }, 0);
  let disk = null;
  try {
    const s = fs.statfsSync(DATA_DIR);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {}
  const value = { data_dir: DATA_DIR, folders, database_bytes: dbBytes, backups: dirSize(path.join(DATA_DIR, 'backups')), disk };
  storageCache = { at: Date.now(), value };
  return value;
}

// ---- the report ------------------------------------------------------------------------------------

async function report(req) {
  const s = getSettings();
  const mem = process.memoryUsage();
  const peers = networkPeers();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    app: {
      version: VERSION,
      node: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      in_docker: fs.existsSync('/.dockerenv'),
      cpus: os.cpus().length,
      memory: { rss: mem.rss, heap_used: mem.heapUsed, system_total: os.totalmem(), system_free: os.freemem() },
      started_at: STARTED,
      uptime_seconds: Math.round(process.uptime()),
      public_url: s.public_url || null,
      address_seen: apBase(req),
    },
    update: updateState(),
    tools: await tools(),
    storage: storage(),
    database: {
      schema_version: count('SELECT COALESCE(MAX(version), 0) AS n FROM schema_version'),
      journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      users: count('SELECT COUNT(*) AS n FROM users WHERE remote_instance_id IS NULL'),
      videos: count('SELECT COUNT(*) AS n FROM videos'),
      network_videos: count('SELECT COUNT(*) AS n FROM network_videos'),
    },
    jobs: jobStats(),
    network: {
      ...networkInfo(),
      peers: peers.map((p) => ({ name: p.name, url: p.url, videos: p.video_count })),
      activitypub: {
        enabled: apEnabled(),
        following: count("SELECT COUNT(*) AS n FROM ap_follows WHERE local_actor = 'i' AND status = 'accepted'"),
        following_pending: count("SELECT COUNT(*) AS n FROM ap_follows WHERE local_actor = 'i' AND status = 'pending'"),
        followers: count('SELECT COUNT(*) AS n FROM ap_followers'),
      },
    },
    live: { enabled: liveEnabled(), server_answers: await liveReachable() },
    email: { configured: mailConfigured(s) },
    log: logLines.slice(-100),
  };
}

export const diagnosticsRouter = Router();
diagnosticsRouter.use(requireAdmin);

diagnosticsRouter.get('/', async (req, res) => res.json(await report(req)));

diagnosticsRouter.get('/update', (req, res) => res.json(updateState()));

diagnosticsRouter.post('/update', async (req, res) => {
  if (req.body?.enabled !== undefined) setSetting('update_check', req.body.enabled ? 'true' : 'false');
  res.json(req.body?.check ? await checkForUpdate() : updateState());
});
