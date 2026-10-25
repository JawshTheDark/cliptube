// Outgoing webhooks: admins point them at bots, bridges or chat channels; a published video (and a public live
// stream) goes out to each, signed when there is a secret, in the webhook's format. A small server stands in for
// the other end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startInstance, setupAdmin, registerUser, testClip, uploadReady, waitFor } from './helpers.js';

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

test('admins set up webhooks, with checks', async () => {
  assert.equal((await bob.get('/api/admin/webhooks')).status, 403);
  assert.equal((await alice.post('/api/admin/webhooks', { url: 'ftp://example.com/hook' })).status, 400);
  assert.equal((await alice.post('/api/admin/webhooks', { url: at('/json'), events: ['nope'] })).status, 400);
  assert.equal((await alice.post('/api/admin/webhooks', { url: at('/json'), format: 'xml' })).status, 400);
  const json = await alice.post('/api/admin/webhooks', { url: at('/json'), format: 'json', events: ['video.published'], secret: 's3cret' });
  assert.equal(json.status, 201, JSON.stringify(json.data));
  assert.equal(json.data.webhook.has_secret, true);
  assert.equal(json.data.webhook.secret, undefined, 'the secret is never shown again');
  const discord = await alice.post('/api/admin/webhooks', { url: at('/discord'), format: 'discord', events: ['video.published', 'live.started'] });
  assert.equal(discord.status, 201);
  const list = (await alice.get('/api/admin/webhooks')).data;
  assert.equal(list.webhooks.length, 2);
  assert.ok(list.events['video.published'] && list.formats.slack);
});

test('a published video goes out to each webhook once, signed where there is a secret', async () => {
  const v = await uploadReady(alice, { title: 'Hooked on clips', tags: 'ace' });
  await waitFor(() => sent('/json', 'video.published').length === 1 && sent('/discord', 'video.published').length === 1, { what: 'both deliveries' });
  const j = sent('/json', 'video.published')[0];
  assert.equal(j.headers['x-cliptube-signature'], `sha256=${crypto.createHmac('sha256', 's3cret').update(j.raw).digest('hex')}`);
  assert.match(j.headers['user-agent'], /^ClipTube\//);
  assert.equal(j.body.event, 'video.published');
  assert.equal(j.body.site.name, 'Hook Site');
  assert.equal(j.body.video.title, 'Hooked on clips');
  assert.equal(j.body.video.url, `${inst.url}/watch/${v.id}`);
  assert.deepEqual(j.body.video.tags, ['ace']);
  assert.equal(j.body.video.channel.username, 'alice');
  assert.ok(j.body.video.thumbnail_url?.startsWith(`${inst.url}/media/thumbs/`));
  const d = sent('/discord', 'video.published')[0];
  assert.equal(d.headers['x-cliptube-signature'], undefined);
  assert.equal(d.body.username, 'Hook Site');
  assert.match(d.body.content, /alice posted a new video: Hooked on clips/);
  assert.ok(d.body.content.includes(`${inst.url}/watch/${v.id}`));
  // Saving the details again doesn't send it twice.
  await alice.patch(`/api/videos/${v.id}`, { title: 'Hooked on clips (edited)' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sent('/json', 'video.published').length, 1);
});

test('drafts and private videos go out only once they are public', async () => {
  const before = sent('/json', 'video.published').length;
  const draft = await alice.upload(testClip('h264'), { title: 'Draft first', visibility: 'public', draft: 'true' });
  assert.equal(draft.status, 201);
  await waitFor(async () => (await alice.get(`/api/videos/${draft.data.video.id}`)).data.video.status === 'ready', { what: 'the draft to process' });
  await uploadReady(alice, { title: 'Just for me', visibility: 'private' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sent('/json', 'video.published').length, before, 'nothing yet');
  await alice.patch(`/api/videos/${draft.data.video.id}`, { publish: true });
  await waitFor(() => sent('/json', 'video.published').length === before + 1, { what: 'the published draft' });
  assert.equal(sent('/json', 'video.published').at(-1).body.video.title, 'Draft first');
});

test('a test delivery, a failing webhook, turning one off and deleting it', async () => {
  const hooks = (await alice.get('/api/admin/webhooks')).data.webhooks;
  const json = hooks.find((h) => h.url.endsWith('/json'));
  const t = await alice.post(`/api/admin/webhooks/${json.id}/test`);
  assert.equal(t.data.ok, true, JSON.stringify(t.data));
  assert.equal(sent('/json', 'test').at(-1).body.event, 'test');

  const failing = (await alice.post('/api/admin/webhooks', { url: at('/fail'), format: 'slack' })).data.webhook;
  const f = await alice.post(`/api/admin/webhooks/${failing.id}/test`);
  assert.equal(f.data.ok, false);
  assert.equal(f.data.status, 500);
  assert.match(f.data.webhook.last_error, /HTTP 500/);
  assert.equal(sent('/fail', 'test').at(-1).body.username, 'Hook Site');
  assert.match(sent('/fail', 'test').at(-1).body.text, /webhook works/);

  // Off: a new video skips it.
  await alice.patch(`/api/admin/webhooks/${json.id}`, { enabled: false });
  const before = sent('/json', 'video.published').length;
  await uploadReady(alice, { title: 'While it was off' });
  await waitFor(() => sent('/discord', 'video.published').some((g) => g.body.content.includes('While it was off')), { what: 'the other webhook' });
  assert.equal(sent('/json', 'video.published').length, before);
  assert.equal((await alice.del(`/api/admin/webhooks/${json.id}`)).status, 204);
  assert.equal((await alice.get('/api/admin/webhooks')).data.webhooks.some((h) => h.id === json.id), false);
});
