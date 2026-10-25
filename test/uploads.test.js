// Uploads in pieces: a big file goes up as several PUTs (for proxies that cap a request's size, like Cloudflare)
// and carries on where it stopped after a dropped connection; the finished upload then becomes a video or a
// channel import. Unfinished uploads are swept after a while.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client, startInstance, setupAdmin, registerUser, testClip, waitFor } from './helpers.js';

let inst, alice, bob;

before(async () => {
  inst = await startInstance('uploads');
  alice = await setupAdmin(inst, 'alice');
  bob = await registerUser(inst, 'bob');
});
after(async () => {
  await inst?.stop();
});

/** PUTs raw bytes at an offset, the way an uploader sends a piece. */
async function put(client, id, offset, body, headers = {}) {
  const res = await fetch(`${inst.url}/api/uploads/${id}`, {
    method: 'PUT',
    headers: { Cookie: client.cookie, 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), ...headers },
    body,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const partFile = (id) => path.join(inst.dataDir, 'uploads', `${id}.part`);

test('a video goes up in pieces, carries on after a dropped connection, and becomes a video', async () => {
  const bytes = fs.readFileSync(testClip('h264'));
  const start = await alice.post('/api/uploads', { name: 'In pieces.mp4', size: bytes.length, fingerprint: 'f1' });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const up = start.data.upload;
  assert.equal(up.offset, 0);
  assert.ok(up.chunk_size > 1048576 && up.chunk_size < 100_000_000, 'pieces fit under a 100 MB cap');
  assert.ok((await alice.get('/api/uploads')).data.uploads.some((u) => u.id === up.id && u.fingerprint === 'f1'));

  const third = Math.floor(bytes.length / 3);
  assert.equal((await put(alice, up.id, 0, bytes.subarray(0, third))).data.upload.offset, third);
  // A piece that would leave a gap is refused with where the upload stands.
  const gap = await put(alice, up.id, third + 10, bytes.subarray(third + 10, third + 20));
  assert.equal(gap.status, 409);
  assert.equal(gap.data.upload.offset, third);
  // One sent again, overlapping what arrived, only adds what is new.
  const again = await put(alice, up.id, 0, bytes.subarray(0, third));
  assert.equal(again.status, 200);
  assert.equal(again.data.upload.offset, third);
  const overlap = await put(alice, up.id, third - 1000, bytes.subarray(third - 1000, third + 5000));
  assert.equal(overlap.data.upload.offset, third + 5000);
  const empty = await put(alice, up.id, third + 5000, bytes.subarray(third + 5000, third + 5000));
  assert.equal(empty.data.upload.offset, third + 5000, 'an empty piece is fine too');

  // The connection drops partway through a piece: what arrived is kept.
  const at = third + 5000;
  const ctl = new AbortController();
  const slow = new ReadableStream({
    start(c) {
      c.enqueue(bytes.subarray(at, at + 20_000));
      setTimeout(() => ctl.abort(), 400);
    },
  });
  await fetch(`${inst.url}/api/uploads/${up.id}`, {
    method: 'PUT',
    headers: { Cookie: alice.cookie, 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(at) },
    body: slow,
    duplex: 'half',
    signal: ctl.signal,
  }).catch(() => {});
  await waitFor(async () => (await alice.get(`/api/uploads/${up.id}`)).data.upload.offset === at + 20_000, { what: 'the partial piece to be kept' });
  // The uploader can't know how much of it arrived and sends the whole piece and the rest again.
  const rest = await put(alice, up.id, at, bytes.subarray(at));
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  assert.equal(rest.data.upload.offset, bytes.length);
  assert.equal((await put(alice, up.id, bytes.length, Buffer.from('x'))).status, 413, 'nothing past the end');

  const made = await alice.post('/api/videos', { upload_id: up.id, title: 'Sent in pieces', draft: true });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.video.title, 'Sent in pieces');
  const v = await waitFor(
    async () => {
      const r = (await alice.get(`/api/videos/${made.data.video.id}`)).data.video;
      return r.status === 'ready' ? r : null;
    },
    { timeout: 60_000, what: 'the video to process' },
  );
  assert.ok(v.duration > 3, 'the whole file arrived in order');
  assert.equal(v.draft, true);
  assert.equal((await alice.get(`/api/uploads/${up.id}`)).status, 404, 'the upload is used up');
  assert.equal(fs.existsSync(partFile(up.id)), false);
});

test('a new piece takes over from one that stalled without a word', async () => {
  const up = (await alice.post('/api/uploads', { name: 'stalled.mp4', size: 100_000 })).data.upload;
  const stalled = fetch(`${inst.url}/api/uploads/${up.id}`, {
    method: 'PUT',
    headers: { Cookie: alice.cookie, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(30_000)); // and then nothing, like a connection a proxy keeps open
      },
    }),
    duplex: 'half',
  }).catch((e) => e);
  await waitFor(async () => (await alice.get(`/api/uploads/${up.id}`)).data.upload.offset === 30_000, { what: 'the first bytes' });
  const t0 = Date.now();
  const r = await put(alice, up.id, 30_000, Buffer.alloc(70_000, 2));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.upload.offset, 100_000);
  assert.ok(Date.now() - t0 < 5000, 'without waiting for the stalled connection to time out');
  await stalled;
  assert.equal((await alice.del(`/api/uploads/${up.id}`)).status, 204);
});

