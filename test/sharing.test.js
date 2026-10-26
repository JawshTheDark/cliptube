// Fediverse sharing between OurTube servers: a hub that follows a PeerTube channel passes its videos on to a
// member that takes shares. The member reads them from PeerTube itself, gets new uploads at once, never passes
// them on again, and drops them when sharing stops. Both sides opt in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, setupAdmin, waitFor } from './helpers.js';
import { fakeTube } from './fakeTube.js';

let hub, member, A, B, fake;

const net = async (c) => (await c.get('/api/videos?scope=network&limit=50')).data.videos;
const fromFake = async (c) => (await net(c)).filter((v) => v.remote?.peer_url === fake.origin).map((v) => v.title).sort();
const sync = (c) => c.post('/api/admin/network/sync');
const share = (c, body) => c.patch('/api/admin/network/member', body);
const sharedList = async (inst) => (await fetch(`${inst.url}/ap/actor/shared?page=1`, { headers: { Accept: 'application/activity+json' } })).json().catch(() => null);

before(async () => {
  fake = await fakeTube();
  [hub, member] = await Promise.all([startInstance('share-hub'), startInstance('share-member')]);
  [A, B] = await Promise.all([setupAdmin(hub, 'alice', 'Hub A'), setupAdmin(member, 'bob', 'Member B')]);
  for (const [c, inst] of [[A, hub], [B, member]]) await c.patch('/api/admin/settings', { public_url: inst.url });
  // A runs the hub and B joins; they peer over ActivityPub.
  await A.patch('/api/admin/network/hub', { enabled: true });
  assert.equal((await B.post('/api/admin/network/join', { hub_url: hub.url })).data.member.status, 'approved');
  await waitFor(
    async () => {
      await sync(A);
      await sync(B);
      return (await B.get('/api/admin/network')).data.peers.some((p) => p.url === hub.url && p.transport === 'activitypub');
    },
    { what: 'the two servers to peer' },
  );
  // Alice on A follows a PeerTube channel; it accepts and A imports its videos.
  const r = await A.post('/api/fediverse/follow', { handle: `fakechan@${new URL(fake.origin).host}` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const follow = await waitFor(() => fake.find((b) => b.type === 'Follow' && b.object === fake.channel), { what: 'the Follow' });
  await fake.send(`${hub.url}/ap/users/alice/inbox`, { type: 'Accept', actor: fake.channel, object: follow }, fake.channel);
  await waitFor(async () => (await fromFake(A)).includes('An older fake video'), { what: 'A to import the channel' });
});
after(async () => {
  await Promise.all([hub?.stop(), member?.stop()]);
  fake?.server.close();
});

test('nothing is shared until both sides opt in', async () => {
  assert.equal((await A.get('/api/admin/network')).data.member.sharing.out, false, 'off by default');
  assert.equal((await fetch(`${hub.url}/ap/actor/shared`, { headers: { Accept: 'application/activity+json' } })).status, 404);
  await share(A, { share_out: true });
  assert.deepEqual((await sharedList(hub)).orderedItems.map((i) => i.object), [`${fake.origin}/videos/watch/old-one`]);
  await sync(B);
  assert.deepEqual(await fromFake(B), [], 'B does not take shares yet');
});

test("a member that takes shares shows them, read from the video's own server", async () => {
  await share(B, { share_in: true });
  await waitFor(
    async () => {
      await sync(B);
      return (await fromFake(B)).includes('An older fake video');
    },
    { what: 'the shared video on B' },
  );
  const v = (await net(B)).find((x) => x.title === 'An older fake video');
  assert.equal(v.remote.peer_url, fake.origin, 'tagged with its own server, not the hub');
  assert.equal((await B.get('/api/admin/network')).data.member.sharing.shared_here, 1);
  // No second hop: what B took from its peers is not passed on.
  await share(B, { share_out: true });
  assert.deepEqual((await sharedList(member)).orderedItems, []);
});

test('new uploads are passed on at once', async () => {
  await fake.send(`${hub.url}/ap/inbox`, { type: 'Create', actor: fake.account, object: fake.video('fresh-share', 'Shared right away') });
  // No sync: A announces it to B, and B reads it from PeerTube.
  await waitFor(async () => (await fromFake(B)).includes('Shared right away'), { what: 'the new upload on B' });
});

test('shared videos leave when sharing stops, on either side', async () => {
  await share(B, { share_in: false });
  assert.deepEqual(await fromFake(B), [], 'turning taking off removes them at once');
  await share(B, { share_in: true });
  await waitFor(
    async () => {
      await sync(B);
      return (await fromFake(B)).length === 2;
    },
    { what: 'the shares to come back' },
  );
  // The hub stops sharing: at B's next round they go.
  await share(A, { share_out: false });
  await waitFor(
    async () => {
      await sync(B);
      return (await fromFake(B)).length === 0;
    },
    { what: 'the shares to leave B' },
  );
  assert.deepEqual(await fromFake(A), ['An older fake video', 'Shared right away'], 'the hub keeps what it follows');
});
