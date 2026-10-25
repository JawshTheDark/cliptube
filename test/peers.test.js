// Hub-optional network (protocol v4, over ActivityPub): instances find each other through any one of them,
// follow each other's instance actors, follow each other's block lists, and keep working when the hub goes
// away. Follows and their answers take a moment, so the tests wait for them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, setupAdmin, uploadReady, waitFor } from './helpers.js';

let hub, b, c, A, B, C;
const titles = async (client) => (await client.get('/api/videos?scope=network')).data.videos.map((v) => v.title).sort();
const sync = (client) => client.post('/api/admin/network/sync');
const state = async (client) => (await client.get('/api/admin/network')).data;
const peer = async (client, url) => (await state(client)).peers.find((p) => p.url === url);
/** Runs network rounds until `check` holds. */
const settle = (clients, check, what) =>
  waitFor(
    async () => {
      for (const x of clients) await sync(x);
      return check();
    },
    { timeout: 45000, interval: 500, what },
  );

before(async () => {
  [hub, b, c] = await Promise.all([startInstance('p-hub'), startInstance('p-b'), startInstance('p-c')]);
  [A, B, C] = await Promise.all([setupAdmin(hub, 'alice', 'Hub A'), setupAdmin(b, 'bob', 'Peer B'), setupAdmin(c, 'carol', 'Peer C')]);
  for (const [x, inst] of [[A, hub], [B, b], [C, c]]) await x.patch('/api/admin/settings', { public_url: inst.url });
  await Promise.all([uploadReady(A, { title: 'from A' }), uploadReady(B, { title: 'from B' }), uploadReady(C, { title: 'from C' })]);
});
after(async () => {
  await Promise.all([hub?.stop(), b?.stop(), c?.stop()]);
});

test('instances find each other through any one of them and follow each other directly', async () => {
  assert.equal((await A.patch('/api/admin/network/hub', { enabled: true })).status, 200);
  const jb = await B.post('/api/admin/network/join', { url: hub.url });
  assert.equal(jb.status, 200, JSON.stringify(jb.data));
  // C joins through B, which is not a hub, and learns about A from B's peer list.
  const jc = await C.post('/api/admin/network/join', { url: b.url });
  assert.equal(jc.status, 200, JSON.stringify(jc.data));
  const want = { A: ['from B', 'from C'], B: ['from A', 'from C'], C: ['from A', 'from B'] };
  await settle([A, B, C], async () => {
    const [a2, b2, c2] = await Promise.all([titles(A), titles(B), titles(C)]);
    return JSON.stringify([a2, b2, c2]) === JSON.stringify([want.A, want.B, want.C]);
  }, 'all three to see each other');

  const aOnC = await peer(C, hub.url);
  assert.equal(aOnC.direct, true, JSON.stringify(aOnC));
  assert.equal(aOnC.source, 'peer');
  assert.equal(aOnC.transport, 'activitypub');
  assert.equal((await peer(A, c.url)).direct, true);
  assert.equal((await peer(B, c.url)).direct, true);
  assert.equal((await state(C)).protocol, 4);
});

test('the old v3 feed still refuses strangers and forged signatures', async () => {
  const r = await fetch(`${b.url}/api/network/feed`, { headers: { 'X-ClipTube-Instance': c.url, 'X-ClipTube-Date': String(Date.now()), 'X-ClipTube-Signature': 'AAAA' } });
  assert.equal(r.status, 401);
  const stranger = await fetch(`${b.url}/api/network/feed`, { headers: { 'X-ClipTube-Instance': 'https://stranger.example', 'X-ClipTube-Date': String(Date.now()), 'X-ClipTube-Signature': 'AAAA' } });
  assert.equal(stranger.status, 403);
});

