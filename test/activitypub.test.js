// ActivityPub: discovery, actors, signatures, follows both ways, videos out and in, comments and likes
// both ways, blocking. A small PeerTube-like server in this file plays the other side and checks
// OurTube's HTTP signatures with its own code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

const AS = 'https://www.w3.org/ns/activitystreams';
const PUBLIC = `${AS}#Public`;
let inst, admin, bob, carol, base, fake, video;

/** A tiny fediverse server: one account, one channel, an inbox that verifies signatures, an outbox. */
function fakeTube() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, F.origin);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/activity+json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/.well-known/webfinger') {
      const r = url.searchParams.get('resource');
      const name = /^acct:([^@]+)@/.exec(r)?.[1];
      const href = name === 'fakechan' ? F.channel : name === 'fakeuser' ? F.account : null;
      if (!href) return json(404, {});
      return json(200, { subject: r, links: [{ rel: 'self', type: 'application/activity+json', href }] });
    }
    if (req.method === 'GET' && url.pathname === '/video-channels/fakechan') return json(200, F.actor('Group', F.channel, 'fakechan', [F.account]));
    if (req.method === 'GET' && url.pathname === '/accounts/fakeuser') return json(200, F.actor('Person', F.account, 'fakeuser'));
    if (req.method === 'GET' && url.pathname === '/video-channels/fakechan/outbox') {
      return json(200, { '@context': AS, id: `${F.channel}/outbox`, type: 'OrderedCollection', totalItems: 1, orderedItems: [{ type: 'Create', actor: F.account, object: F.video('old-one', 'An older fake video') }] });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/videos/watch/')) return json(200, F.video(url.pathname.split('/').pop(), 'Fetched fake video'));
    if (req.method === 'POST' && url.pathname.endsWith('/inbox')) {
      try {
        const actorKey = await F.verify(req, raw);
        const body = JSON.parse(raw.toString());
        received.push({ path: url.pathname, signedBy: actorKey, body });
        res.writeHead(202).end();
      } catch (e) {
        res.writeHead(401).end(e.message);
      }
      return;
    }
    res.writeHead(404).end();
  });
  const F = {
    server,
    received,
    origin: '',
    get channel() {
      return `${F.origin}/video-channels/fakechan`;
    },
    get account() {
      return `${F.origin}/accounts/fakeuser`;
    },
    actor: (type, id, name, attributedTo) => ({
      '@context': [AS, 'https://w3id.org/security/v1'],
      type,
      id,
      preferredUsername: name,
      name: `Fake ${name}`,
      inbox: `${id}/inbox`,
      outbox: `${id}/outbox`,
      followers: `${id}/followers`,
      endpoints: { sharedInbox: `${F.origin}/inbox` },
      publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: pem },
      url: [{ type: 'Link', mediaType: 'text/html', href: `${F.origin}/c/${name}` }],
      ...(attributedTo ? { attributedTo } : {}),
    }),
    video: (uuid, name) => ({
      '@context': [AS],
      type: 'Video',
      id: `${F.origin}/videos/watch/${uuid}`,
      uuid,
      name,
      duration: 'PT42S',
      views: 3,
      sensitive: false,
      commentsEnabled: true,
      published: new Date().toISOString(),
      updated: new Date().toISOString(),
      mediaType: 'text/markdown',
      content: 'Played on the fake tube',
      tag: [{ type: 'Hashtag', name: 'speedrun' }],
      icon: [{ type: 'Image', url: `${F.origin}/thumb/${uuid}.jpg`, mediaType: 'image/jpeg', width: 1280, height: 720 }],
      url: [
        { type: 'Link', mediaType: 'text/html', href: `${F.origin}/w/${uuid}` },
        { type: 'Link', mediaType: 'video/mp4', href: `${F.origin}/media/${uuid}-720.mp4`, height: 720, size: 1000, fps: 30 },
        { type: 'Link', mediaType: 'video/mp4', href: `${F.origin}/media/${uuid}-1080.mp4`, height: 1080, size: 2000, fps: 30 },
      ],
      attributedTo: [{ type: 'Person', id: F.account }, { type: 'Group', id: F.channel }],
      to: [PUBLIC, `${F.channel}/followers`],
      cc: [`${F.account}/followers`],
    }),
    /** Checks a request from OurTube the way Mastodon does: fetch the key, check digest and signature. */
    async verify(req, raw) {
      const header = req.headers.signature || '';
      const p = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      const names = p.headers.split(' ');
      assert.ok(names.includes('(request-target)') && names.includes('digest') && names.includes('date'), header);
      assert.equal(req.headers.digest, `SHA-256=${crypto.createHash('sha256').update(raw).digest('base64')}`);
      const text = names.map((n) => (n === '(request-target)' ? `(request-target): post ${req.url}` : `${n}: ${req.headers[n]}`)).join('\n');
      const actor = await (await fetch(p.keyId.split('#')[0], { headers: { Accept: 'application/activity+json' } })).json();
      assert.equal(actor.publicKey.id, p.keyId);
      assert.ok(crypto.verify('sha256', Buffer.from(text), actor.publicKey.publicKeyPem, Buffer.from(p.signature, 'base64')), 'signature checks out');
      return p.keyId;
    },
    /** Sends a signed activity to OurTube. */
    async send(inbox, activity, keyOwner = F.account) {
      const body = JSON.stringify({ '@context': AS, id: `${F.origin}/activities/${crypto.randomUUID()}`, ...activity });
      const u = new URL(inbox);
      const headers = { host: u.host, date: new Date().toUTCString(), digest: `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`, 'content-type': 'application/activity+json' };
      const text = `(request-target): post ${u.pathname}\nhost: ${headers.host}\ndate: ${headers.date}\ndigest: ${headers.digest}\ncontent-type: ${headers['content-type']}`;
      const signature = crypto.sign('sha256', Buffer.from(text), privateKey).toString('base64');
      headers.signature = `keyId="${keyOwner}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest content-type",signature="${signature}"`;
      return fetch(inbox, { method: 'POST', headers, body });
    },
    find: (pred) => received.find((r) => pred(r.body))?.body,
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    F.origin = `http://127.0.0.1:${server.address().port}`;
    resolve(F);
  }));
}

const ap = (path) => fetch(base + path, { headers: { Accept: 'application/activity+json' } }).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: await r.json().catch(() => null) }));

before(async () => {
  fake = await fakeTube();
  inst = await startInstance('ap');
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

test('blocking a server shuts it out', async () => {
  await admin.post('/api/admin/network/instances/block', { url: fake.origin, reason: 'test' });
  const r = await fake.send(`${base}/ap/inbox`, { type: 'Like', actor: fake.account, object: `${base}/ap/videos/${video.id}` });
  assert.equal(r.status, 403);
  assert.ok(!(await carol.get('/api/videos?scope=network')).data.videos.some((v) => v.title === 'Fresh fake speedrun'));
});
