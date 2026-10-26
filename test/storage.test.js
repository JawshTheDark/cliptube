// A storage limit for the whole server, on top of each person's quota: uploads, in one request or in pieces,
// stop when the server's data folder would go over it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, setupAdmin, registerUser, testClip } from './helpers.js';

let inst, alice, bob;

before(async () => {
  inst = await startInstance('storage');
  alice = await setupAdmin(inst, 'alice');
  bob = await registerUser(inst, 'bob');
});
after(async () => {
  await inst?.stop();
});

test('uploads stop at the storage limit for the whole server, and go again without it', async () => {
  assert.equal((await alice.patch('/api/admin/settings', { storage_limit_gb: -1 })).status, 400);
  assert.equal((await bob.patch('/api/admin/settings', { storage_limit_gb: 1 })).status, 403);

  // 1 MB: a fresh server's data folder is already bigger than that.
  assert.equal((await alice.patch('/api/admin/settings', { storage_limit_gb: 0.001 })).data.settings.storage_limit_gb, '0.001');
  const stats = (await alice.get('/api/admin/stats')).data;
  assert.equal(stats.storage.limit, 1024 ** 3 * 0.001);
  assert.ok(stats.storage.used > stats.storage.limit);

  const refused = await bob.upload(testClip('h264'), { title: 'Too much' });
  assert.equal(refused.status, 413, JSON.stringify(refused.data));
  assert.match(refused.data.error, /storage limit/);
  const pieces = await bob.post('/api/uploads', { kind: 'video', name: 'big.mp4', size: 1000 });
  assert.equal(pieces.status, 413);

  await alice.patch('/api/admin/settings', { storage_limit_gb: 0 });
  assert.equal((await bob.upload(testClip('h264'), { title: 'Room again' })).status, 201);
});