test('admission switches: approval and lockdown apply to direct peers too', async () => {
  const d = await startInstance('p-d');
  try {
    const D = await setupAdmin(d, 'dave', 'Peer D');
    await D.patch('/api/admin/settings', { public_url: d.url });
    await B.patch('/api/admin/network/admission', { require_approval: true });
    // D asks B; B holds the request for its admin.
    assert.equal((await D.post('/api/admin/network/join', { url: b.url })).status, 200);
    const waiting = await waitFor(async () => {
      const p = await peer(B, d.url);
      return p?.peer_status === 'pending' ? p : null;
    }, { what: 'the request to wait on B' });
    assert.equal((await peer(D, b.url)).remote_status, 'pending');
    assert.equal((await B.patch(`/api/admin/network/peers/${waiting.id}`, { status: 'approved' })).status, 200);
    assert.equal((await peer(B, d.url)).peer_status, 'approved');
    await waitFor(async () => (await peer(D, b.url))?.remote_status === 'approved', { what: 'D to hear it was accepted' });
    await B.patch('/api/admin/network/admission', { require_approval: false, accept_new: false });
    const e = await startInstance('p-e');
    try {
      const E = await setupAdmin(e, 'erin', 'Peer E');
      await E.patch('/api/admin/settings', { public_url: e.url });
      const refused = await E.post('/api/admin/network/join', { url: b.url });
      assert.equal(refused.status, 403, JSON.stringify(refused.data));
      assert.match(refused.data.error, /not accepting/);
    } finally {
      await e.stop();
    }
    await B.patch('/api/admin/network/admission', { accept_new: true });
  } finally {
    await d.stop();
  }
});

test('shared block lists: the hub publishes blocks, members follow them, review mode waits', async () => {
  // A (the hub) blocks C. B follows the hub's list automatically, so C disappears on B too.
  const cOnA = (await state(A)).peers.find((p) => p.url === c.url);
  await A.patch(`/api/admin/network/instances/${cOnA.id}`, { blocked: true, reason: 'spam' });
  const list = await (await fetch(`${hub.url}/api/network/blocklist`)).json();
  assert.deepEqual(list.instances.map((i) => i.url), [c.url]);
  await sync(B);
  const blockedOnB = (await state(B)).instances.find((i) => i.url === c.url);
  assert.equal(blockedOnB.blocked, true);
  assert.equal(blockedOnB.block_source, hub.url);
  assert.deepEqual(await titles(B), ['from A']);
  // Taking the block back undoes it on B as well.
  await A.patch(`/api/admin/network/instances/${cOnA.id}`, { blocked: false });
  await settle([B], async () => (await state(B)).instances.find((i) => i.url === c.url) === undefined && JSON.stringify(await titles(B)) === JSON.stringify(['from A', 'from C']), 'C back on B');

  // C follows B's list in review mode: new entries wait until C's admin applies them.
  await B.post('/api/admin/network/instances/block', { url: 'https://bad.example', reason: 'scam' });
  const sub = await C.post('/api/admin/network/blocklists', { url: b.url, mode: 'review' });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const entry = sub.data.blocklists.find((x) => x.url === b.url);
  assert.deepEqual(entry.pending.map((e) => e.target), ['https://bad.example']);
  await C.patch(`/api/admin/network/blocklists/${entry.id}`, { entry: { kind: 'instance', target: 'https://bad.example', status: 'applied' } });
  assert.equal((await state(C)).instances.find((i) => i.url === 'https://bad.example').blocked, true);
});

test('with the hub gone, peers keep syncing, liking and commenting', async () => {
  await hub.stop();
  const fresh = await uploadReady(C, { title: 'after the hub' });
  // C's new clip reaches B over ActivityPub right away, without waiting for a round.
  await waitFor(async () => (await titles(B)).includes('after the hub'), { timeout: 25000, what: 'the clip to reach B' });

  const cOnB = await peer(B, c.url);
  const like = await B.post(`/api/network/videos/${cOnB.id}/${fresh.id}/like`, { value: 1 });
  assert.equal(like.status, 200, JSON.stringify(like.data));
  await waitFor(async () => (await C.get(`/api/videos/${fresh.id}`)).data.video.likes === 1, { what: 'the like on C' });
  const cm = await B.post(`/api/network/videos/${cOnB.id}/${fresh.id}/comments`, { body: 'still here' });
  assert.equal(cm.status, 201, JSON.stringify(cm.data));
  await waitFor(async () => (await C.get(`/api/videos/${fresh.id}/comments`)).data.comments[0]?.body === 'still here', { what: 'the comment on C' });

  await sync(B); // the hub is unreachable; the round carries on with the peers
  assert.ok((await titles(B)).includes('after the hub'));
  assert.equal((await B.get('/api/site')).data.federation, true);
  const s = await state(B);
  assert.ok(s.member.last_error, 'the failed hub sync is reported');
});
