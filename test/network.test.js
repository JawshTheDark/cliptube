// Hub network between real instances: joining, syncing, cross-instance interactions and moderation.
// Since protocol 4 the instances talk ActivityPub to each other, so answers arrive within moments
// rather than in the same request: the tests wait for them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
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

test("a site-wide webhook also hears of the network's new videos, not of what was already there", async () => {
  const got = [];
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      got.push(JSON.parse(raw));
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const hook = await A.post('/api/me/webhooks', { url, events: ['video.published'], scope: 'site', include_network: true });
    assert.equal(hook.status, 201, JSON.stringify(hook.data));
    const fresh = await uploadReady(B, { title: 'Bob, new on the member' });
    const arrived = await waitFor(
      async () => {
        await A.post('/api/admin/network/sync');
        return got.find((e) => e.video?.title === 'Bob, new on the member');
      },
      { what: "the member's new video at the hub's webhook" },
    );
    assert.equal(arrived.video.from_network, true);
    assert.equal(arrived.video.server.name, 'Member B');
    assert.equal(arrived.video.server.url, member.url);
    assert.ok(arrived.video.url.startsWith(`${hub.url}/n/`), arrived.video.url);
    assert.match(arrived.video.channel.username, /^bob/);
    assert.ok(!got.some((e) => e.video?.title === 'Bob on the member'), 'videos from before the webhook are not replayed');
    await A.del(`/api/me/webhooks/${hook.data.webhook.id}`);
    // The tests after this one expect bob's first video to be the only one from the member.
    await B.del(`/api/videos/${fresh.id}`);
    await waitFor(
      async () => {
        await A.post('/api/admin/network/sync');
        return !(await net(A)).some((v) => v.title === 'Bob, new on the member');
      },
      { what: 'the deleted video to leave the hub' },
    );
  } finally {
    receiver.close();
  }
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

test("a member's new name reaches the hub at its next sync", async () => {
  const onHub = async () => (await A.get('/api/admin/network')).data.hub.members.find((m) => m.url === member.url)?.name;
  assert.equal(await onHub(), 'Member B');
  await B.patch('/api/admin/settings', { site_name: 'Bob’s Clips' });
  await B.post('/api/admin/network/sync');
  assert.equal(await onHub(), 'Bob’s Clips');
  // Its clips on the hub say where they're from under the new name.
  assert.ok((await net(A)).every((v) => v.remote.peer_name === 'Bob’s Clips'), JSON.stringify((await net(A)).map((v) => v.remote)));
  await B.patch('/api/admin/settings', { site_name: 'Member B' });
  await B.post('/api/admin/network/sync');
  assert.equal(await onHub(), 'Member B');
});

test("Sync now on the hub reads each member's name at its own address", async () => {
  const onHub = async () => (await A.get('/api/admin/network')).data.hub.members.find((m) => m.url === member.url)?.name;
  // As if the member had been renamed while running a version that doesn't say so itself.
  const hubDb = new DatabaseSync(path.join(hub.dataDir, 'cliptube.db'));
  hubDb.prepare("UPDATE instances SET name = 'Its old name' WHERE url = ?").run(member.url);
  hubDb.close();
  assert.equal(await onHub(), 'Its old name');
  await A.post('/api/admin/network/sync');
  assert.equal(await onHub(), 'Member B');
});

test("the hub's directory gives members its current name, not the one it was set up with", async () => {
  // Members read the directory on every sync, and its own name in it used to be the one from setup, so a
  // renamed hub showed its old name again until the hourly check of its address.
  const memberDb = new DatabaseSync(path.join(member.dataDir, 'cliptube.db'));
  const token = memberDb.prepare("SELECT value FROM settings WHERE key = 'network_hub_token'").get().value;
  memberDb.close();
  const hubIn = async () =>
    (await (await fetch(`${hub.url}/api/hub/directory`, { headers: { Authorization: `Bearer ${token}` } })).json()).instances.find((i) => i.is_hub);
  await A.patch('/api/admin/settings', { site_name: 'Hub A, renamed' });
  assert.equal((await hubIn()).name, 'Hub A, renamed');
  await A.patch('/api/admin/settings', { site_name: 'Hub A' });
  assert.equal((await hubIn()).name, 'Hub A');
});

test("a channel's new picture and name reach its videos on other servers, older ones included", async () => {
  const avatar = path.join(os.tmpdir(), 'ourtube-test-avatar.jpg');
  if (!fs.existsSync(avatar)) execFileSync(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=96x96', '-frames:v', '1', avatar]);
  const bobOnHub = async () => (await net(A)).find((v) => v.title === 'Bob on the member')?.uploader;
  assert.equal((await bobOnHub()).avatar_url, null);

  // The member sends the change to the servers it peers with.
  const form = new FormData();
  form.append('avatar', new Blob([fs.readFileSync(avatar)]), 'me.jpg');
  assert.equal((await B.req('POST', '/api/me/avatar', undefined, { form })).status, 200);
  await B.patch('/api/me', { display_name: 'Bob, now with a face' });
  const after = await waitFor(
    async () => {
      const u = await bobOnHub();
      return u?.avatar_url && u.display_name === 'Bob, now with a face' ? u : null;
    },
    { what: "bob's new picture and name on the hub" },
  );
  assert.ok(after.avatar_url.startsWith(`${member.url}/media/avatars/`), after.avatar_url);

  // A server that doesn't send its changes (an older version): Sync now on the hub reads the channel again.
  const hubDb = new DatabaseSync(path.join(hub.dataDir, 'cliptube.db'));
  hubDb.prepare("UPDATE network_videos SET uploader_avatar_url = NULL, uploader_display_name = 'stale' WHERE ap_actor IS NOT NULL").run();
  hubDb.close();
  assert.equal((await bobOnHub()).display_name, 'stale');
  await A.post('/api/admin/network/sync');
  const fresh = await bobOnHub();
  assert.equal(fresh.display_name, 'Bob, now with a face');
  assert.equal(fresh.avatar_url, after.avatar_url);

  await B.patch('/api/me', { display_name: 'bob' });
  await waitFor(async () => (await bobOnHub()).display_name === 'bob', { what: "bob's name back on the hub" });
});

test("a clip from another server shared from here gets a link preview", { skip: !fs.existsSync(path.join(import.meta.dirname, '..', 'web', 'dist', 'index.html')) && 'the web app is not built' }, async () => {
  const item = (await net(A)).find((v) => v.title === 'Bob on the member');
  const html = await (await fetch(`${hub.url}/n/${item.remote.peer_id}/${encodeURIComponent(item.remote.remote_id)}`)).text();
  const meta = (p) => new RegExp(`<meta property="${p}" content="([^"]*)"`).exec(html)?.[1];
  assert.equal(meta('og:title'), 'Bob on the member');
  assert.equal(meta('og:site_name'), 'Hub A');
  assert.equal(meta('og:description'), 'bob on Member B');
  assert.ok(meta('og:image')?.startsWith(member.url), meta('og:image'));
  assert.ok(meta('og:video')?.startsWith(`${member.url}/media/videos/`), meta('og:video'));
  assert.match(html, /<title>Bob on the member - Hub A<\/title>/);
  // Nothing for a clip that isn't there.
  assert.equal(/og:title/.test(await (await fetch(`${hub.url}/n/${item.remote.peer_id}/nope`)).text()), false);
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

test("a game a member made before the hub had it becomes the hub's", async () => {
  // B files a clip under its own Umamusume (short name "uma"), then the hub adds the same game.
  assert.equal((await B.post('/api/games', { name: 'Umamusume: Pretty Derby', short_name: 'uma' })).status, 201);
  await B.patch(`/api/videos/${bVideo.id}`, { game: 'uma' });
  assert.equal((await A.post('/api/games', { name: 'Umamusume: Pretty Derby' })).status, 201);
  await B.post('/api/admin/network/sync');
  const games = (await B.get('/api/games')).data.games;
  assert.ok(!games.some((g) => g.id === 'uma'), 'the copy is gone');
  assert.equal(games.find((g) => g.id === 'umamusume-pretty-derby')?.from_hub, true);
  assert.equal((await B.get(`/api/videos/${bVideo.id}`)).data.video.game?.id, 'umamusume-pretty-derby');
  // The clip goes out again under the hub's id, so the hub files it with its own Umamusume clips.
  await waitFor(async () => {
    await A.post('/api/admin/network/sync');
    return (await net(A)).find((v) => v.title === 'Bob on the member')?.game?.id === 'umamusume-pretty-derby';
  }, { what: "the hub to get the clip's new game" });
  // And a second one by the same name isn't made again.
  const again = await B.post('/api/games', { name: 'Umamusume - Pretty Derby' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already in the list/);
});

test('games merged on the hub merge on members, and members merge their own', async () => {
  await A.post('/api/games', { name: 'Apex' });
  await A.post('/api/games', { name: 'Apex Legends' });
  await B.post('/api/admin/network/sync');
  await B.patch(`/api/videos/${bVideo.id}`, { game: 'apex' });
  const merged = await A.post('/api/games/apex/merge', { into: 'apex-legends' });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.ok(merged.data.game.aliases.includes('apex'), 'the old id lives on as an alias');
  assert.equal((await A.get('/api/games/apex')).status, 200, 'and still finds the game');
  await B.post('/api/admin/network/sync');
  assert.ok(!(await B.get('/api/games')).data.games.some((g) => g.id === 'apex'));
  assert.equal((await B.get(`/api/videos/${bVideo.id}`)).data.video.game?.id, 'apex-legends');
  // The hub's games are merged on the hub, not here.
  assert.equal((await B.post('/api/games/apex-legends/merge', { into: 'rust' })).status, 403);

  // A member's own games merge here.
  await B.post('/api/games', { name: 'Testgame One' });
  await B.post('/api/games', { name: 'Testgame Two' });
  await B.patch(`/api/videos/${bVideo.id}`, { game: 'testgame-one' });
  assert.equal((await B.post('/api/games/testgame-one/merge', { into: 'testgame-one' })).status, 400);
  assert.equal((await B.post('/api/games/testgame-one/merge', { into: 'nope' })).status, 404);
  const own = await B.post('/api/games/testgame-one/merge', { into: 'testgame-two' });
  assert.equal(own.status, 200);
  assert.equal((await B.get(`/api/videos/${bVideo.id}`)).data.video.game?.id, 'testgame-two');
  assert.ok(!(await B.get('/api/games')).data.games.some((g) => g.id === 'testgame-one'));
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
