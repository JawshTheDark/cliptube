#!/usr/bin/env node
// A stand-in for MediaMTX, for working on live players (the live page, the Android app) against a local ClipTube
// without Docker: it makes a live test picture with the bundled ffmpeg, serves it the way MediaMTX does, and
// tells ClipTube the channel went live. When it stops (Ctrl+C, or after the minutes given), ClipTube ends the
// stream after its grace period.
//
//   1. Start ClipTube with live streaming pointed here, for example:
//        LIVE_SERVER=127.0.0.1 LIVE_SECRET=dev-live-secret LIVE_API_URL=http://127.0.0.1:8897 \
//        LIVE_HLS_URL=http://127.0.0.1:8897 LIVE_END_GRACE_MS=5000 node server/index.js --port 3300
//   2. Copy a channel's stream key from Settings, Live streaming, then:
//        LIVE_SECRET=dev-live-secret node scripts/fake-live.mjs http://127.0.0.1:3300 'alice?key=...' [minutes]
//
// The stream plays at http://127.0.0.1:3300/live/alice (from an Android emulator, http://10.0.2.2:3300/live/alice).
// It is plain HLS with one-second segments, a few seconds behind; the real MediaMTX sends low-latency HLS.
// FAKE_LIVE_PORT changes the port (8897).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const [base, streamKey, minutes = '10'] = process.argv.slice(2);
const secret = process.env.LIVE_SECRET || '';
const port = Number(process.env.FAKE_LIVE_PORT) || 8897;
const m = /^([A-Za-z0-9_]{3,20})\?key=([A-Za-z0-9_-]+)$/.exec(streamKey || '');
if (!base || !m || !secret || !(Number(minutes) > 0)) {
  console.error("usage: LIVE_SECRET=<ClipTube's> node scripts/fake-live.mjs <ClipTube URL> '<name>?key=<key>' [minutes]");
  process.exit(1);
}
const [, username, key] = m;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-live-'));
const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
const internal = `Basic ${Buffer.from(`cliptube:${secret}`).toString('base64')}`;
let ready = false;

// What ClipTube asks MediaMTX: which streams are coming in, and the HLS. Like MediaMTX, only ClipTube may read.
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== internal) return res.writeHead(401).end();
  const { pathname } = new URL(req.url, 'http://fake');
  if (pathname === '/v3/paths/list') {
    const items = ready ? [{ name: `live/${username}`, ready: true }] : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ itemCount: items.length, items }));
  }
  const file = pathname.startsWith(`/live/${username}/`) ? path.join(dir, path.basename(pathname)) : '';
  if (!ready || !file || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));

const ff = spawn(
  process.env.FFMPEG_PATH || ffmpegStatic,
  ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', String(Math.round(Number(minutes) * 60)), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p',
    '-filter:a', 'volume=0.05', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+independent_segments', '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8')],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const exited = new Promise((resolve) => ff.on('exit', resolve));

let stopping = false;
async function stop(why, code = 0) {
  if (stopping) return;
  stopping = true;
  ready = false;
  ff.kill();
  await exited;
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${why}; ClipTube ends the stream after its grace period (LIVE_END_GRACE_MS).`);
  process.exit(code);
}
process.on('SIGINT', () => stop('stopped'));
exited.then(() => stop('the test picture ended'));

for (let i = 0; i < 75 && !fs.existsSync(path.join(dir, 'index.m3u8')); i++) await new Promise((r) => setTimeout(r, 200));
ready = true;
// What MediaMTX does when OBS connects: ask ClipTube whether this key may publish.
const hook = await fetch(`${base.replace(/\/+$/, '')}/api/live/auth?secret=${encodeURIComponent(secret)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: '', password: '', ip: '127.0.0.1', action: 'publish', path: `live/${username}`, protocol: 'rtmp', query: `key=${key}` }),
}).catch((e) => ({ status: e.message }));
if (hook.status !== 200) {
  console.error(`ClipTube refused the stream (${hook.status}): check that it runs with the same LIVE_SECRET and LIVE_*_URL pointing here, and the stream key.`);
  await stop('not live', 1);
}
console.log(`${username} is live for ${minutes} minute(s): ${base.replace(/\/+$/, '')}/live/${username} (Ctrl+C stops)`);