test('refusals: file type, size, quota, other people, unfinished, wrong kind, too many', async () => {
  assert.equal((await alice.post('/api/uploads', { name: 'notes.txt', size: 10 })).status, 400);
  assert.equal((await alice.post('/api/uploads', { name: 'x.mp4', size: 0 })).status, 400);
  assert.equal((await alice.post('/api/uploads', { kind: 'other', name: 'x.mp4', size: 10 })).status, 400);
  await alice.patch('/api/admin/settings', { max_upload_mb: 1 });
  const big = await alice.post('/api/uploads', { name: 'big.mp4', size: 2 * 1048576 });
  assert.equal(big.status, 413);
  assert.match(big.data.error, /1 MB upload limit/);
  await alice.patch('/api/admin/settings', { max_upload_mb: 8192 });

  // Unfinished uploads count against the quota already.
  const bobId = (await alice.get('/api/admin/users')).data.users.find((u) => u.username === 'bob').id;
  await alice.patch(`/api/admin/users/${bobId}`, { quota_mb: 3 });
  const first = await bob.post('/api/uploads', { name: 'a.mp4', size: 2 * 1048576 });
  assert.equal(first.status, 201);
  const second = await bob.post('/api/uploads', { name: 'b.mp4', size: 2 * 1048576 });
  assert.equal(second.status, 413);
  assert.match(second.data.error, /quota/);
  await alice.patch(`/api/admin/users/${bobId}`, { quota_mb: 0 });

  // Someone else's upload doesn't exist as far as alice is concerned.
  const id = first.data.upload.id;
  assert.equal((await alice.get(`/api/uploads/${id}`)).status, 404);
  assert.equal((await put(alice, id, 0, Buffer.alloc(10))).status, 404);
  assert.equal((await alice.del(`/api/uploads/${id}`)).status, 404);
  assert.equal((await alice.post('/api/videos', { upload_id: id })).status, 404);

  // An unfinished upload can't become a video, and a video can't be imported as a channel archive.
  assert.equal((await put(bob, id, 0, Buffer.alloc(1000, 1))).status, 200);
  const early = await bob.post('/api/videos', { upload_id: id });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /1000 of 2097152 bytes/);
  assert.equal((await bob.post('/api/me/channel-imports', { upload_id: id })).status, 400);
  assert.equal((await put(bob, id, 1000, JSON.stringify({ a: 1 }), { 'Content-Type': 'application/json' })).status, 415);

  // Giving up deletes what arrived.
  assert.equal(fs.existsSync(partFile(id)), true);
  assert.equal((await bob.del(`/api/uploads/${id}`)).status, 204);
  assert.equal(fs.existsSync(partFile(id)), false);
  assert.equal((await bob.get(`/api/uploads/${id}`)).status, 404);

  // At most ten unfinished uploads each.
  const made = [];
  for (let i = 0; i < 10; i++) made.push((await bob.post('/api/uploads', { name: `${i}.mp4`, size: 100 })).data.upload.id);
  assert.equal((await bob.post('/api/uploads', { name: 'eleventh.mp4', size: 100 })).status, 429);
  for (const m of made) await bob.del(`/api/uploads/${m}`);
});

test('a channel archive goes up in pieces and starts an import', async () => {
  const tar = Buffer.alloc(3000, 0);
  const up = (await alice.post('/api/uploads', { kind: 'archive', name: 'cliptube-channel-old.tar', size: tar.length })).data.upload;
  assert.equal((await alice.post('/api/uploads', { kind: 'archive', name: 'channel.zip', size: 10 })).status, 400);
  await put(alice, up.id, 0, tar.subarray(0, 1000));
  await put(alice, up.id, 1000, tar.subarray(1000));
  assert.equal((await alice.post('/api/videos', { upload_id: up.id })).status, 400, 'an archive is not a video');
  const im = await alice.post('/api/me/channel-imports', { upload_id: up.id, apply_profile: false });
  assert.equal(im.status, 202, JSON.stringify(im.data));
  assert.equal((await alice.get(`/api/uploads/${up.id}`)).status, 404, 'the import took the file');
  // The archive is empty, so the import itself fails; what matters here is that it got the file.
  const done = await waitFor(
    async () => {
      const r = (await alice.get('/api/me/channel-imports')).data.imports.find((x) => x.id === im.data.import.id);
      return r && !['queued', 'downloading', 'working'].includes(r.status) ? r : null;
    },
    { what: 'the import to finish' },
  );
  assert.equal(done.status, 'failed');
});

test('unfinished uploads are swept after a while', async () => {
  const quick = await startInstance('uploads-sweep', { env: { UPLOAD_STALE_MS: '1500', UPLOAD_SWEEP_MS: '300' } });
  try {
    const c = await setupAdmin(quick, 'carol');
    const up = (await c.post('/api/uploads', { name: 'left.mp4', size: 5000 })).data.upload;
    const res = await fetch(`${quick.url}/api/uploads/${up.id}`, {
      method: 'PUT',
      headers: { Cookie: c.cookie, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' },
      body: Buffer.alloc(100),
    });
    assert.equal(res.status, 200);
    await waitFor(async () => (await c.get(`/api/uploads/${up.id}`)).status === 404, { what: 'the sweep' });
    assert.equal(fs.existsSync(path.join(quick.dataDir, 'uploads', `${up.id}.part`)), false);
  } finally {
    await quick.stop();
  }
});

test('the single-request upload still works', async () => {
  const r = await new Client(inst.url).upload(testClip('h264'), { title: 'anonymous' });
  assert.equal(r.status, 401);
  const ok = await alice.upload(testClip('h264'), { title: 'One request' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});
