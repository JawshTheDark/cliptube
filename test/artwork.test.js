// Uploads wait as drafts until their details are saved, and game artwork comes from SteamGridDB (a small
// stand-in server plays SteamGridDB here, checking the API key like the real one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { startInstance, setupAdmin, registerUser, testClip, tempDir, waitFor } from './helpers.js';

const KEY = 'test-sgdb-key';
let hub, member, A, B, bob, sgdb;

/** A stand-in for SteamGridDB's API v2: one game, two covers, a logo and a banner. */
function fakeSteamGridDB() {
  const dir = tempDir('sgdb');
  const img = (name, args) => {
    const f = path.join(dir, name);
    execFileSync(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', args, '-frames:v', '1', f], { stdio: 'ignore' });
    return fs.readFileSync(f);
  };
  const files = {
    'cover1.png': img('cover1.png', 'color=c=blue:s=600x900'),
    'cover2.png': img('cover2.png', 'color=c=green:s=600x900'),
    'logo1.png': img('logo1.png', 'color=c=red@0.5:s=400x120,format=rgba'),
    'hero1.png': img('hero1.png', 'color=c=purple:s=1920x620'),
  };
  const S = { origin: '', calls: [] };
  const image = (id, name, author, w, h) => ({ id, url: `${S.origin}/img/${name}`, thumb: `${S.origin}/img/${name}`, width: w, height: h, style: 'alternate', score: 10 - id % 10, author: { name: author } });
  S.server = http.createServer((req, res) => {
    const url = new URL(req.url, S.origin);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname.startsWith('/img/')) {
      const f = files[url.pathname.slice(5)];
      if (!f) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(f);
    }
    S.calls.push(url.pathname + url.search);
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { success: false, errors: ['Unauthorized'] });
    if (url.pathname.startsWith('/search/autocomplete/')) {
      const term = decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
      return json(200, { success: true, data: term.includes('rocket') ? [{ id: 4242, name: 'Rocket League', release_date: 1436832000, verified: true, types: ['steam'] }] : [] });
    }
    if (url.pathname === '/grids/game/4242') return json(200, { success: true, data: [image(1, 'cover1.png', 'Gridder', 600, 900), image(2, 'cover2.png', 'Gridder Two', 600, 900)] });
    if (url.pathname === '/logos/game/4242') return json(200, { success: true, data: [image(11, 'logo1.png', 'Logoist', 400, 120)] });
    if (url.pathname === '/heroes/game/4242') return json(200, { success: true, data: [image(21, 'hero1.png', 'Herald', 1920, 620)] });
    return json(404, { success: false, errors: ['Not found'] });
  });
  return new Promise((resolve) =>
    S.server.listen(0, '127.0.0.1', () => {
      S.origin = `http://127.0.0.1:${S.server.address().port}`;
      resolve(S);
    }),
  );
}

before(async () => {
  sgdb = await fakeSteamGridDB();
  const env = { STEAMGRIDDB_BASE_URL: sgdb.origin };
  [hub, member] = await Promise.all([startInstance('art-hub', { env }), startInstance('art-member', { env })]);
  [A, B] = await Promise.all([setupAdmin(hub, 'alice', 'Art Hub'), setupAdmin(member, 'bea', 'Art Member')]);
  for (const [c, inst] of [[A, hub], [B, member]]) await c.patch('/api/admin/settings', { public_url: inst.url });
  bob = await registerUser(hub, 'bob');
});
after(async () => {
  await Promise.all([hub?.stop(), member?.stop()]);
  sgdb?.server.close();
});

