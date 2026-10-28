// ActivityPub: discovery, actors, signatures, follows both ways, videos out and in, comments and likes
// both ways, blocking. A small PeerTube-like server (fakeTube.js) plays the other side and checks
// OurTube's HTTP signatures with its own code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';
import { PUBLIC, fakeTube } from './fakeTube.js';

let inst, admin, bob, carol, base, fake, video;

const ap = (path) => fetch(base + path, { headers: { Accept: 'application/activity+json' } }).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: await r.json().catch(() => null) }));

before(async () => {
  fake = await fakeTube();
  inst = await startInstance('ap', { env: { PEERTUBE_DIRECTORY_URL: fake.origin } });
  base = inst.url;
  admin = await setupAdmin(inst, 'alice', 'AP Test');
  await admin.patch('/api/admin/settings', { public_url: base });
  await admin.patch('/api/mod/settings', { spam_hold_first_comments: false });
  bob = await registerUser(inst, 'bob');
  carol = await registerUser(inst, 'carol');
  video = await uploadReady(bob, { title: 'Bob before anyone followed', tags: 'ace' });
});
after(async () => {
  await inst?.stop();
  fake?.server.close();
});

test('discovery: WebFinger, NodeInfo, actors and content negotiation', async () => {
  const host = new URL(base).host;
  const wf = await (await fetch(`${base}/.well-known/webfinger?resource=acct:bob@${host}`)).json();
  assert.equal(wf.links.find((l) => l.rel === 'self').href, `${base}/ap/users/bob`);
  const wfc = await (await fetch(`${base}/.well-known/webfinger?resource=acct:bob_channel@${host}`)).json();
  assert.equal(wfc.links.find((l) => l.rel === 'self').href, `${base}/ap/channels/bob`);
  assert.equal((await fetch(`${base}/.well-known/webfinger?resource=acct:nobody@${host}`)).status, 404);
  // Handles match whatever the case, and the answer carries the canonical spelling.
  const wfu = await (await fetch(`${base}/.well-known/webfinger?resource=acct:BOB_Channel@${host}`)).json();
  assert.equal(wfu.subject, `acct:bob_channel@${host}`);
  assert.equal(wfu.links.find((l) => l.rel === 'self').href, `${base}/ap/channels/bob`);

  const person = await ap('/ap/users/bob');
  assert.match(person.type, /activity\+json/);
  assert.equal(person.body.type, 'Person');
  assert.match(person.body.publicKey.publicKeyPem, /BEGIN PUBLIC KEY/);
  const group = await ap('/ap/channels/bob');
  assert.equal(group.body.type, 'Group');
  assert.equal(group.body.preferredUsername, 'bob_channel');
  assert.deepEqual(group.body.attributedTo, [{ type: 'Person', id: `${base}/ap/users/bob` }]);
  assert.equal((await ap('/ap/actor')).body.type, 'Application');

  const ni = await (await fetch(`${base}/.well-known/nodeinfo`)).json();
  const info = await (await fetch(ni.links[0].href)).json();
  assert.equal(info.software.name, 'cliptube');

  // Pasting a watch link into Mastodon or PeerTube search fetches it as ActivityPub.
  const v = await ap(`/watch/${video.id}`);
  assert.equal(v.body.type, 'Video');
  assert.match(v.body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(v.body.duration, `PT${Math.round(video.duration)}S`);
  const mp4 = v.body.url.find((u) => u.mediaType === 'video/mp4');
  assert.ok(mp4.size > 0 && mp4.height === 240);
  assert.equal(v.body.attachment[0].mediaType, 'video/mp4');
  assert.equal((await ap(`/c/bob`)).body.type, 'Person');
  const html = await (await fetch(`${base}/watch/${video.id}`)).text();
  assert.match(html, /rel="alternate" type="application\/activity\+json"/);
});

test('a fediverse channel follows an OurTube channel and gets its new uploads', async () => {
  const r = await fake.send(`${base}/ap/channels/bob/inbox`, { type: 'Follow', actor: fake.account, object: `${base}/ap/channels/bob` });
  assert.equal(r.status, 202, await r.text());
  const accept = await waitFor(() => fake.find((b) => b.type === 'Accept'), { what: 'Accept' });
  assert.equal(accept.actor, `${base}/ap/channels/bob`);
  assert.equal((await new Client(base).get('/api/users/bob')).data.channel.subscriber_count, 1);
  assert.equal((await ap('/ap/channels/bob/followers')).body.totalItems, 1);

  const fresh = await uploadReady(bob, { title: 'Bob for the fediverse', tags: 'clutch' });
  const create = await waitFor(() => fake.find((b) => b.type === 'Create' && b.object?.name === 'Bob for the fediverse'), { what: 'Create(Video)', timeout: 30000 });
  assert.equal(create.actor, `${base}/ap/users/bob`);
  assert.equal(create.object.id, `${base}/ap/videos/${fresh.id}`);
  assert.ok(create.object.to.includes(PUBLIC));
  await waitFor(() => fake.find((b) => b.type === 'Announce' && b.object === `${base}/ap/videos/${fresh.id}`), { what: 'Announce' });
  video = fresh;
});

test('comments and likes from the fediverse land on the video; replies go back', async () => {
  const noteId = `${fake.origin}/comments/1`;
  await fake.send(`${base}/ap/inbox`, {
    type: 'Create',
    actor: fake.account,
    object: { type: 'Note', id: noteId, attributedTo: fake.account, inReplyTo: `${base}/ap/videos/${video.id}`, content: '<p>Nice <b>shot</b> from the fediverse</p>', to: [PUBLIC], published: new Date().toISOString() },
  });
  const c = await waitFor(async () => (await new Client(base).get(`/api/videos/${video.id}/comments`)).data.comments.find((x) => x.body === 'Nice shot from the fediverse'), { what: 'remote comment' });
  assert.equal(c.author.username, `fakeuser@${new URL(fake.origin).host}`);
  assert.equal(c.author.remote, true);

  await fake.send(`${base}/ap/inbox`, { type: 'Like', actor: fake.account, object: `${base}/ap/videos/${video.id}` });
  await waitFor(async () => (await new Client(base).get(`/api/videos/${video.id}`)).data.video.likes === 1, { what: 'remote like' });
  await fake.send(`${base}/ap/inbox`, { type: 'Undo', actor: fake.account, object: { type: 'Like', actor: fake.account, object: `${base}/ap/videos/${video.id}` } });
  await waitFor(async () => (await new Client(base).get(`/api/videos/${video.id}`)).data.video.likes === 0, { what: 'undone like' });

  // Bob answers: the reply is delivered to the commenter, in reply to their note.
  await bob.post(`/api/videos/${video.id}/comments`, { body: 'thanks fediverse!', parent_id: c.id });
  const reply = await waitFor(() => fake.find((b) => b.type === 'Create' && b.object?.type === 'Note' && /thanks fediverse/.test(b.object.content)), { what: 'reply delivery' });
  assert.equal(reply.object.inReplyTo, noteId);
  assert.equal(reply.object.attributedTo, `${base}/ap/users/bob`);

  // A deleted note disappears.
  await fake.send(`${base}/ap/inbox`, { type: 'Delete', actor: fake.account, object: { id: noteId, type: 'Tombstone' } });
  await waitFor(async () => !(await new Client(base).get(`/api/videos/${video.id}/comments`)).data.comments.some((x) => x.body === 'Nice shot from the fediverse'), { what: 'remote delete' });
});

test('people here follow fediverse channels: backfill, new uploads, comments and likes going out', async () => {
  const host = new URL(fake.origin).host;
  const f = await carol.post('/api/fediverse/follow', { handle: `fakechan@${host}` });
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const follow = await waitFor(() => fake.find((b) => b.type === 'Follow' && b.object === fake.channel), { what: 'Follow' });
  assert.equal(follow.actor, `${base}/ap/users/carol`);
  await fake.send(`${base}/ap/users/carol/inbox`, { type: 'Accept', actor: fake.channel, object: follow }, fake.channel);
  // The outbox is imported once the follow is accepted.
  await waitFor(async () => (await carol.get('/api/videos?scope=network')).data.videos.some((v) => v.title === 'An older fake video'), { what: 'backfill' });
  assert.equal((await carol.get('/api/fediverse/follows')).data.follows[0].status, 'accepted');

  // A new upload over there: in the index, searchable, and carol hears about it.
  await fake.send(`${base}/ap/inbox`, { type: 'Create', actor: fake.account, object: fake.video('brand-new-1', 'Fresh fake speedrun') });
  const nv = await waitFor(async () => (await carol.get('/api/videos?scope=network')).data.videos.find((v) => v.title === 'Fresh fake speedrun'), { what: 'new remote video' });
  assert.match(nv.video_url, /-1080\.mp4$/);
  assert.equal(nv.remote.peer_url, fake.origin);
  assert.ok((await carol.get('/api/search?q=speedrun')).data.videos.some((v) => v.title === 'Fresh fake speedrun'));
  await waitFor(async () => (await carol.get('/api/notifications')).data.notifications.some((n) => /Fresh fake speedrun/.test(n.title)), { what: 'upload notification' });

  const { peer_id: iid, remote_id: rid } = nv.remote;
  const posted = await carol.post(`/api/network/videos/${iid}/${rid}/comments`, { body: 'hello from OurTube' });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const note = await waitFor(() => fake.find((b) => b.type === 'Create' && b.object?.type === 'Note' && /hello from OurTube/.test(b.object.content)), { what: 'outgoing note' });
  assert.equal(note.object.inReplyTo, `${fake.origin}/videos/watch/brand-new-1`);
  assert.equal((await carol.get(`/api/network/videos/${iid}/${rid}/comments`)).data.comments[0].body, 'hello from OurTube');
  assert.equal((await carol.post(`/api/network/videos/${iid}/${rid}/like`, { value: 1 })).status, 200);
  await waitFor(() => fake.find((b) => b.type === 'Like' && b.object === `${fake.origin}/videos/watch/brand-new-1`), { what: 'outgoing like' });
});

test('videos marked sensitive (NSFW) on their server stay out, and leave if marked later', async () => {
  const listed = async (title) => (await carol.get('/api/videos?scope=network')).data.videos.some((v) => v.title === title);
  await fake.send(`${base}/ap/inbox`, { type: 'Create', actor: fake.account, object: { ...fake.video('nsfw-1', 'A sensitive fake video'), sensitive: true } });
  await fake.send(`${base}/ap/inbox`, { type: 'Create', actor: fake.account, object: fake.video('sfw-1', 'A safe fake video') });
  await waitFor(() => listed('A safe fake video'), { what: 'the safe video' });
  assert.equal(await listed('A sensitive fake video'), false);
  await fake.send(`${base}/ap/inbox`, { type: 'Update', actor: fake.account, object: { ...fake.video('sfw-1', 'A safe fake video'), sensitive: true } });
  await waitFor(async () => !(await listed('A safe fake video')), { what: 'the video marked sensitive to leave' });
});

test('reports about fediverse videos go to their server as a Flag', async () => {
  const nv = (await carol.get('/api/videos?scope=network')).data.videos.find((v) => v.title === 'Fresh fake speedrun');
  const r = await carol.post('/api/reports', { target_type: 'remote_video', target_id: `${nv.remote.peer_id}:${nv.remote.remote_id}`, reason: 'spam', details: 'looks like spam' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const flag = await waitFor(() => fake.find((b) => b.type === 'Flag'), { what: 'Flag' });
  assert.equal(flag.actor, `${base}/ap/actor`, 'sent by the instance, not the person who reported');
  assert.deepEqual(flag.object, [`${fake.origin}/videos/watch/brand-new-1`]);
  assert.match(flag.content, /looks like spam/);
});

test("a PeerTube video's whole comment thread shows, from before anyone here followed too", async () => {
  const host = new URL(fake.origin).host;
  const owner = { url: fake.account, name: 'fakeuser', host, displayName: 'Fake fakeuser', avatars: [{ width: 48, fileUrl: `${fake.origin}/av/48.jpg` }, { width: 120, fileUrl: `${fake.origin}/av/120.jpg` }] };
  const pat = { url: 'https://elsewhere.example/users/pat', name: 'pat', host: 'elsewhere.example', displayName: 'Pat', avatars: [] };
  const t = Date.now();
  const c = (...a) => fake.comment('talked-about', ...a);
  const question = c(102, pat, '<p>How did you <b>skip</b> that?</p>', t - 3000);
  const answer = c(103, owner, 'A wall clip.', t - 2000);
  answer.children.push(c(104, pat, '<p><span class="h-card"><a href="https://elsewhere.example/a" class="u-url mention">@<span>fakeuser</span></a></span> nice</p>', t - 1000));
  question.children.push(answer);
  fake.threads['talked-about'] = [c(101, owner, 'First!', t - 4000), question, c(105, null, '', t - 5000, { isDeleted: true })];

  await fake.send(`${base}/ap/inbox`, { type: 'Create', actor: fake.account, object: fake.video('talked-about', 'A talked-about fake video') });
  const nv = await waitFor(async () => (await carol.get('/api/videos?scope=network')).data.videos.find((v) => v.title === 'A talked-about fake video'), { what: 'the video' });
  const path = `/api/network/videos/${nv.remote.peer_id}/${nv.remote.remote_id}/comments`;
  let cs = (await carol.get(path)).data.comments;
  const by = (body) => cs.find((x) => x.body === body);
  assert.equal(cs.length, 4, JSON.stringify(cs));
  assert.equal(by('First!').parent_id, null);
  assert.equal(by('First!').is_uploader, true);
  assert.equal(by('First!').author.avatar_url, `${fake.origin}/av/120.jpg`);
  const q = by('How did you skip that?');
  assert.equal(q.author.username, 'pat@elsewhere.example');
  assert.equal(q.author.display_name, 'Pat');
  assert.equal(by('A wall clip.').parent_id, q.id);
  assert.equal(by('@fakeuser nice').parent_id, q.id, 'a reply to a reply stays in its thread');

  // A reply from here goes to the comment it answers, and shows once PeerTube has it: once, as carol's.
  const r = await carol.post(path, { body: 'Same question', parent_id: q.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sent = await waitFor(() => fake.find((b) => b.type === 'Create' && b.object?.content?.includes('Same question')), { what: 'the reply' });
  assert.equal(sent.object.inReplyTo, `${fake.origin}/videos/watch/talked-about/comments/102`);
  cs = (await carol.get(path)).data.comments;
  const mine = cs.filter((x) => x.body === 'Same question');
  assert.equal(mine.length, 1, JSON.stringify(cs));
  assert.equal(mine[0].id, r.data.comment.id);
  assert.equal(mine[0].parent_id, q.id);
  assert.equal(mine[0].can_delete, true);

  // The server shows up among the site's peers as PeerTube (read from its NodeInfo), not as an OurTube server.
  await admin.post('/api/admin/network/sync');
  const peer = (await carol.get('/api/site')).data.network_peers.find((p) => p.url === fake.origin);
  assert.equal(peer?.software, 'peertube', JSON.stringify(peer));

  // Chapters set on PeerTube come along for the player, in order.
  const ch = await carol.get(`/api/network/videos/${nv.remote.peer_id}/${nv.remote.remote_id}/chapters`);
  assert.deepEqual(ch.data.chapters, [{ start: 0, title: 'Start' }, { start: 30, title: 'The trick' }]);
});

test('admins find PeerTube servers in the directory, with the NSFW ones left out', async () => {
  const host = new URL(fake.origin).host;
  fake.directory = [
    { host, name: 'Fake Tube', shortDescription: 'Games and more', languages: ['en'], categories: [7], defaultNSFWPolicy: 'do_not_list', isNSFW: false, totalLocalVideos: 3, avatars: [] },
    { host: 'nsfw.example', name: 'Spicy', languages: ['en'], categories: [], defaultNSFWPolicy: 'display', isNSFW: true, totalLocalVideos: 9, avatars: [] },
  ];
  assert.equal((await bob.get('/api/admin/fediverse/directory')).status, 403);
  const r = await admin.get('/api/admin/fediverse/directory?language=en&categories=7,99&search=games');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.servers.map((s) => s.host), [host]);
  assert.equal(r.data.servers[0].videos, 3);
  assert.equal(r.data.servers[0].following, null);
  // The directory is asked with the filters, NSFW servers excluded (blurring ones are fine: sensitive videos stay out here).
  const q = new URLSearchParams(fake.lastDirectoryQuery);
  assert.deepEqual(q.getAll('languagesOr[]'), ['en']);
  assert.deepEqual(q.getAll('categoriesOr[]'), ['7']);
  assert.deepEqual(q.getAll('nsfwPolicy[]'), ['do_not_list', 'blur']);
  assert.equal(q.get('search'), 'games');
  // Asked for, servers that show NSFW are listed too.
  assert.equal((await admin.get('/api/admin/fediverse/directory?nsfw=show')).data.servers.length, 2);
  assert.deepEqual(new URLSearchParams(fake.lastDirectoryQuery).getAll('nsfwPolicy[]'), []);
});

test('blocking a server shuts it out', async () => {
  await admin.post('/api/admin/network/instances/block', { url: fake.origin, reason: 'test' });
  const r = await fake.send(`${base}/ap/inbox`, { type: 'Like', actor: fake.account, object: `${base}/ap/videos/${video.id}` });
  assert.equal(r.status, 403);
  assert.ok(!(await carol.get('/api/videos?scope=network')).data.videos.some((v) => v.title === 'Fresh fake speedrun'));
});
