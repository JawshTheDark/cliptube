// Playlists: your own lists of videos from this site and the network, Watch later, who can see them, order,
// videos that go away, channel listings and feeds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startInstance, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

const net = (c) => c.get('/api/videos?scope=network').then((r) => r.data.videos);
let hub, member, A, B, bob, anon, pub, unlisted, priv, extra, onB;

before(async () => {
  [hub, member] = await Promise.all([startInstance('pl-hub'), startInstance('pl-member')]);
  [A, B] = await Promise.all([setupAdmin(hub, 'alice', 'Hub'), setupAdmin(member, 'bea', 'Member')]);
  for (const [c, inst] of [[A, hub], [B, member]]) await c.patch('/api/admin/settings', { public_url: inst.url });
  bob = await registerUser(hub, 'bob');
  anon = new Client(hub.url);
  [pub, unlisted, priv, extra] = await Promise.all([
    uploadReady(A, { title: 'Public clip' }),
    uploadReady(A, { title: 'Unlisted clip', visibility: 'unlisted' }),
    uploadReady(A, { title: 'Private clip', visibility: 'private' }),
    uploadReady(A, { title: 'Another clip' }),
  ]);
  // The member's network index gets the hub's public clips.
  assert.equal((await A.patch('/api/admin/network/hub', { enabled: true })).status, 200);
  assert.equal((await B.post('/api/admin/network/join', { url: hub.url })).status, 200);
  onB = await waitFor(
    async () => {
      await B.post('/api/admin/network/sync');
      return (await net(B)).find((v) => v.title === 'Public clip');
    },
    { timeout: 30000, what: 'the hub clip on the member' },
  );
});
after(async () => {
  await Promise.all([hub?.stop(), member?.stop()]);
});

test('Watch later comes with every account, and a playlist holds what its owner may see', async () => {
  const mine = (await bob.get('/api/playlists/mine')).data.playlists;
  assert.equal(mine[0].kind, 'watch_later');
  assert.equal(mine[0].visibility, 'private');
  const made = await bob.post('/api/playlists', { title: 'Best of', visibility: 'public', ref: `v:${pub.id}` });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const p = made.data.playlist;
  assert.deepEqual(p.items.map((it) => it.title), ['Public clip']);
  assert.equal((await bob.post(`/api/playlists/${p.id}/items`, { ref: `v:${unlisted.id}` })).status, 201, 'unlisted videos can be saved');
  assert.equal((await bob.post(`/api/playlists/${p.id}/items`, { ref: `v:${priv.id}` })).status, 404, 'someone else\'s private video cannot');
  // Saving twice keeps one copy.
  await bob.post(`/api/playlists/${p.id}/items`, { ref: `v:${pub.id}` });
  const has = (await bob.get(`/api/playlists/mine?has=v:${pub.id}`)).data.playlists;
  assert.ok(has.find((x) => x.id === p.id).contains);
  assert.equal(has.find((x) => x.kind === 'watch_later').contains, null);
  assert.equal((await bob.get(`/api/playlists/${p.id}`)).data.playlist.item_count, 2);
  // Watch later can be renamed or deleted by nobody.
  const wl = mine[0];
  await bob.patch(`/api/playlists/${wl.id}`, { title: 'Later', visibility: 'public' });
  const wl2 = (await bob.get(`/api/playlists/${wl.id}`)).data.playlist;
  assert.equal(wl2.title, 'Watch later');
  assert.equal(wl2.visibility, 'private');
  assert.equal((await bob.del(`/api/playlists/${wl.id}`)).status, 400);
});

test('public playlists show on the channel; unlisted ones open by link; private ones only for the owner', async () => {
  const p = (await bob.post('/api/playlists', { title: 'Secret', visibility: 'private', ref: `v:${pub.id}` })).data.playlist;
  const u = (await bob.post('/api/playlists', { title: 'Link only', visibility: 'unlisted', ref: `v:${pub.id}` })).data.playlist;
  assert.equal((await anon.get(`/api/playlists/${p.id}`)).status, 404);
  assert.equal((await anon.get(`/api/playlists/${u.id}`)).status, 200);
  const listed = (await anon.get('/api/users/bob/playlists')).data.playlists.map((x) => x.title);
  assert.deepEqual(listed, ['Best of']);
  assert.ok((await bob.get('/api/users/bob/playlists')).data.playlists.length >= 3, 'the owner sees all of theirs');
  // Feeds: public and unlisted playlists have one, private ones don't.
  const feed = await fetch(`${hub.url}/feeds/playlist/${u.id}.atom`);
  assert.equal(feed.status, 200);
  assert.match(await feed.text(), /Public clip/);
  assert.equal((await fetch(`${hub.url}/feeds/playlist/${p.id}.rss`)).status, 404);
});

test('only the owner changes a playlist, and the order is theirs to set', async () => {
  const p = (await bob.post('/api/playlists', { title: 'Ordered', visibility: 'public', ref: `v:${pub.id}` })).data.playlist;
  await bob.post(`/api/playlists/${p.id}/items`, { ref: `v:${unlisted.id}` });
  await bob.post(`/api/playlists/${p.id}/items`, { ref: `v:${extra.id}` });
  const ids = (await bob.get(`/api/playlists/${p.id}`)).data.playlist.items.map((it) => it.id);
  const r = await bob.req('PUT', `/api/playlists/${p.id}/order`, { item_ids: [...ids].reverse() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.playlist.items.map((it) => it.title), ['Another clip', 'Unlisted clip', 'Public clip']);
  assert.equal((await bob.req('PUT', `/api/playlists/${p.id}/order`, { item_ids: ids.slice(1) })).status, 400);
  assert.equal((await A.patch(`/api/playlists/${p.id}`, { title: 'Mine now' })).status, 403);
  assert.equal((await A.del(`/api/playlists/${p.id}/items/${ids[0]}`)).status, 403);
  assert.equal((await bob.del(`/api/playlists/${p.id}/items/${ids[0]}`)).data.item_count, 2);
  // A deleted video leaves every playlist.
  assert.equal((await A.del(`/api/videos/${extra.id}`)).status, 200);
  assert.deepEqual((await bob.get(`/api/playlists/${p.id}`)).data.playlist.items.map((it) => it.title), ['Unlisted clip']);
});

test('videos from the network can be saved, and stay readable when they go away', async () => {
  const bea = B;
  const key = `n:${onB.remote.peer_id}:${onB.remote.remote_id}`;
  const p = (await bea.post('/api/playlists', { title: 'From the hub', visibility: 'public', ref: key })).data.playlist;
  const item = p.items[0];
  assert.equal(item.available, true);
  assert.equal(item.url, `/n/${onB.remote.peer_id}/${onB.remote.remote_id}`);
  assert.equal(item.video.remote.peer_url, hub.url);
  // Hidden from the network here: the item keeps its title but can't be played.
  assert.equal((await bea.patch(`/api/admin/network/videos/${onB.remote.peer_id}/${encodeURIComponent(onB.remote.remote_id)}`, { hidden: true })).status, 200);
  const gone = (await bea.get(`/api/playlists/${p.id}`)).data.playlist.items[0];
  assert.equal(gone.available, false);
  assert.equal(gone.title, 'Public clip');
  assert.equal((await bea.post(`/api/playlists/${p.id}/items`, { ref: 'n:999:nothing' })).status, 404);
  assert.equal((await bea.post(`/api/playlists/${p.id}/items`, { ref: 'not a ref' })).status, 400);
});
