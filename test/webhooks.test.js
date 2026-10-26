// Outgoing webhooks, each person's own: someone points theirs at a bot, a bridge or a chat channel, and their
// published videos (and public live streams) go out to it, signed when there is a secret, in its format. An
// admin's can cover the whole server. A small server stands in for the other end. Webhooks can't reach the
// server's own network, except an admin's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Client, startInstance, setupAdmin, registerUser, testClip, uploadReady, waitFor } from './helpers.js';

let inst, alice, bob, receiver;
const got = []; // { path, headers, raw, body }

before(async () => {
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {}
      got.push({ path: req.url, headers: req.headers, raw, body });
      if (req.url === '/fail') return res.writeHead(500).end('nope');
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  inst = await startInstance('webhooks');
  alice = await setupAdmin(inst, 'alice', 'Hook Site');
  await alice.patch('/api/admin/settings', { public_url: inst.url });
  bob = await registerUser(inst, 'bob');
});
after(async () => {
  await inst?.stop();
  receiver?.close();
});

const at = (p) => `http://127.0.0.1:${receiver.address().port}${p}`;
const sent = (p, event) => got.filter((g) => g.path === p && (!event || g.headers['x-cliptube-event'] === event));
const quiet = () => new Promise((r) => setTimeout(r, 1500));

test('each person sets up their own webhooks', async () => {
  assert.equal((await new Client(inst.url).get('/api/me/webhooks')).status, 401);
  assert.equal((await bob.post('/api/me/webhooks', { url: 'ftp://example.com/hook' })).status, 400);
  assert.equal((await bob.post('/api/me/webhooks', { url: at('/x'), events: ['nope'] })).status, 400);
  assert.equal((await bob.post('/api/me/webhooks', { url: at('/x'), format: 'xml' })).status, 400);
  assert.equal((await bob.post('/api/me/webhooks', { url: `http://user:pass@127.0.0.1:${receiver.address().port}/x` })).status, 400);
  const mine = await bob.post('/api/me/webhooks', { url: at('/bob-json'), format: 'json', events: ['video.published'], secret: 's3cret' });
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  assert.equal(mine.data.webhook.has_secret, true);
  assert.equal(mine.data.webhook.secret, undefined, 'the secret is never shown again');
  const hers = await alice.post('/api/me/webhooks', { url: at('/alice-discord'), format: 'discord', events: ['video.published', 'live.started'] });
  assert.equal(hers.status, 201);
  // Each sees and changes only their own.
  assert.deepEqual((await bob.get('/api/me/webhooks')).data.webhooks.map((h) => h.url), [at('/bob-json')]);
  assert.deepEqual((await alice.get('/api/me/webhooks')).data.webhooks.map((h) => h.url), [at('/alice-discord')]);
  const id = hers.data.webhook.id;
  assert.equal((await bob.patch(`/api/me/webhooks/${id}`, { enabled: false })).status, 404);
  assert.equal((await bob.post(`/api/me/webhooks/${id}/test`)).status, 404);
  assert.equal((await bob.del(`/api/me/webhooks/${id}`)).status, 404);
});

