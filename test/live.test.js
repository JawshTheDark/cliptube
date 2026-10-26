// Live streaming: MediaMTX asks ClipTube who may publish and read; viewers watch the HLS through ClipTube,
// chat and are counted; when a stream stops, its recording becomes a draft video (or is thrown away).
// A small stand-in plays MediaMTX's control API and HLS server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Client, startInstance, setupAdmin, registerUser, testClip, waitFor } from './helpers.js';

const SECRET = 'live-test-secret-123';
const internal = `Basic ${Buffer.from(`cliptube:${SECRET}`).toString('base64')}`;
let inst, alice, bob, fake, viewer;
const streams = [];

function fakeMediaMTX() {
  const F = { ready: [], seenAuth: [], hooks: [] };
  F.server = http.createServer((req, res) => {
    // It also takes the site's webhooks, as any bot would.
    if (req.method === 'POST' && req.url === '/hook') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        F.hooks.push(JSON.parse(raw));
        res.writeHead(204).end();
      });
      return;
    }
    F.seenAuth.push(req.headers.authorization || '');
    if (req.headers.authorization !== internal) return res.writeHead(401).end();
    if (req.url === '/v3/paths/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ itemCount: F.ready.length, items: F.ready.map((name) => ({ name, ready: true })) }));
    }
    // Like MediaMTX 1.21: a cookie check first, then each viewer's session in the links when there are no cookies.
    const m = /^\/live\/([A-Za-z0-9_]+)\/(index|video1_stream)\.m3u8(\?.*)?$/.exec(req.url);
    if (m && F.ready.includes(`live/${m[1]}`)) {
      const q = new URLSearchParams(m[3] || '');
      const playlist = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Set-Cookie': 'hlsSession=x; HttpOnly' });
        res.end(body);
      };
      if (m[2] === 'video1_stream') return q.get('session') === 's1' ? playlist('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg0.mp4?session=s1\n') : res.writeHead(404).end();
      if (!q.has('cookieCheck')) return res.writeHead(302, { Location: `/live/${m[1]}/index.m3u8?cookieCheck=1`, 'Set-Cookie': 'cookieCheck=1' }).end();
      return playlist('#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvideo1_stream.m3u8?session=s1\n');
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    F.server.listen(0, '127.0.0.1', () => {
      F.url = `http://127.0.0.1:${F.server.address().port}`;
      resolve(F);
    }),
  );
}

function follow(url, headers = {}) {
  const ctrl = new AbortController();
  const s = { got: [] };
  s.close = () => ctrl.abort();
  s.wait = (pred, what) => waitFor(() => s.got.find(pred), { what, timeout: 20000 });
  (async () => {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event) s.got.push({ event, data: data ? JSON.parse(data) : null });
      }
    }
  })().catch(() => {});
  streams.push(s);
  return s;
}

const auth = (body, secret = SECRET) =>
  fetch(`${inst.url}/api/live/auth?secret=${secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
const keyOf = async () => new URLSearchParams((await alice.get('/api/live/me')).data.stream_key.split('?')[1]).get('key');

before(async () => {
  fake = await fakeMediaMTX();
  inst = await startInstance('live', {
    env: { LIVE_SERVER: 'mediamtx', LIVE_SECRET: SECRET, LIVE_API_URL: fake.url, LIVE_HLS_URL: fake.url, LIVE_END_GRACE_MS: '1500', LIVE_POLL_MS: '300' },
  });
  alice = await setupAdmin(inst, 'alice');
  await alice.patch('/api/admin/settings', { public_url: inst.url });
  bob = await registerUser(inst, 'bob');
  await bob.post('/api/users/alice/subscribe');
});
after(async () => {
  for (const s of streams) s.close();
  await inst?.stop();
  fake?.server.close();
});

test('MediaMTX asks ClipTube who may publish, and only ClipTube may read', async () => {
  const me = (await alice.get('/api/live/me')).data;
  assert.equal(me.enabled, true);
  assert.equal(me.server_url, `rtmp://127.0.0.1/live`);
  assert.match(me.stream_key, /^alice\?key=[A-Za-z0-9_-]{32}$/);
  const key = await keyOf();

  assert.equal(await auth({ action: 'publish', path: 'live/alice', query: `key=${key}` }, 'wrong'), 403);
  assert.equal(await auth({ action: 'publish', path: 'live/alice', query: 'key=nope', ip: '1.2.3.4' }), 401);
  assert.equal(await auth({ action: 'publish', path: 'live/bob', query: `key=${key}` }), 401, 'a key works for its own channel only');
  assert.equal(await auth({ action: 'read', path: 'live/alice', protocol: 'rtmp' }), 401);
  assert.equal(await auth({ action: 'read', path: 'live/alice', user: 'cliptube', password: SECRET }), 200);
  assert.equal(await auth({ action: 'api', user: 'cliptube', password: SECRET }), 200);

  assert.equal((await alice.post('/api/me/webhooks', { url: `${fake.url}/hook`, events: ['live.started'] })).status, 201);
  fake.ready = ['live/alice'];
  assert.equal(await auth({ action: 'publish', path: 'live/alice', query: `key=${key}`, protocol: 'rtmp' }), 200);
  const page = (await new Client(inst.url).get('/api/live/alice')).data;
  assert.equal(page.live, true);
  assert.equal(page.stream.hls_url, '/live/hls/alice/index.m3u8');
  assert.equal(page.stream.title, 'alice is live');
  assert.ok((await bob.get('/api/live/now')).data.live.some((s) => s.channel.username === 'alice'));
  const n = await waitFor(async () => (await bob.get('/api/notifications')).data.notifications.find((x) => x.kind === 'live'), { what: 'the live notification' });
  assert.equal(n.url, '/live/alice');
  // Webhooks hear about it too.
  const hook = await waitFor(() => fake.hooks.find((h) => h.event === 'live.started'), { what: 'the live.started webhook' });
  assert.equal(hook.stream.url, `${inst.url}/live/alice`);
  assert.equal(hook.stream.title, 'alice is live');
  assert.equal(hook.stream.channel.username, 'alice');
  // A key can be changed; the old one stops working.
  assert.equal((await alice.post('/api/live/me/key')).status, 200);
  assert.equal(await auth({ action: 'publish', path: 'live/alice', query: `key=${key}` }), 401);
});

