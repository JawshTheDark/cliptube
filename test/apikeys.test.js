// API keys: each person makes their own for uploaders like ShareX. A key can only upload; its defaults
// (visibility, publish or keep as a draft) fill in what an upload leaves out, and the answer has the link.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client, startInstance, setupAdmin, registerUser, testClip, waitFor } from './helpers.js';

let inst, alice, bob;

before(async () => {
  inst = await startInstance('apikeys');
  alice = await setupAdmin(inst, 'alice');
  bob = await registerUser(inst, 'bob');
});
after(async () => {
  await inst?.stop();
});

/** An upload the way ShareX sends one: a single multipart request with the key in a header. */
async function keyUpload(key, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([fs.readFileSync(testClip('h264'))]), 'ShareX_Recording_2026.mp4');
  const r = await fetch(`${inst.url}/api/videos`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  return { status: r.status, data: await r.json() };
}
const withKey = (key, p, init = {}) => fetch(`${inst.url}${p}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` } });
const ready = (id) =>
  waitFor(
    async () => {
      const v = (await bob.get(`/api/videos/${id}`)).data.video;
      return v.status === 'ready' ? v : null;
    },
    { timeout: 60000, what: `video ${id} to process` },
  );

test('a key is made in Settings, shown once, and listed by its first characters', async () => {
  assert.equal((await new Client(inst.url).post('/api/me/api-keys', { name: 'x' })).status, 401);
  assert.equal((await bob.post('/api/me/api-keys', { visibility: 'everyone' })).status, 400);
  const made = await bob.post('/api/me/api-keys', { name: 'ShareX on my PC' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match(made.data.key, /^ot_[A-Za-z0-9_-]{40}$/);
  assert.equal(made.data.api_key.visibility, 'unlisted');
  assert.equal(made.data.api_key.publish, true);
  const list = (await bob.get('/api/me/api-keys')).data;
  assert.deepEqual(list.keys.map((k) => k.prefix), [made.data.key.slice(0, 10)]);
  assert.equal(JSON.stringify(list).includes(made.data.key), false, 'the key is never shown again');
  assert.equal(list.upload_url, `${inst.url}/api/videos`);
  // Each person sees and changes only their own.
  assert.deepEqual((await alice.get('/api/me/api-keys')).data.keys, []);
  assert.equal((await alice.del(`/api/me/api-keys/${made.data.api_key.id}`)).status, 404);
});

test("an upload with a key uses the key's defaults and answers with the link", async () => {
  const { key } = (await bob.post('/api/me/api-keys', { name: 'uploader' })).data;
  const r = await keyUpload(key);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.url, `${inst.url}/watch/${r.data.video.id}`);
  assert.equal(r.data.video.title, 'ShareX Recording 2026');
  const v = await ready(r.data.video.id);
  assert.equal(v.uploader.username, 'bob');
  assert.equal(v.visibility, 'unlisted');
  assert.equal(v.draft, false);

  // What the upload says wins over the key's defaults.
  const mine = await keyUpload(key, { title: 'Only for me', visibility: 'private' });
  assert.equal(mine.status, 201);
  assert.equal((await ready(mine.data.video.id)).visibility, 'private');

  // A key set to keep drafts: published once its details are saved, as the key's visibility.
  const drafts = (await bob.post('/api/me/api-keys', { name: 'drafts', visibility: 'public', publish: false })).data;
  const d = await keyUpload(drafts.key);
  const dv = await ready(d.data.video.id);
  assert.equal(dv.draft, true);
  assert.equal(dv.draft_visibility, 'public');
});

test('a key can only upload, and stops working once deleted', async () => {
  const made = (await bob.post('/api/me/api-keys', { name: 'limited' })).data;
  assert.equal((await withKey(made.key, '/api/me/webhooks')).status, 403);
  assert.equal((await withKey(made.key, '/api/me/api-keys', { method: 'POST' })).status, 403);
  assert.equal((await withKey(made.key, '/api/videos')).status, 403, 'not even reading');
  // Big files can still go up in pieces.
  const piece = await withKey(made.key, '/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'video', name: 'big.mp4', size: 1000 }),
  });
  assert.equal(piece.status, 201);
  assert.ok((await bob.get('/api/me/api-keys')).data.keys.find((k) => k.id === made.api_key.id).last_used_at, 'the list shows when a key was last used');

  assert.equal((await bob.del(`/api/me/api-keys/${made.api_key.id}`)).status, 204);
  assert.equal((await keyUpload(made.key)).status, 401);
  assert.equal((await keyUpload(`ot_${'x'.repeat(40)}`)).status, 401);
});
