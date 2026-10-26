// Moving a channel between instances: export, import from the export link, aliases, the move itself
// (fediverse followers get Move, subscribers here and on other OurTube instances follow along), and
// moves announced by fediverse accounts that people here follow. A small Mastodon-like server plays
// the fediverse side.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startInstance, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

const AS = 'https://www.w3.org/ns/activitystreams';
let a, b, A, B, oldMe, carol, newMe, dave, erin, fake, v1, v2;
const host = (inst) => new URL(inst.url).host;
const ap = (url) => fetch(url, { headers: { Accept: 'application/activity+json' } }).then((r) => r.json());

/** A Mastodon-like server with accounts mona, mona2 (which says it used to be mona) and nobody. */
function fakeMastodon() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const received = [];
  const F = {
    origin: '',
    received,
    aliases: { mona2: ['mona'] },
    url: (name) => `${F.origin}/users/${name}`,
    actor: (name) => ({
      '@context': [AS, 'https://w3id.org/security/v1'],
      type: 'Person',
      id: F.url(name),
      preferredUsername: name,
      name: `Mona ${name}`,
      inbox: `${F.url(name)}/inbox`,
      outbox: `${F.url(name)}/outbox`,
      followers: `${F.url(name)}/followers`,
      endpoints: { sharedInbox: `${F.origin}/inbox` },
      publicKey: { id: `${F.url(name)}#main-key`, owner: F.url(name), publicKeyPem: pem },
      url: `${F.origin}/@${name}`,
      alsoKnownAs: (F.aliases[name] || []).map((x) => (x.startsWith('http') ? x : F.url(x))),
    }),
    async send(inbox, activity, as = 'mona') {
      const body = JSON.stringify({ '@context': AS, id: `${F.origin}/activities/${crypto.randomUUID()}`, ...activity });
      const u = new URL(inbox);
      const headers = { host: u.host, date: new Date().toUTCString(), digest: `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`, 'content-type': 'application/activity+json' };
      const text = `(request-target): post ${u.pathname}\nhost: ${headers.host}\ndate: ${headers.date}\ndigest: ${headers.digest}\ncontent-type: ${headers['content-type']}`;
      const signature = crypto.sign('sha256', Buffer.from(text), privateKey).toString('base64');
      headers.signature = `keyId="${F.url(as)}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="${signature}"`;
      return fetch(inbox, { method: 'POST', headers, body });
    },
    find: (pred) => received.find((r) => pred(r.body))?.body,
  };
  F.server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, F.origin);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/activity+json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/.well-known/webfinger') {
      const name = /^acct:([^@]+)@/.exec(url.searchParams.get('resource') || '')?.[1];
      if (!['mona', 'mona2', 'nobody'].includes(name)) return json(404, {});
      return json(200, { subject: `acct:${name}@${new URL(F.origin).host}`, links: [{ rel: 'self', type: 'application/activity+json', href: F.url(name) }] });
    }
    const m = /^\/users\/(mona2?|nobody)$/.exec(url.pathname);
    if (req.method === 'GET' && m) return json(200, F.actor(m[1]));
    if (req.method === 'POST' && url.pathname.endsWith('inbox')) {
      received.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString() || '{}'), signature: req.headers.signature || '' });
      res.writeHead(202).end();
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    F.server.listen(0, '127.0.0.1', () => {
      F.origin = `http://127.0.0.1:${F.server.address().port}`;
      resolve(F);
    }),
  );
}