test('an upload waits as a draft until its details are saved', async () => {
  await bob.post('/api/users/alice/subscribe');
  const up = await A.upload(testClip(), { title: 'clip_0042', visibility: 'public', draft: 'true' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const id = up.data.video.id;
  const ready = await waitFor(async () => {
    const v = (await A.get(`/api/videos/${id}`)).data.video;
    return v.status === 'ready' ? v : null;
  }, { timeout: 60000, what: 'the draft to process' });
  assert.equal(ready.draft, true);
  assert.equal(ready.visibility, 'private');
  assert.equal(ready.draft_visibility, 'public');
  assert.equal(ready.published_at, null);
  // Nobody else sees it, it isn't listed or federated, and subscribers aren't told.
  assert.equal((await bob.get(`/api/videos/${id}`)).status, 404);
  assert.ok(!(await bob.get('/api/videos')).data.videos.some((v) => v.id === id));
  assert.equal((await fetch(`${hub.url}/ap/videos/${id}`, { headers: { Accept: 'application/activity+json' } })).status, 404);
  assert.equal((await bob.get('/api/notifications')).data.notifications.filter((n) => n.kind === 'upload').length, 0);

  // Details saved without publishing (what the upload page does with details typed during the upload).
  await A.patch(`/api/videos/${id}`, { title: 'The final title', publish: false });
  assert.equal((await A.get(`/api/videos/${id}`)).data.video.draft, true);
  assert.equal((await bob.get(`/api/videos/${id}`)).status, 404);

  // Save details: published, with the title and visibility chosen.
  const saved = (await A.patch(`/api/videos/${id}`, { title: 'The final title', visibility: 'public', publish: true })).data.video;
  assert.equal(saved.draft, false);
  assert.equal(saved.visibility, 'public');
  assert.ok(saved.published_at);
  assert.equal((await bob.get(`/api/videos/${id}`)).data.video.title, 'The final title');
  const n = await waitFor(async () => (await bob.get('/api/notifications')).data.notifications.find((x) => x.kind === 'upload'), { what: 'the upload notification' });
  assert.match(n.title, /The final title/);
  // Uploads without the draft flag (the API, scripts) are published as before.
  const direct = await A.upload(testClip(), { title: 'Straight out', visibility: 'public' });
  assert.equal(direct.data.video.draft, false);
});

test('SteamGridDB: the API key is write-only, and new games get a cover, logo and banner', async () => {
  // Not set up yet: picking is refused with a clear message.
  const early = await A.get('/api/games/steamgriddb/search?q=rocket');
  assert.equal(early.status, 400);
  assert.match(early.data.error, /API key/);

  const saved = await A.patch('/api/admin/settings', { steamgriddb_api_key: KEY });
  assert.equal(saved.status, 200);
  const s = (await A.get('/api/admin/settings')).data;
  assert.equal(s.settings.steamgriddb_key_set, true);
  assert.ok(!JSON.stringify(s).includes(KEY), 'the key never goes back to the browser');

  assert.equal((await A.post('/api/games', { name: 'Rocket League' })).status, 201);
  const g = await waitFor(async () => {
    const x = (await A.get('/api/games/rocket-league')).data.game;
    return x.artwork_url && x.logo_url && x.hero_url ? x : null;
  }, { timeout: 30000, what: 'the artwork to be filled in' });
  assert.equal(g.sgdb_id, 4242);
  assert.equal(g.credits.cover.author, 'Gridder');
  assert.equal(g.credits.logo.author, 'Logoist');
  assert.equal(g.credits.hero.author, 'Herald');
  const logo = await fetch(`${hub.url}${g.logo_url}`);
  assert.equal(logo.headers.get('content-type'), 'image/png', 'logos stay transparent PNGs');
  assert.ok(sgdb.calls.some((c) => c.startsWith('/logos/game/4242') && c.includes('nsfw=false')), sgdb.calls.join(' '));
});

test('SteamGridDB: moderators pick another image, and a bad key is reported', async () => {
  const found = (await A.get('/api/games/steamgriddb/search?q=Rocket')).data.results;
  assert.deepEqual(found[0], { id: 4242, name: 'Rocket League', year: 2015, verified: true });
  const covers = (await A.get('/api/games/rocket-league/steamgriddb?kind=cover&sgdb_id=4242')).data.images;
  assert.equal(covers.length, 2);
  const before = (await A.get('/api/games/rocket-league')).data.game.artwork_url;
  const r = await A.post('/api/games/rocket-league/steamgriddb', { kind: 'cover', sgdb_id: 4242, image_id: covers[1].id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.notEqual(r.data.game.artwork_url, before);
  assert.equal(r.data.game.credits.cover.author, 'Gridder Two');
  // Only images SteamGridDB lists for that game can be saved.
  assert.equal((await A.post('/api/games/rocket-league/steamgriddb', { kind: 'cover', sgdb_id: 4242, image_id: 999 })).status, 404);
  assert.equal((await bob.get('/api/games/steamgriddb/search?q=Rocket')).status, 403, 'moderators only');

  await A.patch('/api/admin/settings', { steamgriddb_api_key: 'not-the-key' });
  const bad = await A.get('/api/games/steamgriddb/search?q=Rocket');
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /refused the API key/);
  await A.patch('/api/admin/settings', { steamgriddb_api_key: KEY });
});

test("the hub's catalog carries the artwork to members", async () => {
  assert.equal((await A.patch('/api/admin/network/hub', { enabled: true })).status, 200);
  const j = await B.post('/api/admin/network/join', { url: hub.url });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const g = await waitFor(async () => {
    await B.post('/api/admin/network/sync');
    return (await B.get('/api/games')).data.games.find((x) => x.id === 'rocket-league');
  }, { what: 'the catalog on the member' });
  assert.equal(g.from_hub, true);
  for (const k of ['artwork_url', 'logo_url', 'hero_url']) assert.ok(g[k]?.startsWith(`${hub.url}/media/thumbs/`), `${k}: ${g[k]}`);
  assert.equal(g.credits.logo.author, 'Logoist');
  // The member can't swap the hub's artwork.
  assert.equal((await B.post('/api/games/rocket-league/steamgriddb/auto', {})).status, 403);
});