test("a published video goes to its owner's webhooks only, signed where there is a secret", async () => {
  const v = await uploadReady(bob, { title: 'Bob hooks a clip', tags: 'ace' });
  await waitFor(() => sent('/bob-json', 'video.published').length === 1, { what: "bob's delivery" });
  const j = sent('/bob-json', 'video.published')[0];
  const signature = `sha256=${crypto.createHmac('sha256', 's3cret').update(j.raw).digest('hex')}`;
  assert.equal(j.headers['x-ourtube-signature'], signature);
  assert.equal(j.headers['x-cliptube-signature'], signature, 'the old header name is still sent');
  assert.equal(j.headers['x-ourtube-event'], 'video.published');
  assert.match(j.headers['user-agent'], /^OurTube\//);
  assert.equal(j.body.event, 'video.published');
  assert.equal(j.body.site.name, 'Hook Site');
  assert.equal(j.body.video.title, 'Bob hooks a clip');
  assert.equal(j.body.video.url, `${inst.url}/watch/${v.id}`);
  assert.deepEqual(j.body.video.tags, ['ace']);
  assert.equal(j.body.video.channel.username, 'bob');
  assert.ok(j.body.video.thumbnail_url?.startsWith(`${inst.url}/media/thumbs/`));

  await uploadReady(alice, { title: 'Alice hooks one too' });
  await waitFor(() => sent('/alice-discord', 'video.published').length === 1, { what: "alice's delivery" });
  const d = sent('/alice-discord', 'video.published')[0];
  assert.equal(d.headers['x-ourtube-signature'], undefined);
  assert.equal(d.headers['x-cliptube-signature'], undefined);
  assert.equal(d.body.username, 'Hook Site');
  assert.match(d.body.content, /alice posted a new video: Alice hooks one too/);
  await quiet();
  assert.equal(sent('/bob-json', 'video.published').length, 1, "alice's video isn't bob's business");
  assert.ok(!sent('/alice-discord').some((g) => g.body?.content?.includes('Bob hooks')), "and bob's isn't hers");
  // Saving the details again doesn't send it twice.
  await bob.patch(`/api/videos/${v.id}`, { title: 'Bob hooks a clip (edited)' });
  await quiet();
  assert.equal(sent('/bob-json', 'video.published').length, 1);
});

test('drafts and private videos go out only once they are public', async () => {
  const before = sent('/bob-json', 'video.published').length;
  const draft = await bob.upload(testClip('h264'), { title: 'Draft first', visibility: 'public', draft: 'true' });
  assert.equal(draft.status, 201);
  await waitFor(async () => (await bob.get(`/api/videos/${draft.data.video.id}`)).data.video.status === 'ready', { what: 'the draft to process' });
  await uploadReady(bob, { title: 'Just for me', visibility: 'private' });
  await quiet();
  assert.equal(sent('/bob-json', 'video.published').length, before, 'nothing yet');
  await bob.patch(`/api/videos/${draft.data.video.id}`, { publish: true });
  await waitFor(() => sent('/bob-json', 'video.published').length === before + 1, { what: 'the published draft' });
  assert.equal(sent('/bob-json', 'video.published').at(-1).body.video.title, 'Draft first');
});

test('a test delivery, a failing webhook, turning one off and deleting it', async () => {
  const json = (await bob.get('/api/me/webhooks')).data.webhooks[0];
  const t = await bob.post(`/api/me/webhooks/${json.id}/test`);
  assert.equal(t.data.ok, true, JSON.stringify(t.data));
  assert.equal(sent('/bob-json', 'test').at(-1).body.event, 'test');

  const failing = (await bob.post('/api/me/webhooks', { url: at('/fail'), format: 'slack' })).data.webhook;
  const f = await bob.post(`/api/me/webhooks/${failing.id}/test`);
  assert.equal(f.data.ok, false);
  assert.equal(f.data.status, 500);
  assert.match(f.data.webhook.last_error, /HTTP 500/);
  assert.match(sent('/fail', 'test').at(-1).body.text, /webhook works/);

  // Off: a new video skips it.
  await bob.patch(`/api/me/webhooks/${json.id}`, { enabled: false });
  const before = sent('/bob-json', 'video.published').length;
  await uploadReady(bob, { title: 'While it was off' });
  await quiet();
  assert.equal(sent('/bob-json', 'video.published').length, before);
  assert.equal((await bob.del(`/api/me/webhooks/${json.id}`)).status, 204);
  assert.equal((await bob.get('/api/me/webhooks')).data.webhooks.some((h) => h.id === json.id), false);
});

test("webhooks can't reach the server's own network, except an admin's", async () => {
  const strict = await startInstance('webhooks-strict', { allowPrivate: false });
  try {
    const admin = await setupAdmin(strict, 'carol');
    const user = await registerUser(strict, 'dave');
    for (const url of [at('/sneaky'), 'http://localhost:9/sneaky', 'http://[::1]:9/sneaky', 'http://169.254.169.254/latest/meta-data']) {
      const r = await user.post('/api/me/webhooks', { url });
      assert.equal(r.status, 400, `${url}: ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, /private network/);
    }
    const own = await admin.post('/api/me/webhooks', { url: at('/admin-bot') });
    assert.equal(own.status, 201, 'an admin may, for bots on their own machine');
    assert.equal((await admin.post(`/api/me/webhooks/${own.data.webhook.id}/test`)).data.ok, true);
    assert.equal(sent('/sneaky').length, 0);
  } finally {
    await strict.stop();
  }
});

test("an admin's site-wide webhook gets everyone's published videos, and only admins can make one", async () => {
  assert.equal((await bob.post('/api/me/webhooks', { url: at('/bob-site'), scope: 'site' })).status, 403);
  assert.deepEqual(Object.keys((await bob.get('/api/me/webhooks')).data.scopes), ['mine']);
  const site = await alice.post('/api/me/webhooks', { url: at('/site-json'), events: ['video.published'], scope: 'site', include_network: true });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  assert.equal(site.data.webhook.scope, 'site');
  assert.equal(site.data.webhook.include_network, true);

  await uploadReady(bob, { title: 'Bob for the whole site' });
  const forSite = () => sent('/site-json', 'video.published').filter((g) => g.body.video.title === 'Bob for the whole site');
  await waitFor(() => forSite().length === 1, { what: 'the site-wide delivery' });
  assert.equal(forSite()[0].body.video.channel.username, 'bob');
  assert.deepEqual(forSite()[0].body.video.server, { name: 'Hook Site', url: inst.url });

  // Back to only her own: the network option goes with it, and bob's next video doesn't reach it.
  const mine = await alice.patch(`/api/me/webhooks/${site.data.webhook.id}`, { scope: 'mine' });
  assert.equal(mine.data.webhook.include_network, false);
  await uploadReady(bob, { title: 'Bob, not for alice' });
  await quiet();
  assert.ok(!sent('/site-json').some((g) => g.body?.video?.title === 'Bob, not for alice'));
});