before(async () => {
  fake = await fakeMastodon();
  [a, b] = await Promise.all([startInstance('t-old'), startInstance('t-new')]);
  [A, B] = await Promise.all([setupAdmin(a, 'alice', 'Old Home'), setupAdmin(b, 'bea', 'New Home')]);
  for (const [admin, inst] of [[A, a], [B, b]]) {
    await admin.patch('/api/admin/settings', { public_url: inst.url });
    await admin.patch('/api/mod/settings', { spam_hold_first_comments: false });
  }
  // The two instances peer (A is a hub, B joins it).
  assert.equal((await A.patch('/api/admin/network/hub', { enabled: true })).status, 200);
  const j = await B.post('/api/admin/network/join', { url: a.url });
  assert.equal(j.status, 200, JSON.stringify(j.data));

  oldMe = await registerUser(a, 'oldjawsh');
  carol = await registerUser(a, 'carol');
  newMe = await registerUser(b, 'newjawsh');
  dave = await registerUser(b, 'dave');
  erin = await registerUser(b, 'erin');
  const prof = await oldMe.patch('/api/me', { bio: 'Clips from the old place', support_links: [{ label: 'Tips', url: 'https://tips.example/jawsh' }] });
  assert.equal(prof.status, 200, JSON.stringify(prof.data));
  v1 = await uploadReady(oldMe, { title: 'First clutch', tags: 'clutch,ranked', description: 'The very first one' });
  v2 = await uploadReady(oldMe, { title: 'Second ace', tags: 'ace' });
  const form = new FormData();
  form.append('lang', 'en');
  form.append('label', 'English');
  form.append('file', new Blob(['WEBVTT\n\n00:00.000 --> 00:01.000\nHello there\n']), 'en.vtt');
  const cap = await oldMe.req('POST', `/api/videos/${v1.id}/captions`, undefined, { form });
  assert.equal(cap.status, 201, JSON.stringify(cap.data));
  const c1 = await carol.post(`/api/videos/${v1.id}/comments`, { body: 'What a clutch' });
  assert.equal(c1.status, 201, JSON.stringify(c1.data));
  const reply = await oldMe.post(`/api/videos/${v1.id}/comments`, { body: 'Thanks!', parent_id: c1.data.comment.id });
  assert.equal(reply.status, 201);
  await oldMe.patch(`/api/videos/${v1.id}/comments/${c1.data.comment.id}`, { pinned: true });
  await carol.post('/api/users/oldjawsh/subscribe');

  // Dave on B subscribes to the old channel through the network.
  for (const x of [A, B, A, B]) await x.post('/api/admin/network/sync');
  const nv = await waitFor(async () => (await dave.get('/api/videos?scope=network')).data.videos.find((v) => v.title === 'First clutch'), { what: 'the old channel on B' });
  const sub = await dave.post(`/api/network/channels/${nv.remote.peer_id}/${nv.uploader.username}/subscribe`);
  assert.equal(sub.status, 200, JSON.stringify(sub.data));

  // Mona on the fediverse follows the old account.
  const f = await fake.send(`${a.url}/ap/users/oldjawsh/inbox`, { type: 'Follow', actor: fake.url('mona'), object: `${a.url}/ap/users/oldjawsh` });
  assert.equal(f.status, 202);
  await waitFor(() => fake.find((x) => x.type === 'Accept'), { what: 'Accept for mona' });
});

after(async () => {
  await Promise.all([a?.stop(), b?.stop()]);
  fake?.server.close();
});

