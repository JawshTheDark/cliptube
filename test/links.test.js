// Linked accounts: one person on several sites. A link counts only while both accounts list each other;
// verified links show on the channel, mark comments from the other account as the uploader's, bring the
// other channel's videos along and let viewers subscribe to all. A fake Mastodon account takes part by alias.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, Client, startInstance, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

const AS = 'https://www.w3.org/ns/activitystreams';
const host = (inst) => new URL(inst.url).host;
const net = (c) => c.get('/api/videos?scope=network').then((r) => r.data.videos);
const actorOf = async (url) => (await fetch(url, { headers: { Accept: 'application/activity+json' } })).json();
let a, b, A, B, vic, fake, aVideo;

/** A Mastodon-like server with one account, whose aliases (alsoKnownAs) the tests set. */
function fakeMastodon() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const F = { origin: '', aliases: [], received: [] };
  F.host = () => new URL(F.origin).host;
  F.actor = () => ({
    '@context': [AS, 'https://w3id.org/security/v1'],
    id: `${F.origin}/users/jaym`,
    type: 'Person',
    preferredUsername: 'jaym',
    name: 'Jay on Mastodon',
    inbox: `${F.origin}/users/jaym/inbox`,
    outbox: `${F.origin}/users/jaym/outbox`,
    url: `${F.origin}/@jaym`,
    alsoKnownAs: F.aliases,
    publicKey: { id: `${F.origin}/users/jaym#main-key`, owner: `${F.origin}/users/jaym`, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) },
  });
  F.server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, F.origin);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/activity+json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/.well-known/webfinger') {
      const r = url.searchParams.get('resource') || '';
      return r.startsWith('acct:jaym@') ? json(200, { subject: r, links: [{ rel: 'self', type: 'application/activity+json', href: `${F.origin}/users/jaym` }] }) : json(404, {});
    }
    if (req.method === 'GET' && url.pathname === '/users/jaym') return json(200, F.actor());
    if (req.method === 'POST' && url.pathname.endsWith('/inbox')) {
      F.received.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      return res.writeHead(202).end();
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
  [a, b] = await Promise.all([startInstance('links-a'), startInstance('links-b')]);
  // The same person runs an account called jay on both sites.
  [A, B] = await Promise.all([setupAdmin(a, 'jay', 'Site A'), setupAdmin(b, 'jay', 'Site B')]);
  for (const [admin, inst] of [[A, a], [B, b]]) {
    await admin.patch('/api/admin/settings', { public_url: inst.url });
    await admin.patch('/api/mod/settings', { spam_hold_first_comments: false });
  }
  assert.equal((await A.patch('/api/admin/network/hub', { enabled: true })).status, 200);
  const j = await B.post('/api/admin/network/join', { url: a.url });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  vic = await registerUser(a, 'vic');
  [aVideo] = await Promise.all([uploadReady(A, { title: 'Jay on A' }), uploadReady(B, { title: 'Jay on B' })]);
  await waitFor(
    async () => {
      await A.post('/api/admin/network/sync');
      await B.post('/api/admin/network/sync');
      return (await net(A)).some((v) => v.title === 'Jay on B') && (await net(B)).some((v) => v.title === 'Jay on A');
    },
    { timeout: 30000, what: 'the two sites to see each other' },
  );
});
after(async () => {
  await Promise.all([a?.stop(), b?.stop()]);
  fake?.server.close();
});

