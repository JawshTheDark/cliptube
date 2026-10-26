// Runs inside the sandbox's OurTube container (scripts/live-sandbox.sh): makes a streamer account, streams a
// test picture to MediaMTX over RTMP with the bundled ffmpeg, and checks the stream goes live, plays as HLS
// through OurTube, ends, and comes back as a draft video. Exit code 0 when every check passed.
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';

const BASE = 'http://127.0.0.1:3000';
let cookie = '';
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
  if (!cond) failed++;
  return cond;
};
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) if (c.startsWith('ct_session=')) cookie = c.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  ok(false, `${what} (timed out)`);
  return null;
}

await until(async () => (await fetch(`${BASE}/api/site`)).ok, 60_000, 'OurTube started');
const reg = await api('/api/auth/register', { method: 'POST', body: { username: 'streamer', password: 'sandbox-streamer-pass-1', setup_code: 'sandbox' } });
ok(reg.status === 201, 'made the streamer account');
await api('/api/admin/settings', { method: 'PATCH', body: { public_url: 'https://live.sandbox.test' } });
await api('/api/live/me', { method: 'PATCH', body: { title: 'Sandbox stream' } });
const me = (await api('/api/live/me')).data;
ok(me?.enabled, 'live streaming is on');
const key = new URLSearchParams(me.stream_key.split('?')[1]).get('key');
// The static ffmpeg crashes looking up names inside a container, so it gets MediaMTX's address instead.
const mtx = (await dns.lookup('cliptube-live')).address;

// A wrong key is refused.
const bad = spawn('node_modules/ffmpeg-static/ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '3', '-c:v', 'libx264', '-f', 'flv', `rtmp://${mtx}:1935/live/streamer?key=wrong`]);
const badCode = await new Promise((r) => bad.on('exit', r));
ok(badCode !== 0, 'a wrong stream key is refused');

console.log('....  streaming 25 seconds of test picture');
const ff = spawn(
  'node_modules/ffmpeg-static/ffmpeg',
  ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '25',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'flv', `rtmp://${mtx}:1935/live/streamer?key=${key}`],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const done = new Promise((r) => ff.on('exit', r));

const live = await until(async () => {
  const r = (await api('/api/live/streamer')).data;
  return r?.live ? r : null;
}, 20_000, 'the stream goes live');
if (live) ok(live.stream.title === 'Sandbox stream', 'the stream has the title from Settings');

let lastHls = '';
const master = await until(async () => {
  const r = await fetch(`${BASE}/live/hls/streamer/index.m3u8`);
  const t = await r.text();
  lastHls = `${r.status} ${t.slice(0, 120).replace(/\s+/g, ' ')}`;
  return r.ok && t.includes('#EXTM3U') ? t : null;
}, 30_000, 'the HLS playlist comes through OurTube');
if (!master) console.log(`      last answer: ${lastHls}`);
if (master) {
  const variant = master.split('\n').find((l) => l && !l.startsWith('#'));
  const get = (file) => fetch(`${BASE}/live/hls/streamer/${file}`);
  // MediaMTX pads a new low-latency playlist with gap segments.
  const segsOf = (t) => t.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('gap.'));
  const media = await until(async () => {
    const t = variant ? await (await get(variant)).text() : '';
    return segsOf(t).length ? t : null;
  }, 15_000, 'the media playlist lists a whole segment');
  if (media) {
    const bytes = async (file) => (file ? (await (await get(file)).arrayBuffer()).byteLength : 0);
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1];
    ok((await bytes(init)) > 0, 'the init segment comes through');
    const seg = segsOf(media).at(-1);
    const n = await bytes(seg);
    ok(n > 10_000, `video data flows (${n} bytes in ${seg.split('?')[0]})`);
  }
}
const now = (await api('/api/live/now?local=1')).data;
ok(now?.live?.some((s) => s.channel.username === 'streamer'), 'the stream is listed as live now');

await done;
console.log('....  the stream stopped');
const ended = await until(async () => {
  const r = (await api('/api/live/me')).data;
  return r?.stream?.status === 'ended' ? r.stream : null;
}, 30_000, 'the stream ends');
const saved = await until(async () => {
  const r = (await api('/api/live/me')).data;
  return r?.stream?.video_id ? r.stream : null;
}, 60_000, 'the recording is saved as a video');
if (saved) {
  const v = await until(async () => {
    const r = (await api(`/api/videos/${saved.video_id}`)).data?.video;
    return r?.status === 'ready' ? r : null;
  }, 120_000, 'the saved recording processes');
  if (v) {
    ok(v.draft === true, 'the recording is a draft');
    ok(v.duration > 15 && v.duration < 35, `the recording is about as long as the stream (${Math.round(v.duration)} s)`);
  }
}
if (ended) ok(true, 'stream ended cleanly');
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