test('a channel exports to one archive and imports on another instance from its link', async () => {
  const ex = await oldMe.post('/api/me/channel-exports');
  assert.equal(ex.status, 202, JSON.stringify(ex.data));
  const ready = await waitFor(async () => (await oldMe.get('/api/me/channel-exports')).data.exports.find((x) => x.status === 'ready'), { what: 'the export' });
  assert.ok(ready.link.startsWith(`${a.url}/api/channel-exports/`), ready.link);
  assert.equal((await fetch(ready.link.replace(/token=[^&]+/, 'token=wrong'))).status, 404, 'the link needs its token');

  const im = await newMe.post('/api/me/channel-imports', { url: ready.link });
  assert.equal(im.status, 202, JSON.stringify(im.data));
  const done = await waitFor(
    async () => {
      const r = (await newMe.get('/api/me/channel-imports')).data.imports[0];
      if (r.status === 'failed') throw new Error(r.error);
      return r.status === 'done' ? r : null;
    },
    { timeout: 60000, what: 'the import' },
  );
  assert.equal(done.stats.videos, 2);
  assert.equal(done.stats.comments, 2);
  assert.equal(done.stats.subscribers, 3, 'carol here, dave from the other instance, mona from the fediverse');
  assert.equal(done.stats.fediverse_followers, 2, 'dave and mona follow over ActivityPub');

  const videos = await waitFor(
    async () => {
      const list = (await newMe.get('/api/users/newjawsh/videos')).data.videos;
      return list.length === 2 ? list : null;
    },
    { timeout: 60000, what: 'imported videos to process' },
  );
  const first = videos.find((x) => x.title === 'First clutch');
  assert.ok(first, JSON.stringify(videos.map((x) => x.title)));
  const full = (await newMe.get(`/api/videos/${first.id}`)).data.video;
  assert.deepEqual([...full.tags].sort(), ['clutch', 'ranked']);
  assert.equal(full.description, 'The very first one');
  assert.equal((await newMe.get(`/api/videos/${first.id}/captions`)).data.captions[0]?.label, 'English');

  const comments = (await newMe.get(`/api/videos/${first.id}/comments`)).data.comments;
  assert.equal(comments[0].body, 'What a clutch', 'the pinned comment stays pinned');
  assert.equal(comments[0].pinned, true);
  assert.equal(comments[0].author.username, `carol@${host(a)}`);
  assert.equal(comments[0].author.profile_url, `${a.url}/c/carol`);
  assert.equal(comments[0].author.remote, true);
  const thanks = comments.find((c) => c.body === 'Thanks!');
  assert.equal(thanks.author.username, 'newjawsh', "the owner's own replies become the new account's");
  assert.equal(thanks.parent_id, comments[0].id);

  // The profile came along, and old videos were not announced as new uploads.
  const ch = (await newMe.get('/api/users/newjawsh')).data.channel;
  assert.equal(ch.bio, 'Clips from the old place');
  assert.equal((await dave.get('/api/notifications')).data.notifications.filter((n) => n.kind === 'upload').length, 0);

  // Importing the same archive again adds nothing twice.
  await newMe.post('/api/me/channel-imports', { url: ready.link });
  const again = await waitFor(
    async () => {
      const r = (await newMe.get('/api/me/channel-imports')).data.imports[0];
      return r.status === 'done' || r.status === 'failed' ? r : null;
    },
    { timeout: 60000, what: 'the second import' },
  );
  assert.equal(again.stats?.videos, 0, JSON.stringify(again));
  assert.equal((await newMe.get('/api/users/newjawsh/videos')).data.videos.length, 2);
});

