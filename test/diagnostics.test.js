// Admin -> Debugging, and telling admins about new versions. A small server stands in for GitHub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, startInstance, setupAdmin, registerUser } from './helpers.js';

let inst, alice, bob, github;
let latest = '99.0.0';
let asked = 0;

before(async () => {
  github = http.createServer((req, res) => {
    asked++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'ourtube', version: latest }));
  });
  await new Promise((r) => github.listen(0, '127.0.0.1', r));
  inst = await startInstance('diagnostics', { env: { UPDATE_CHECK_URL: `http://127.0.0.1:${github.address().port}/package.json` } });
  alice = await setupAdmin(inst, 'alice');
  bob = await registerUser(inst, 'bob');
});
after(async () => {
  await inst?.stop();
  github?.close();
});

test('the Debugging report is for admins and has what an admin needs', async () => {
  assert.equal((await new Client(inst.url).get('/api/admin/diagnostics')).status, 401);
  assert.equal((await bob.get('/api/admin/diagnostics')).status, 403);
  const d = (await alice.get('/api/admin/diagnostics')).data;
  assert.match(d.app.version, /^\d+\.\d+\.\d+/);
  assert.match(d.tools.ffmpeg.version, /^ffmpeg version/);
  assert.match(d.tools.ffprobe.version, /^ffprobe version/);
  assert.ok(d.database.schema_version >= 20);
  assert.ok(d.storage.disk.free > 0);
  assert.ok(d.jobs.lanes.media);
  assert.ok(Array.isArray(d.log));
  assert.equal(JSON.stringify(d).includes('testcode'), false, 'no secrets in the report');
});

test('a newer version on GitHub is announced to admins once', async () => {
  const u = (await alice.post('/api/admin/diagnostics/update', { check: true })).data;
  assert.equal(u.latest, '99.0.0');
  assert.equal(u.available, true);
  const updates = async () => (await alice.get('/api/notifications')).data.notifications.filter((n) => n.kind === 'update');
  assert.equal((await updates()).length, 1);
  assert.match((await updates())[0].title, /OurTube 99\.0\.0 is out/);
  assert.equal((await bob.get('/api/notifications')).data.notifications.some((n) => n.kind === 'update'), false, 'only admins hear about it');
  await alice.post('/api/admin/diagnostics/update', { check: true });
  assert.equal((await updates()).length, 1, 'not twice for the same version');

  // Turned off: nothing is asked.
  const before = asked;
  assert.equal((await alice.post('/api/admin/diagnostics/update', { enabled: false, check: true })).data.enabled, false);
  assert.equal(asked, before);
  latest = '0.1.0';
  const back = (await alice.post('/api/admin/diagnostics/update', { enabled: true, check: true })).data;
  assert.equal(back.available, false, 'an older version on GitHub is no news');
});
