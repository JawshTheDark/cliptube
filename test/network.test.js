// Hub network between real instances: joining, syncing, cross-instance interactions and moderation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  await A.post('/api/admin/network/sync');
  await B.post('/api/admin/network/sync');
  assert.deepEqual((await net(A)).map((v) => v.title), ['Bob on the member']);
  assert.deepEqual((await net(B)).map((v) => v.title), ['Alice on the hub']);
});

test('likes, comments and subscriptions across instances', async () => {
  const remoteA = (await net(B))[0];
  const iidOnB = remoteA.remote.peer_id;
  const like = (await B.post(`/api/network/videos/${iidOnB}/${aVideo.id}/like`, { value: 1 })).data;
  assert.equal(like.likes, 1);
  assert.equal((await A.get(`/api/videos/${aVideo.id}`)).data.video.likes, 1);

  const sent = (await B.post(`/api/network/videos/${iidOnB}/${aVideo.id}/comments`, { body: 'from the member' })).data;
  const posted = sent.comment;
  assert.ok(posted.id);
  // A first comment from someone new is held on the hosting instance until its owner approves it.
  assert.equal(sent.held, true);
  assert.equal((await new Client(hub.url).get(`/api/videos/${aVideo.id}/comments`)).data.comments.length, 0);
  assert.equal((await A.patch(`/api/videos/${aVideo.id}/comments/${posted.id}`, { status: 'visible' })).status, 200);
  const onHub = (await A.get(`/api/videos/${aVideo.id}/comments`)).data.comments;
  assert.equal(onHub[0].author.remote, true);
  assert.match(onHub[0].author.username, /^bob@127\.0\.0\.1:/);
  const onB = (await B.get(`/api/network/videos/${iidOnB}/${aVideo.id}/comments`)).data.comments;
  assert.equal(onB[0].can_delete, true);

  const iidOnA = (await net(A))[0].remote.peer_id;
  const sub = (await A.post(`/api/network/channels/${iidOnA}/bob/subscribe`)).data;
  assert.equal(sub.subscribed, true);
  assert.equal((await B.get('/api/users/bob')).data.channel.subscriber_count, 1);
  assert.deepEqual((await A.get('/api/me/feed')).data.videos.map((v) => v.title), ['Bob on the member']);

  assert.equal((await B.del(`/api/network/videos/${iidOnB}/${aVideo.id}/comments/${posted.id}`)).status, 200);
  assert.equal((await A.get(`/api/videos/${aVideo.id}/comments`)).data.comments.length, 0);
});

test('forged inbox requests are refused', async () => {
  const r = await fetch(`${hub.url}/api/network/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ClipTube-Signature': 'AAAA' },
    body: JSON.stringify({ type: 'like', instance: member.url, ts: Date.now(), nonce: 'n1', actor: { username: 'bob' }, video_id: aVideo.id, value: 1 }),
  });
  assert.equal(r.status, 401);
});

test('reports about remote videos reach the instance that hosts them', async () => {
  const iidOnB = (await net(B))[0].remote.peer_id;
  const r = await B.post('/api/reports', { target_type: 'remote_video', target_id: `${iidOnB}:${aVideo.id}`, reason: 'copyright', details: 'not theirs' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const onA = await waitFor(async () => (await A.get('/api/mod/reports')).data.reports.find((x) => x.target_id === aVideo.id), { what: 'forwarded report' });
  assert.equal(onA.reason, 'copyright');
  assert.match(onA.reporter, /^bob@/);
  assert.ok(onA.from_instance);
  assert.equal((await B.get('/api/mod/reports')).data.reports[0].target_type, 'remote_video');

  // Acting on it there takes the video off the whole network, and restoring brings it back.
  assert.equal((await A.post(`/api/mod/reports/${onA.id}/action`, { action: 'remove_video', reason: 'copyright' })).status, 200);
  await B.post('/api/admin/network/sync');
  assert.equal((await net(B)).length, 0);
  await A.post(`/api/mod/videos/${aVideo.id}`, { action: 'restore' });
  await B.post('/api/admin/network/sync');
  assert.equal((await net(B)).length, 1);
});

test('games travel with videos across the network', async () => {
  assert.equal((await A.post('/api/games', { name: 'Counter-Strike 2', short_name: 'CS2' })).status, 201);
  await A.patch(`/api/videos/${aVideo.id}`, { game: 'cs2' });
  await B.post('/api/admin/network/sync');
  const item = (await net(B))[0];
  assert.deepEqual(item.game, { id: 'cs2', name: 'Counter-Strike 2' });
  assert.ok(item.tags.includes('cs2'), item.tags.join());
  // B doesn't list the game itself but can still browse it...
  const page = (await B.get('/api/games/cs2')).data.game;
  assert.equal(page.remote_only, true);
  assert.equal(page.network_count, 1);
  // ...and once B adds it under another id, an alias ties the two together.
  await B.post('/api/games', { name: 'CS2 (Valve)', short_name: 'counter-strike', aliases: 'cs2' });
  const byGame = (await B.get('/api/videos?scope=all&game=counter-strike')).data.videos;
  assert.deepEqual(byGame.map((v) => v.title), ['Alice on the hub']);
});

test('blocking, network switches and hub moderation', async () => {
  const iidOnB = (await net(B))[0].remote.peer_id;
  const iidOnA = (await net(A))[0].remote.peer_id;

  await B.patch(`/api/admin/network/instances/${iidOnB}`, { blocked: true, reason: 'test' });
  const refused = await A.post(`/api/network/videos/${iidOnA}/${bVideo.id}/comments`, { body: 'nope' });
  assert.equal(refused.status, 403);
  assert.equal((await net(B)).length, 0);
  await B.patch(`/api/admin/network/instances/${iidOnB}`, { blocked: false });

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
  assert.equal((await net(A)).length, 0);
  await A.patch(`/api/admin/network/videos/${iidOnA}/${bVideo.id}`, { hidden: false });
});

test('lockdown, approval and bans apply to new instances', async () => {
  const third = await startInstance('third');
  try {
    const C = await setupAdmin(third, 'carol', 'Third C');
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