test('moving: the new account lists the old one, then the old one moves and everyone follows', async () => {
  const pw = 'oldjawsh-pass-1';
  // Without the alias, the move is refused.
  const early = await oldMe.post('/api/me/move', { handle: `newjawsh@${host(b)}`, password: pw });
  assert.equal(early.status, 400);
  assert.match(early.data.error, /old account/);

  const al = await newMe.post('/api/me/aliases', { handle: `oldjawsh@${host(a)}` });
  assert.equal(al.status, 201, JSON.stringify(al.data));
  assert.deepEqual(al.data.aliases.map((x) => x.id).sort(), [`${a.url}/ap/channels/oldjawsh`, `${a.url}/ap/users/oldjawsh`]);
  assert.deepEqual((await ap(`${b.url}/ap/users/newjawsh`)).alsoKnownAs.sort(), [`${a.url}/ap/channels/oldjawsh`, `${a.url}/ap/users/oldjawsh`]);

  assert.equal((await oldMe.post('/api/me/move', { handle: `newjawsh@${host(b)}`, password: 'wrong' })).status, 400);
  const mv = await oldMe.post('/api/me/move', { handle: `newjawsh@${host(b)}`, password: pw });
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  assert.equal(mv.data.moved.handle, `@newjawsh@${host(b)}`);
  assert.equal(mv.data.moved.group, `${b.url}/ap/channels/newjawsh`);

  // The fediverse: movedTo on the old actors, and a Move for the server of Mona, who followed.
  assert.equal((await ap(`${a.url}/ap/users/oldjawsh`)).movedTo, `${b.url}/ap/users/newjawsh`);
  assert.equal((await ap(`${a.url}/ap/channels/oldjawsh`)).movedTo, `${b.url}/ap/channels/newjawsh`);
  const move = await waitFor(() => fake.find((x) => x.type === 'Move'), { what: 'Move at the fediverse follower' });
  assert.equal(move.actor, `${a.url}/ap/users/oldjawsh`);
  assert.equal(move.object, `${a.url}/ap/users/oldjawsh`);
  assert.equal(move.target, `${b.url}/ap/users/newjawsh`);

  // Carol (on the old instance) now follows the new channel over there.
  await waitFor(async () => (await carol.get('/api/me/subscriptions')).data.channels.some((c) => /^newjawsh(_channel)?$/.test(c.username) && c.remote), { what: 'the subscription of carol to move' });
  assert.ok(!(await carol.get('/api/me/subscriptions')).data.channels.some((c) => c.username === 'oldjawsh'));
  assert.ok((await carol.get('/api/notifications')).data.notifications.some((n) => n.kind === 'move'));
  // Dave (on the new instance, subscribed through the network) is now subscribed right there.
  await waitFor(async () => (await dave.get('/api/users/newjawsh')).data.channel.subscribed, { what: 'the subscription of dave to move' });
  assert.ok(!(await dave.get('/api/me/subscriptions')).data.channels.some((c) => c.username === 'oldjawsh'));

  // The old channel says where it went and takes no new subscribers.
  const old = (await carol.get('/api/users/oldjawsh')).data.channel;
  assert.equal(old.moved.handle, `@newjawsh@${host(b)}`);
  const late = await registerUser(a, 'latecomer');
  assert.equal((await late.post('/api/users/oldjawsh/subscribe')).status, 400);

  // Undo stops pointing elsewhere.
  assert.equal((await oldMe.del('/api/me/move')).data.moved, null);
  assert.equal((await ap(`${a.url}/ap/users/oldjawsh`)).movedTo, undefined);
});

test('a fediverse account that moves takes its followers here along, if the new account agrees', async () => {
  const f = await erin.post('/api/fediverse/follow', { handle: `mona@${new URL(fake.origin).host}` });
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const follow = await waitFor(() => fake.find((x) => x.type === 'Follow' && x.object === fake.url('mona')), { what: 'Follow for mona' });
  await fake.send(`${b.url}/ap/inbox`, { type: 'Accept', actor: fake.url('mona'), object: follow });
  await waitFor(async () => (await erin.get('/api/fediverse/follows')).data.follows.find((x) => x.status === 'accepted'), { what: 'the follow to be accepted' });

  // A move to an account that does not list mona is ignored; a move to mona2, which does, is followed.
  await fake.send(`${b.url}/ap/inbox`, { type: 'Move', actor: fake.url('mona'), object: fake.url('mona'), target: fake.url('nobody') });
  await fake.send(`${b.url}/ap/inbox`, { type: 'Move', actor: fake.url('mona'), object: fake.url('mona'), target: fake.url('mona2') });
  await waitFor(() => fake.find((x) => x.type === 'Follow' && x.object === fake.url('mona2')), { what: 'Follow for mona2' });
  assert.ok(fake.find((x) => x.type === 'Undo' && x.object?.object === fake.url('mona')), 'unfollowed the old account');
  assert.ok(!fake.find((x) => x.type === 'Follow' && x.object === fake.url('nobody')));
  const follows = (await erin.get('/api/fediverse/follows')).data.follows.map((x) => x.id);
  assert.deepEqual(follows, [fake.url('mona2')]);
  assert.ok((await erin.get('/api/notifications')).data.notifications.some((n) => n.kind === 'move'));
});

