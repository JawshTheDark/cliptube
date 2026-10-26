// A small PeerTube-like server for tests: one account, one channel, videos, comment threads, NodeInfo, and an
// inbox that checks OurTube's HTTP signatures with its own code. It plays the fediverse side in the tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

export const AS = 'https://www.w3.org/ns/activitystreams';
export const PUBLIC = `${AS}#Public`;

/** A tiny fediverse server: one account, one channel, an inbox that verifies signatures, an outbox. */
export function fakeTube() {
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
    if (req.method === 'GET' && url.pathname.startsWith('/videos/watch/')) {
      const uuid = url.pathname.split('/').pop();
      return json(200, F.video(uuid, F.names.get(uuid) || 'Fetched fake video'));
    }
    if (url.pathname === '/.well-known/nodeinfo') {
      return json(200, { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${F.origin}/nodeinfo/2.0.json` }] });
    }
    if (url.pathname === '/nodeinfo/2.0.json') return json(200, { version: '2.0', software: { name: 'peertube', version: '7.3.0' } });
    if (req.method === 'GET' && url.pathname === '/api/v1/videos/talked-about/chapters') {
      return json(200, { chapters: [{ timecode: 30, title: 'The trick' }, { timecode: 0, title: 'Start' }] });
    }
    // PeerTube's comments API: the threads of a video, and one thread with its replies.
    const api = /^\/api\/v1\/videos\/([^/]+)\/comment-threads(?:\/(\d+))?$/.exec(url.pathname);
    if (req.method === 'GET' && api) {
      const roots = F.threads[api[1]];
      if (!roots) return json(404, { error: 'Video not found' });
      const count = (nodes) => nodes.reduce((n, x) => n + 1 + count(x.children), 0);
      if (!api[2]) return json(200, { total: roots.length, data: roots.map((x) => ({ ...x.comment, totalReplies: count(x.children) })) });
      return json(200, roots.find((x) => x.comment.id === Number(api[2])) || {});
    }
    if (req.method === 'POST' && url.pathname.endsWith('/inbox')) {
      try {
        const actorKey = await F.verify(req, raw);
        const body = JSON.parse(raw.toString());
        received.push({ path: url.pathname, signedBy: actorKey, body });
        if (body.type === 'Create' && body.object?.type === 'Note') F.fileReply(body.object);
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
    threads: {}, // video uuid -> [{ comment, children }], the way PeerTube's API nests them
    /** A comment in PeerTube's API shape. */
    comment: (uuid, id, account, text, at, extra = {}) => ({
      comment: { id, url: `${F.origin}/videos/watch/${uuid}/comments/${id}`, text, createdAt: new Date(at).toISOString(), isDeleted: false, account, ...extra },
      children: [],
    }),
    /** Files a reply that came in under the comment it answers, as PeerTube does. */
    fileReply(note) {
      const find = (nodes) => nodes.flatMap((x) => (x.comment.url === note.inReplyTo ? [x] : find(x.children)));
      const parent = Object.values(F.threads).flatMap(find)[0];
      const name = note.attributedTo.split('/').pop();
      const account = { url: note.attributedTo, name, host: new URL(note.attributedTo).host, displayName: name, avatars: [] };
      parent?.children.push({ comment: { id: Date.now(), url: note.id, text: note.content, createdAt: note.published, isDeleted: false, account }, children: [] });
    },
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
    names: new Map(), // uuid -> the title it was published with, for fetches of it later
    video: (uuid, name) => (F.names.set(uuid, name), {
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