test('viewers watch through ClipTube, are counted, and chat', async () => {
  const hls = await fetch(`${inst.url}/live/hls/alice/index.m3u8`, { redirect: 'manual' });
  assert.equal(hls.status, 200, 'no cookie check for the player');
  assert.equal(hls.headers.get('access-control-allow-origin'), '*');
  assert.equal(hls.headers.get('set-cookie'), null, "MediaMTX's cookies stay behind");
  const variant = (await hls.text()).split('\n').find((l) => l && !l.startsWith('#'));
  assert.equal(variant, 'video1_stream.m3u8?session=s1');
  assert.match(await (await fetch(`${inst.url}/live/hls/alice/${variant}`)).text(), /#EXTINF/, 'the session goes along');
  assert.equal((await fetch(`${inst.url}/live/hls/bob/index.m3u8`)).status, 404, 'bob is not live');

  viewer = follow(`${inst.url}/api/live/alice/events`);
  const hello = await viewer.wait((e) => e.event === 'hello', 'the viewer hello');
  assert.equal(hello.data.stream.title, 'alice is live');
  await viewer.wait((e) => e.event === 'viewers' && e.data.viewers >= 1, 'a viewer count');

  // Chatting needs an account or a guest name.
  assert.equal((await new Client(inst.url).post('/api/live/alice/chat', { body: 'hi' })).status, 401);
  const g = (await new Client(inst.url).post('/api/live/alice/join', { name: 'Gus' })).data;
  const say = (body) => fetch(`${inst.url}/api/live/alice/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-room-member': g.token }, body: JSON.stringify({ body }) });
  assert.equal((await say('first!')).status, 201);
  await viewer.wait((e) => e.event === 'chat' && e.data.body === 'first!', 'the chat message');
  assert.equal((await bob.post('/api/live/alice/chat', { body: 'gg' })).status, 201);
  // The streamer removes someone from the chat.
  assert.equal((await bob.post('/api/live/alice/ban', { member_id: g.member_id })).status, 403, 'only the streamer and moderators');
  assert.equal((await alice.post('/api/live/alice/ban', { member_id: g.member_id })).status, 200);
  assert.equal((await say('still here')).status, 403);
  // Changing the title reaches the stream that is on.
  await alice.patch('/api/live/me', { title: 'Ranked grind' });
  await viewer.wait((e) => e.event === 'live' && e.data.stream.title === 'Ranked grind', 'the new title');
});

test('when the stream stops, its recording becomes a draft video', async () => {
  const dir = path.join(inst.dataDir, 'live', 'live', 'alice');
  fs.mkdirSync(dir, { recursive: true });
  const rec = path.join(dir, '2026-10-25_12-00-00-000000.mp4');
  fs.copyFileSync(testClip(), rec);
  fs.utimesSync(rec, new Date(), new Date()); // as if MediaMTX had just written it
  fake.ready = [];
  await viewer.wait((e) => e.event === 'live_ended', 'the end of the stream');
  const saved = await waitFor(
    async () => {
      const s = (await alice.get('/api/live/me')).data.stream;
      return s?.video_id ? s : null;
    },
    { timeout: 30000, what: 'the recording to be saved' },
  );
  assert.equal(saved.status, 'ended');
  const v = await waitFor(
    async () => {
      const x = (await alice.get(`/api/videos/${saved.video_id}`)).data.video;
      return x.status === 'ready' ? x : null;
    },
    { timeout: 60000, what: 'the saved stream to process' },
  );
  assert.equal(v.title, 'Ranked grind');
  assert.equal(v.draft, true);
  assert.equal(v.visibility, 'private');
  assert.ok(!fs.existsSync(rec), 'the recording files are cleaned up');
  assert.equal((await new Client(inst.url).get('/api/live/alice')).data.live, false);
});

test('a stream the streamer chose not to keep leaves no video', async () => {
  await alice.patch('/api/live/me', { save_recording: false });
  fake.ready = ['live/alice'];
  assert.equal(await auth({ action: 'publish', path: 'live/alice', query: `key=${await keyOf()}` }), 200);
  const dir = path.join(inst.dataDir, 'live', 'live', 'alice');
  const rec = path.join(dir, '2026-10-25_13-00-00-000000.mp4');
  fs.copyFileSync(testClip(), rec);
  fs.utimesSync(rec, new Date(), new Date()); // as if MediaMTX had just written it
  fake.ready = [];
  await waitFor(() => !fs.existsSync(rec), { timeout: 30000, what: 'the recording to be deleted' });
  const s = (await alice.get('/api/live/me')).data.stream;
  assert.equal(s.status, 'ended');
  assert.equal(s.video_id, null);
});
