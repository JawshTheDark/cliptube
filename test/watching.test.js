// Watching upgrades: HLS ladder and federation rendition, original downloads, dislike counts, support
// links, captions, skippable segments, and community titles and thumbnails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

let inst, admin, bob, carol, anon, hd, small;

before(async () => {
  inst = await startInstance('watch');
  admin = await setupAdmin(inst, 'alice', 'Watch Test');
  bob = await registerUser(inst, 'bob');
  carol = await registerUser(inst, 'carol');
  anon = new Client(inst.url);
  await admin.patch('/api/admin/settings', { hls_ladder: 'full' });
  [hd, small] = await Promise.all([uploadReady(bob, { title: 'Bob in 1080p60' }, 'hd'), uploadReady(bob, { title: 'Bob small' })]);
});
after(async () => {
  await inst?.stop();
});

const media = (url, client = anon) => fetch(inst.url + url, { headers: client.cookie ? { Cookie: client.cookie } : {} });

test('HLS ladder with a source rung, and a 720p federation copy', async () => {
  const v = await waitFor(async () => {
    const x = (await anon.get(`/api/videos/${hd.id}`)).data.video;
    return x.hls_url && x.federation_url ? x : null;
  }, { timeout: 120000, what: 'renditions' });
  assert.deepEqual(v.hls_rungs.map((r) => r.name).sort(), ['480p', '720p', 'source']);
  assert.equal(v.hls_rungs.find((r) => r.name === 'source').height, 1080);
  assert.equal(v.hls_rungs.find((r) => r.name === '480p').fps, 30);
  const master = await media(v.hls_url);
  assert.equal(master.status, 200);
  assert.match(master.headers.get('content-type'), /mpegurl/);
  const text = await master.text();
  assert.match(text, /RESOLUTION=1920x1080/);
  assert.match(text, /480p\.m3u8/);
  const rung = await (await media(v.hls_url.replace('master.m3u8', '720p.m3u8'))).text();
  const seg = rung.split('\n').find((l) => l.endsWith('.m4s'));
  assert.equal((await media(v.hls_url.replace('master.m3u8', seg))).status, 200);
  assert.equal((await media(v.federation_url)).status, 200);
  // A small clip has nothing to scale down to: just the source rung, and no federation copy.
  const s = await waitFor(async () => {
    const x = (await anon.get(`/api/videos/${small.id}`)).data.video;
    return x.hls_url ? x : null;
  }, { timeout: 60000, what: 'small renditions' });
  assert.deepEqual(s.hls_rungs.map((r) => r.name), ['source']);
  assert.equal(s.federation_url, null);
  // Turning the ladder off removes HLS again.
  await admin.patch('/api/admin/settings', { hls_ladder: 'off' });
  await waitFor(async () => !(await anon.get(`/api/videos/${small.id}`)).data.video.hls_url, { timeout: 60000, what: 'HLS removal' });
  assert.equal((await media(s.hls_url)).status, 404);
});

test('original downloads: always for the uploader, for viewers when allowed', async () => {
  const own = (await bob.get(`/api/videos/${small.id}`)).data.video;
  assert.ok(own.original_download, 'uploader sees the download');
  assert.equal((await media(`/media/original/${small.id}`, bob)).status, 200);
  assert.equal((await carol.get(`/api/videos/${small.id}`)).data.video.original_download, null);
  assert.equal((await media(`/media/original/${small.id}`, carol)).status, 404);
  await bob.patch(`/api/videos/${small.id}`, { allow_original_download: true });
  const r = await media(`/media/original/${small.id}`, carol);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
});

test('dislike counts can be hidden from viewers', async () => {
  await carol.post(`/api/videos/${small.id}/like`, { value: -1 });
  assert.equal((await anon.get(`/api/videos/${small.id}`)).data.video.dislikes, 1);
  await admin.patch('/api/admin/settings', { show_dislikes: false });
  assert.equal((await anon.get(`/api/videos/${small.id}`)).data.video.dislikes, null);
  assert.equal((await bob.get(`/api/videos/${small.id}`)).data.video.dislikes, 1, 'the uploader still sees them');
  assert.equal((await anon.get('/api/site')).data.show_dislikes, false);
  await admin.patch('/api/admin/settings', { show_dislikes: true });
});