test('Mastodon niceties: video attachment with a poster, profile fields, replies without the leading mention', async () => {
  const video = await ap(`${a.url}/ap/videos/${v1.id}`);
  assert.equal(video.attachment[0].mediaType, 'video/mp4');
  assert.ok(video.attachment[0].icon?.url?.includes('/media/thumbs/'), JSON.stringify(video.attachment[0]));
  const person = await ap(`${a.url}/ap/users/oldjawsh`);
  assert.equal(person.attachment[0].type, 'PropertyValue');
  assert.equal(person.attachment[0].name, 'Tips');
  assert.match(person.attachment[0].value, /href="https:\/\/tips\.example\/jawsh"/);

  const wf = await (await fetch(`${a.url}/.well-known/webfinger?resource=acct:oldjawsh@${host(a)}`)).json();
  assert.equal(wf.links.find((l) => l.rel === 'http://ostatus.org/schema/1.0/subscribe').template, `${a.url}/authorize_interaction?uri={uri}`);
  const ai = await fetch(`${a.url}/authorize_interaction?uri=${encodeURIComponent('@mona@example.social')}`, { redirect: 'manual' });
  assert.equal(ai.headers.get('location'), `/subscriptions?follow=${encodeURIComponent('@mona@example.social')}`);

  // Mastodon replies start with a mention of the person they answer.
  const note = {
    id: `${fake.origin}/notes/1`,
    type: 'Note',
    attributedTo: fake.url('mona'),
    inReplyTo: `${a.url}/ap/videos/${v2.id}`,
    content: `<p><span class="h-card"><a href="${a.url}/c/oldjawsh" class="u-url mention">@<span>oldjawsh</span></a></span> great ace</p>`,
    tag: [{ type: 'Mention', href: `${a.url}/ap/users/oldjawsh`, name: `@oldjawsh@${host(a)}` }],
    to: [`${AS}#Public`],
  };
  await fake.send(`${a.url}/ap/inbox`, { type: 'Create', actor: fake.url('mona'), object: note });
  const c = await waitFor(async () => (await oldMe.get(`/api/videos/${v2.id}/comments`)).data.comments.find((x) => x.author.username.startsWith('mona@')), { what: 'the reply' });
  assert.equal(c.body, 'great ace');
});

test('one person, one video: the same video and person reached two ways stay single', async () => {
  const rl = await uploadReady(A, { title: 'Rocket League clip', game: 'Rocket League' });
  const asAp = await ap(`${a.url}/ap/videos/${rl.id}`);
  assert.equal(asAp.game?.name, 'Rocket League');
  assert.ok(asAp.tag.some((t) => t.name === asAp.game.slug), 'the game travels as a hashtag too');

  // B knows the video through the network (the two instances peer)...
  for (const x of [A, B]) await x.post('/api/admin/network/sync');
  const titled = async () => (await dave.get('/api/videos?scope=network')).data.videos.filter((v) => v.title === 'Rocket League clip');
  await waitFor(async () => (await titled()).length === 1, { what: 'the clip on B' });
  // ...and Dave also follows the channel itself, which brings the video in again.
  const f = await dave.post('/api/fediverse/follow', { handle: `alice_channel@${host(a)}` });
  assert.equal(f.status, 201, JSON.stringify(f.data));
  await waitFor(() => b.log().includes(`imported 1 video(s) from ${a.url}/ap/channels/alice`) || b.log().includes(`video(s) from ${a.url}/ap/channels/alice`), { what: 'the ActivityPub backfill' });
  const rows = await titled();
  assert.equal(rows.length, 1, 'still one row');
  assert.equal(rows[0].origin_type, 'activitypub');
  assert.equal(rows[0].game?.name, 'Rocket League');

  // Dave comments and subscribes from the video page too: still one person on A.
  const sent = await dave.post(`/api/network/videos/${rows[0].remote.peer_id}/${rows[0].remote.remote_id}/comments`, { body: 'Nice save' });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal((await dave.post(`/api/network/channels/${rows[0].remote.peer_id}/${rows[0].uploader.username}/subscribe`)).status, 200);
  await waitFor(async () => (await A.get('/api/users/alice')).data.channel.subscriber_count >= 1, { what: 'the follow to land on A' });
  assert.equal((await A.get('/api/users/alice')).data.channel.subscriber_count, 1, 'two follows of the same channel by the same person');
  const authors = await waitFor(async () => {
    const list = (await A.get(`/api/videos/${rl.id}/comments`)).data.comments.map((c) => c.author.username.toLowerCase());
    return list.length ? list : null;
  }, { what: 'the comment on A' });
  assert.deepEqual(authors, [`dave@${host(b)}`]);
});
