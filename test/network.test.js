// Hub network between real instances: joining, syncing, cross-instance interactions and moderation.
// Since protocol 4 the instances talk ActivityPub to each other, so answers arrive within moments
// rather than in the same request: the tests wait for them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startInstance, Client, setupAdmin, uploadReady, waitFor } from './helpers.js';

let hub;
let member;
let A; // hub admin client
let B; // member admin client
let aVideo;
let bVideo;

const net = (c) => c.get('/api/videos?scope=network').then((r) => r.data.videos);

before(async () => {
  [hub, member] = await Promise.all([startInstance('hub'), startInstance('member')]);
  [A, B] = await Promise.all([setupAdmin(hub, 'alice', 'Hub A'), setupAdmin(member, 'bob', 'Member B')]);
  for (const [c, inst] of [[A, hub], [B, member]]) await c.patch('/api/admin/settings', { public_url: inst.url });
  [aVideo, bVideo] = await Promise.all([uploadReady(A, { title: 'Alice on the hub', tags: 'valorant' }), uploadReady(B, { title: 'Bob on the member', tags: 'rust' })]);
});
after(async () => {
  await Promise.all([hub?.stop(), member?.stop()]);
});

test('hub mode, open joining and two-way sync', async () => {
  const h = (await A.patch('/api/admin/network/hub', { enabled: true })).data;
  assert.equal(h.role, 'hub');
  assert.equal(h.hub.settings.require_approval, false);
  const j = (await B.post('/api/admin/network/join', { hub_url: hub.url })).data;
  assert.equal(j.member.status, 'approved', JSON.stringify(j));
  await waitFor(async () => {
    await A.post('/api/admin/network/sync');
    await B.post('/api/admin/network/sync');
    return (await net(A)).length === 1 && (await net(B)).length === 1;
  }, { what: 'both instances to see each other' });
  assert.deepEqual((await net(A)).map((v) => v.title), ['Bob on the member']);
  assert.deepEqual((await net(B)).map((v) => v.title), ['Alice on the hub']);
  // They peer over ActivityPub.
  const peers = (await B.get('/api/admin/network')).data.peers;
  assert.equal(peers.find((p) => p.url === hub.url)?.transport, 'activitypub', JSON.stringify(peers));
});

test("the hub shows each member's current version, not the one it joined with", async () => {
  const version = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
  const shown = async () => (await A.get('/api/admin/network')).data.hub.members.find((m) => m.url === member.url)?.version;
  assert.equal(await shown(), version);
  // As if the member had joined on an old version and been updated since.
  const hubDb = new DatabaseSync(path.join(hub.dataDir, 'cliptube.db'));
  hubDb.prepare("UPDATE instances SET version = '1.3.0' WHERE url = ?").run(member.url);
  hubDb.close();
  assert.equal(await shown(), '1.3.0');
  await B.post('/api/admin/network/sync');
  assert.equal(await shown(), version);
});

test('likes, comments and subscriptions across instances', async () => {
  const remoteA = (await net(B))[0];
  const iidOnB = remoteA.remote.peer_id;
  const like = (await B.post(`/api/network/videos/${iidOnB}/${aVideo.id}/like`, { value: 1 })).data;
  assert.equal(like.likes, 1);
  await waitFor(async () => (await A.get(`/api/videos/${aVideo.id}`)).data.video.likes === 1, { what: 'the like on the hub' });

  const sent = (await B.post(`/api/network/videos/${iidOnB}/${aVideo.id}/comments`, { body: 'from the member' })).data;
  // It waits for the hosting instance's answer; a first comment from someone new is held there.
  assert.equal(sent.pending, true);
  const held = await waitFor(async () => (await A.get(`/api/videos/${aVideo.id}/comments`)).data.comments.find((c) => c.body === 'from the member'), { what: 'the held comment on the hub' });
  assert.equal(held.status, 'held');
  assert.equal((await new Client(hub.url).get(`/api/videos/${aVideo.id}/comments`)).data.comments.length, 0);
  assert.equal((await B.get(`/api/network/videos/${iidOnB}/${aVideo.id}/comments`)).data.comments[0].status, 'pending');
  assert.equal((await A.patch(`/api/videos/${aVideo.id}/comments/${held.id}`, { status: 'visible' })).status, 200);
  const onHub = (await A.get(`/api/videos/${aVideo.id}/comments`)).data.comments;
  assert.equal(onHub[0].author.remote, true);
  assert.match(onHub[0].author.username, /^bob@127\.0\.0\.1:/);
  // The approval goes back to the member, and its page shows the hub's whole thread.
  const onB = await waitFor(async () => {
    const c = (await B.get(`/api/network/videos/${iidOnB}/${aVideo.id}/comments`)).data.comments[0];
    return c?.status === 'visible' ? c : null;
  }, { what: 'the comment to be accepted' });
  assert.equal(onB.can_delete, true);
  assert.equal(onB.author.username, 'bob', 'people from here show up as themselves in the thread');

  const remoteB = (await net(A))[0];
  const sub = (await A.post(`/api/network/channels/${remoteB.remote.peer_id}/${remoteB.uploader.username}/subscribe`)).data;
  assert.equal(sub.subscribed, true);
  await waitFor(async () => (await B.get('/api/users/bob')).data.channel.subscriber_count === 1, { what: 'the subscription on the member' });
  assert.deepEqual((await A.get('/api/me/feed')).data.videos.map((v) => v.title), ['Bob on the member']);

  assert.equal((await B.del(`/api/network/videos/${iidOnB}/${aVideo.id}/comments/${onB.id}`)).status, 200);
  await waitFor(async () => (await A.get(`/api/videos/${aVideo.id}/comments`)).data.comments.length === 0, { what: 'the deletion on the hub' });
});