test('a link one way is only a claim: it waits, and the other site offers to link back', async () => {
  const r = await A.post('/api/me/links', { handle: `jay@${host(b)}` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.added.handle, `@jay@${host(b)}`);
  assert.equal(r.data.added.verified, false);
  assert.equal(r.data.added.channel, true);
  // It goes out in alsoKnownAs: the account and its channel.
  const aka = (await actorOf(`${a.url}/ap/users/jay`)).alsoKnownAs;
  assert.ok(aka.includes(`${b.url}/ap/users/jay`) && aka.includes(`${b.url}/ap/channels/jay`), JSON.stringify(aka));
  // Nothing shows on the channel yet.
  assert.deepEqual((await vic.get('/api/users/jay')).data.channel.linked_accounts, []);
  // B heard about it, and offers to link back.
  const s = await waitFor(async () => (await B.get('/api/me/links')).data.suggestions.find((x) => x.actor === `${a.url}/ap/users/jay`), {
    what: 'the suggestion on B',
  });
  assert.equal(s.handle, `@jay@${host(a)}`);
  // Accounts on the same site, twice the same account, and nonsense are refused.
  assert.equal((await A.post('/api/me/links', { handle: `vic@${host(a)}` })).status, 400);
  assert.equal((await A.post('/api/me/links', { handle: `jay_channel@${host(b)}` })).status, 409);
  assert.equal((await A.post('/api/me/links', { handle: 'not a handle' })).status, 400);
  assert.equal((await vic.post('/api/me/links', { handle: '' })).status, 400);
});

test('linking back verifies both sides at once', async () => {
  const r = await B.post('/api/me/links', { handle: `${a.url}/ap/users/jay` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.added.verified, true, 'A lists B already');
  assert.deepEqual(r.data.suggestions, []);
  // B's new profile reached A, which checks its side again.
  await waitFor(async () => (await A.get('/api/me/links')).data.links[0]?.verified, { what: 'the link on A to verify' });
  const onA = (await vic.get('/api/users/jay')).data.channel.linked_accounts;
  assert.deepEqual(
    onA.map((l) => [l.handle, l.host, l.channel, l.url]),
    [[`@jay@${host(b)}`, host(b), true, `${b.url}/c/jay`]],
  );
  assert.equal((await new Client(b.url).get('/api/users/jay')).data.channel.linked_accounts[0].handle, `@jay@${host(a)}`);
  // The channel page names the other account with rel="me" (when the web app is built).
  if (fs.existsSync(path.join(ROOT, 'web/dist/index.html'))) {
    const html = await (await fetch(`${a.url}/c/jay`)).text();
    assert.ok(html.includes(`<link rel="me" href="${b.url}/c/jay">`), html.slice(0, 800));
  }
});

test('comments from a linked account get the uploader mark, and skip the name check', async () => {
  const remoteA = (await net(B)).find((v) => v.title === 'Jay on A');
  const iid = remoteA.remote.peer_id;
  // Same name as the uploader: from anyone else, this would be held as an imitation.
  const sent = await B.post(`/api/network/videos/${iid}/${aVideo.id}/comments`, { body: 'me again, from B' });
  assert.ok(sent.ok, JSON.stringify(sent.data));
  await vic.post(`/api/videos/${aVideo.id}/comments`, { body: 'nice one' });
  const list = await waitFor(
    async () => {
      const cs = (await vic.get(`/api/videos/${aVideo.id}/comments`)).data.comments;
      return cs.some((c) => c.body === 'me again, from B') ? cs : null;
    },
    { what: 'the comment from B, visible on A' },
  );
  const fromB = list.find((c) => c.body === 'me again, from B');
  assert.equal(fromB.author.remote, true);
  assert.equal(fromB.status, 'visible');
  assert.equal(fromB.is_uploader, true);
  assert.equal(fromB.linked_uploader, true);
  assert.equal(list.find((c) => c.body === 'nice one').is_uploader, false);
  // Sites that read the thread see the mark too.
  const thread = await actorOf(`${a.url}/ap/videos/${aVideo.id}/comments?embed=1`);
  assert.equal(thread.orderedItems.find((n) => /me again/.test(n.content)).isUploader, true);
});

test('the channel brings the linked channel videos along, and one button subscribes to all', async () => {
  const titles = async (q) => (await vic.get(`/api/users/jay/videos${q}`)).data.videos.map((v) => v.title).sort();
  assert.deepEqual(await titles('?linked=1'), ['Jay on A', 'Jay on B']);
  assert.deepEqual(await titles(''), ['Jay on A']);
  const r = await vic.post('/api/users/jay/subscribe-all');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.followed, [`@jay@${host(b)}`]);
  assert.equal(r.data.channel.subscribed, true);
  assert.equal(r.data.channel.linked_accounts[0].following, true);
  // B accepts the follow of its channel.
  await waitFor(async () => (await vic.get('/api/fediverse/follows')).data.follows.find((f) => f.id === `${b.url}/ap/channels/jay`)?.status === 'accepted', {
    what: 'B to accept the follow',
  });
  assert.deepEqual((await vic.post('/api/users/jay/subscribe-all')).data.followed, [], 'nothing left to follow');
  assert.equal((await A.post('/api/users/jay/subscribe-all')).status, 400, 'not your own channel');
});

test('a Mastodon account links by alias, and dropping the alias drops the link', async () => {
  const add = await A.post('/api/me/links', { handle: `jaym@${fake.host()}` });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const id = add.data.added.id;
  assert.equal(add.data.added.verified, false);
  assert.equal(add.data.added.channel, false);
  // The account was told: A's profile with the new alias reached its inbox.
  await waitFor(() => fake.received.some((x) => x.type === 'Update' && x.object?.alsoKnownAs?.includes(`${fake.origin}/users/jaym`)), {
    what: 'the profile update at the fake Mastodon',
  });
  fake.aliases = [`${a.url}/ap/users/jay`];
  const checked = await A.post('/api/me/links/check');
  assert.equal(checked.data.links.find((l) => l.id === id).verified, true);
  const shown = (await vic.get('/api/users/jay')).data.channel.linked_accounts;
  assert.ok(shown.some((l) => l.handle === `@jaym@${fake.host()}` && l.url === `${fake.origin}/@jaym`), JSON.stringify(shown));
  // It has no channel, so there is nothing to follow there.
  assert.deepEqual((await vic.post('/api/users/jay/subscribe-all')).data.followed, []);
  fake.aliases = [];
  const again = await A.post('/api/me/links/check');
  assert.equal(again.data.links.find((l) => l.id === id).verified, false);
  assert.ok(!(await vic.get('/api/users/jay')).data.channel.linked_accounts.some((l) => l.handle.startsWith('@jaym@')));
  assert.equal((await A.del(`/api/me/links/${id}`)).status, 200);
});

test('unlinking ends the link on both sites', async () => {
  const link = (await A.get('/api/me/links')).data.links.find((l) => l.handle === `@jay@${host(b)}`);
  assert.equal((await A.del(`/api/me/links/${link.id}`)).status, 200);
  assert.ok(!((await actorOf(`${a.url}/ap/users/jay`)).alsoKnownAs || []).includes(`${b.url}/ap/users/jay`));
  // B hears about it and stops showing the link; A offers it again, since B still lists A.
  await waitFor(async () => (await B.get('/api/me/links')).data.links[0]?.verified === false, { what: 'the link on B to drop' });
  assert.deepEqual((await new Client(b.url).get('/api/users/jay')).data.channel.linked_accounts, []);
  assert.ok((await A.get('/api/me/links')).data.suggestions.some((x) => x.actor === `${b.url}/ap/users/jay`));
  // The old comment from B is just a comment again.
  const fromB = (await vic.get(`/api/videos/${aVideo.id}/comments`)).data.comments.find((c) => c.body === 'me again, from B');
  assert.equal(fromB.is_uploader, false);
});