test('support links on channels and watch pages', async () => {
  assert.equal((await bob.patch('/api/me', { support_links: [{ label: 'Tips', url: 'http://insecure.example' }] })).status, 400);
  assert.equal((await bob.patch('/api/me', { support_links: [{ label: 'Ko-fi', url: 'https://ko-fi.com/bob' }, { url: 'https://www.patreon.com/bob' }] })).status, 200);
  const ch = (await anon.get('/api/users/bob')).data.channel;
  assert.deepEqual(ch.support_links, [{ label: 'Ko-fi', url: 'https://ko-fi.com/bob' }, { label: 'patreon.com', url: 'https://www.patreon.com/bob' }]);
  assert.equal((await anon.get(`/api/videos/${small.id}`)).data.video.uploader.support_links.length, 2);
});

const upload = (client, id, name, text, fields) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([text]), name);
  return client.req('POST', `/api/videos/${id}/captions`, undefined, { form });
};

test('captions: uploaders publish, viewers submit for approval', async () => {
  const srt = '1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:02,500 --> 00:00:03,500\nGeneral Kenobi\n';
  const r = await upload(bob, small.id, 'en.srt', srt, { lang: 'en', label: 'English' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.caption.status, 'published');
  const vtt = await (await media(r.data.caption.url)).text();
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:00\.500 --> 00:00:02\.000/);
  assert.doesNotMatch(vtt, /^1$/m);

  const bad = await upload(carol, small.id, 'x.txt', 'not captions', { lang: 'es' });
  assert.equal(bad.status, 400);
  const sub = await upload(carol, small.id, 'es.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHola\n', { lang: 'es', label: 'Español' });
  assert.equal(sub.data.caption.status, 'pending');
  assert.equal((await anon.get(`/api/videos/${small.id}/captions`)).data.captions.length, 1);
  assert.equal((await media(sub.data.caption.url)).status, 404);
  assert.equal((await bob.get(`/api/videos/${small.id}/captions`)).data.captions.length, 2);
  assert.equal((await bob.patch(`/api/videos/${small.id}/captions/${sub.data.caption.id}`, { status: 'published' })).status, 200);
  assert.deepEqual((await anon.get(`/api/videos/${small.id}`)).data.video.captions.map((c) => c.lang).sort(), ['en', 'es']);
});

test('skippable segments: creators mark them, viewers suggest them', async () => {
  const own = await bob.post(`/api/videos/${small.id}/segments`, { kind: 'intro', start: 0, end: 1.5 });
  assert.equal(own.data.segment.status, 'published');
  const sug = await carol.post(`/api/videos/${small.id}/segments`, { kind: 'sponsor', start: 2, end: 3.5 });
  assert.equal(sug.data.segment.status, 'pending');
  assert.equal((await bob.post(`/api/videos/${small.id}/segments`, { kind: 'nope', start: 0, end: 2 })).status, 400);
  assert.equal((await anon.get(`/api/videos/${small.id}`)).data.video.segments.length, 1);
  await bob.patch(`/api/videos/${small.id}/segments/${sug.data.segment.id}`, { status: 'published' });
  assert.deepEqual((await anon.get(`/api/videos/${small.id}`)).data.video.segments.map((s) => s.kind), ['intro', 'sponsor']);
});

test('community titles and thumbnails: suggest, vote, opt in, adopt', async () => {
  let s = (await carol.post(`/api/videos/${small.id}/suggestions/titles`, { title: 'Test pattern with a beep' })).data;
  assert.equal(s.titles[0].votes, 1);
  s = (await admin.post(`/api/suggestions/titles/${s.titles[0].id}/vote`)).data;
  assert.equal(s.titles[0].votes, 2);
  const listed = (await anon.get('/api/videos')).data.videos.find((v) => v.id === small.id);
  assert.equal(listed.community.title, 'Test pattern with a beep');

  s = (await carol.post(`/api/videos/${small.id}/suggestions/thumbnails`, { time: 1 })).data;
  assert.equal(s.thumbnails.length, 1);
  assert.equal((await media(s.thumbnails[0].url)).status, 200);
  assert.equal((await carol.post(`/api/suggestions/titles/${s.titles[0].id}/adopt`)).status, 403);
  s = (await bob.post(`/api/suggestions/titles/${s.titles[0].id}/adopt`)).data;
  assert.equal(s.titles.length, 0);
  const v = (await anon.get(`/api/videos/${small.id}`)).data.video;
  assert.equal(v.title, 'Test pattern with a beep');
  const before = v.thumbnail_url;
  await bob.post(`/api/suggestions/thumbnails/${s.thumbnails[0].id}/adopt`);
  assert.notEqual((await anon.get(`/api/videos/${small.id}`)).data.video.thumbnail_url, before);
});