test('a new upload notifies subscribers on another instance', async () => {
  // Alice on the hub subscribed to bob on the member in the test above.
  const fresh = await uploadReady(B, { title: 'Bob posts again' });
  const n = await waitFor(async () => (await A.get('/api/notifications')).data.notifications.find((x) => x.kind === 'upload' && /Bob posts again/.test(x.title)), {
    timeout: 60000,
    what: 'the remote upload notification',
  });
  assert.match(n.url, /^\/n\/\d+\//);
  assert.ok(n.url.endsWith(`/${fresh.id}`), n.url);
});

test('forged requests are refused', async () => {
  // The old signed inbox, and an ActivityPub delivery without a valid signature.
  const r = await fetch(`${hub.url}/api/network/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ClipTube-Signature': 'AAAA' },
    body: JSON.stringify({ type: 'like', instance: member.url, ts: Date.now(), nonce: 'n1', actor: { username: 'bob' }, video_id: aVideo.id, value: 1 }),
  });
  assert.equal(r.status, 401);
  const ap = await fetch(`${hub.url}/ap/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/activity+json', Signature: `keyId="${member.url}/ap/users/bob#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="AAAA"`, Date: new Date().toUTCString() },
    body: JSON.stringify({ type: 'Like', actor: `${member.url}/ap/users/bob`, object: `${hub.url}/ap/videos/${aVideo.id}` }),
  });
  assert.equal(ap.status, 401);
});

test('reports about remote videos reach the instance that hosts them', async () => {
  const iidOnB = (await net(B))[0].remote.peer_id;
  const r = await B.post('/api/reports', { target_type: 'remote_video', target_id: `${iidOnB}:${aVideo.id}`, reason: 'copyright', details: 'not theirs' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const onA = await waitFor(async () => (await A.get('/api/mod/reports')).data.reports.find((x) => x.target_id === aVideo.id), { what: 'forwarded report' });
  assert.equal(onA.reason, 'copyright');
  // Reports travel as ActivityPub Flags from the instance, without the reporter's name.
  assert.match(onA.reporter, /\(network\)$/);
  assert.ok(onA.from_instance);
  assert.equal((await B.get('/api/mod/reports')).data.reports[0].target_type, 'remote_video');

  // Acting on it there takes the video off the whole network, and restoring brings it back.
  assert.equal((await A.post(`/api/mod/reports/${onA.id}/action`, { action: 'remove_video', reason: 'copyright' })).status, 200);
  await waitFor(async () => {
    await B.post('/api/admin/network/sync');
    return (await net(B)).length === 0;
  }, { what: 'the removal on the member' });
  await A.post(`/api/mod/videos/${aVideo.id}`, { action: 'restore' });
  await waitFor(async () => {
    await B.post('/api/admin/network/sync');
    return (await net(B)).length === 1;
  }, { what: 'the video back on the member' });
});

test("games travel with videos, and the hub's game catalog syncs to members", async () => {
  assert.equal((await A.post('/api/games', { name: 'Counter-Strike 2', short_name: 'CS2' })).status, 201);
  await A.patch(`/api/videos/${aVideo.id}`, { game: 'cs2' });
  const item = await waitFor(async () => {
    await B.post('/api/admin/network/sync');
    const it = (await net(B))[0];
    return it?.game ? it : null;
  }, { what: 'the game on the member' });
  assert.deepEqual(item.game, { id: 'cs2', name: 'Counter-Strike 2' });
  assert.ok(item.tags.includes('cs2'), item.tags.join());

  // B never added the game: it comes with the hub's catalog, which B can use but not change.
  const onB = (await B.get('/api/games')).data;
  const g = onB.games.find((x) => x.id === 'cs2');
  assert.equal(g?.from_hub, true, JSON.stringify(onB.games));
  assert.equal(onB.catalog.hub_url, hub.url);
  assert.equal(g.network_count, 1);
  assert.equal((await B.patch('/api/games/cs2', { name: 'Renamed' })).status, 403);
  await B.patch(`/api/videos/${bVideo.id}`, { game: 'cs2' });
  assert.equal((await B.get(`/api/videos/${bVideo.id}`)).data.video.game?.id, 'cs2');

  // The hub deletes the game: it leaves B's catalog too, and the clips keep going without it.
  assert.equal((await A.del('/api/games/cs2')).status, 200);
  await B.post('/api/admin/network/sync');
  assert.ok(!(await B.get('/api/games')).data.games.some((x) => x.id === 'cs2'));
  assert.equal((await B.get(`/api/videos/${bVideo.id}`)).data.video.game, null);
  // Games B adds itself stay B's own.
  assert.equal((await B.post('/api/games', { name: 'Rust' })).status, 201);
  await B.post('/api/admin/network/sync');
  assert.ok((await B.get('/api/games')).data.games.some((x) => x.id === 'rust' && !x.from_hub));
});

test('blocking, network switches and hub moderation', async () => {
  const iidOnB = (await net(B))[0].remote.peer_id;
  const iidOnA = (await net(A))[0].remote.peer_id;

  // B blocks A: A's comments are refused there (A hears so from the refused delivery), and A's videos vanish on B.
  await B.patch(`/api/admin/network/instances/${iidOnB}`, { blocked: true, reason: 'test' });
  const tried = await A.post(`/api/network/videos/${iidOnA}/${bVideo.id}/comments`, { body: 'nope' });
  assert.equal(tried.status, 201);
  const refused = await waitFor(async () => (await A.get(`/api/network/videos/${iidOnA}/${bVideo.id}/comments`)).data.comments.find((c) => c.body === 'nope' && c.status === 'rejected'), {
    what: 'the refusal to come back',
  });
  assert.match(refused.status_reason, /refused/);
  assert.ok(!(await B.get(`/api/videos/${bVideo.id}/comments`)).data.comments.some((c) => c.body === 'nope'));
  assert.equal((await net(B)).length, 0);
  await B.patch(`/api/admin/network/instances/${iidOnB}`, { blocked: false });

  // The hub turns comments off between instances: members refuse to send them.
  await A.patch('/api/admin/network/hub', { allow_comments: false });
  await B.post('/api/admin/network/sync');
  const off = await B.post(`/api/network/videos/${iidOnB}/${aVideo.id}/comments`, { body: 'nope' });
  assert.equal(off.status, 403);
  await A.patch('/api/admin/network/hub', { allow_comments: true });

  const mid = (await A.get('/api/admin/network')).data.hub.members[0].id;
  await A.patch(`/api/admin/network/hub/members/${mid}`, { status: 'suspended', note: 'cool off' });
  assert.equal((await net(A)).length, 0);
  const s = (await B.post('/api/admin/network/sync')).data.member;
  assert.equal(s.status, 'suspended');
  await A.patch(`/api/admin/network/hub/members/${mid}`, { status: 'approved' });
  const back = await waitFor(async () => {
    const m = (await B.post('/api/admin/network/sync')).data.member;
    return m.status === 'approved' && m.video_count === 1 ? m : null;
  });
  assert.equal(back.video_count, 1);

  await A.patch(`/api/admin/network/videos/${iidOnA}/${bVideo.id}`, { hidden: true });
  assert.ok(!(await net(A)).some((v) => v.remote.remote_id === bVideo.id));
  await A.patch(`/api/admin/network/videos/${iidOnA}/${bVideo.id}`, { hidden: false });
});

test('lockdown, approval and bans apply to new instances', async () => {
  const third = await startInstance('third');
  try {
    const C = await setupAdmin(third, 'carol', 'Third C');
    await C.patch('/api/admin/settings', { public_url: third.url });
    await A.patch('/api/admin/network/hub', { accept_new: false });
    const locked = await C.post('/api/admin/network/join', { hub_url: hub.url });
    assert.equal(locked.status, 400);
    assert.match(locked.data.error, /not accepting new instances/);

    await A.patch('/api/admin/network/hub', { accept_new: true, require_approval: true });
    assert.equal((await C.post('/api/admin/network/join', { hub_url: hub.url })).data.member.status, 'pending');
    const cid = (await A.get('/api/admin/network')).data.hub.members.find((m) => m.url === third.url).id;
    await A.patch(`/api/admin/network/hub/members/${cid}`, { status: 'approved' });
    assert.equal((await C.post('/api/admin/network/sync')).data.member.status, 'approved');

    await A.patch(`/api/admin/network/hub/members/${cid}`, { status: 'banned', note: 'spam' });
    const banned = await C.post('/api/admin/network/join', { hub_url: hub.url });
    assert.match(banned.data.error, /banned from the network: spam/);
  } finally {
    await A.patch('/api/admin/network/hub', { require_approval: false });
    await third.stop();
  }
});

test('placeholder accounts for remote people cannot log in', async () => {
  const r = await new Client(hub.url).post('/api/auth/login', { username: `bob@${new URL(member.url).host}`, password: '!' });
  assert.equal(r.status, 401);
  const users = (await A.get('/api/admin/users')).data.users.map((u) => u.username);
  assert.deepEqual(users, ['alice']);
});
