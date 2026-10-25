// Feeds, notifications (in-app, push encryption, email), search, the "For you" feed, vertical clips and analytics.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';
import { encryptPayload, vapidHeader } from '../server/webpush.js';

let inst, admin, bob, carol, anon, v1, v2, smtp;
const mails = [];

/** A fake SMTP server that keeps every message it receives. */
function fakeSmtp() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let data = false;
      let buf = '';
      let msg = '';
      sock.write('220 fake ESMTP\r\n');
      sock.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (data) {
            if (line === '.') {
              data = false;
              mails.push(msg);
              msg = '';
              sock.write('250 queued\r\n');
            } else msg += `${line}\n`;
          } else if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
          else if (/^DATA/i.test(line)) {
            data = true;
            sock.write('354 go\r\n');
          } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
          else sock.write('250 ok\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const mailBody = (m) => Buffer.from(m.split('\n\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');

before(async () => {
  smtp = await fakeSmtp();
  inst = await startInstance('disc');
  admin = await setupAdmin(inst, 'alice', 'Discovery Test');
  bob = await registerUser(inst, 'bob');
  carol = await registerUser(inst, 'carol');
  anon = new Client(inst.url);
  await admin.post('/api/games', { name: 'Valorant', short_name: 'valorant' });
  await carol.post('/api/users/bob/subscribe');
  v1 = await uploadReady(bob, { title: 'Insane flick with the operator', description: 'one tap through smoke', tags: 'ace,clutch', game: 'valorant' });
  v2 = await uploadReady(admin, { title: 'Exact phrase test clip', description: 'nothing to see here', tags: 'misc' });
});
after(async () => {
  await inst?.stop();
  smtp?.close();
});

test('RSS and Atom feeds for the instance, a channel and a game', async () => {
  const atom = await fetch(`${inst.url}/feeds/videos.atom`);
  assert.equal(atom.status, 200);
  assert.match(atom.headers.get('content-type'), /atom\+xml/);
  const a = await atom.text();
  assert.match(a, /<entry>/);
  assert.match(a, /Insane flick with the operator/);
  assert.match(a, /rel="enclosure" type="video\/mp4"/);
  const rss = await (await fetch(`${inst.url}/feeds/channel/bob.rss`)).text();
  assert.match(rss, /<item>/);
  assert.doesNotMatch(rss, /Exact phrase test clip/);
  const game = await (await fetch(`${inst.url}/feeds/game/valorant.atom`)).text();
  assert.match(game, /Valorant clips/);
  assert.equal((await fetch(`${inst.url}/feeds/channel/nobody.atom`)).status, 404);
});

test('subscribers are notified of uploads; replies, mentions and moderation notify too', async () => {
  const up = await waitFor(async () => (await carol.get('/api/notifications')).data.notifications.find((n) => n.kind === 'upload'), { what: 'upload notification' });
  assert.match(up.title, /bob uploaded: Insane flick/);
  assert.equal(up.url, `/watch/${v1.id}`);
  assert.equal((await carol.get('/api/notifications/count')).data.unread, 1);
  assert.equal((await carol.post('/api/notifications/read')).data.unread, 0);

  // A first comment is held; approving it tells the uploader.
  const c = (await carol.post(`/api/videos/${v1.id}/comments`, { body: 'how did you see that' })).data.comment;
  await bob.patch(`/api/videos/${v1.id}/comments/${c.id}`, { status: 'visible' });
  await waitFor(async () => (await bob.get('/api/notifications')).data.notifications.find((n) => n.kind === 'comment'), { what: 'comment notification' });
  await bob.post(`/api/videos/${v1.id}/comments`, { body: 'wallhacks obviously', parent_id: c.id });
  await waitFor(async () => (await carol.get('/api/notifications')).data.notifications.find((n) => n.kind === 'reply'), { what: 'reply notification' });
  await bob.post(`/api/videos/${v1.id}/comments`, { body: 'hey @alice look at this' });
  await waitFor(async () => (await admin.get('/api/notifications')).data.notifications.find((n) => n.kind === 'mention'), { what: 'mention notification' });

  await admin.post(`/api/mod/videos/${v1.id}`, { action: 'hide', reason: 'checking' });
  const mod = await waitFor(async () => (await bob.get('/api/notifications')).data.notifications.find((n) => n.kind === 'moderation'), { what: 'moderation notification' });
  assert.match(mod.title, /hidden/);
  await admin.post(`/api/mod/videos/${v1.id}`, { action: 'restore' });
});

test('web push: subscriptions are stored, payloads decrypt with the browser keys, VAPID verifies', async () => {
  const s = (await carol.get('/api/notifications/settings')).data;
  assert.match(s.push_key, /^[A-Za-z0-9_-]{86,88}$/);
  // A browser-side key pair and auth secret, like PushManager.subscribe() would make.
  const ua = crypto.createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') } };
  assert.equal((await carol.post('/api/notifications/push', sub)).status, 201);
  assert.equal((await carol.post('/api/notifications/push', { ...sub, endpoint: 'http://127.0.0.1/x' })).status, 400);

  const body = encryptPayload('{"title":"hi"}', sub.keys.p256dh, sub.keys.auth);
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const ct = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.subarray(0, plain.length - 1).toString(), '{"title":"hi"}');
  assert.equal(plain[plain.length - 1], 2);
});

test('VAPID: the JWT is signed with the key browsers are given', async () => {
  const h = vapidHeader('https://push.example.com/send/abc', 'mailto:admin@example.com');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  const [header, claims, sig] = jwt.split('.');
  const raw = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(c.aud, 'https://push.example.com');
  assert.ok(c.exp > Date.now() / 1000);
});

test('email: address check, notification emails and password reset through SMTP', async () => {
  await admin.patch('/api/admin/settings', { smtp_host: '127.0.0.1', smtp_port: smtp.address().port, smtp_secure: 'none', smtp_from: 'ClipTube <clips@example.com>' });
  assert.equal((await admin.post('/api/admin/mail/test', { to: 'alice@example.com' })).status, 200);
  assert.ok(mails.some((m) => /To: alice@example.com/.test(m)));

  assert.equal((await carol.req('PUT', '/api/notifications/email', { email: 'carol@example.com' })).status, 200);
  const verify = mails.find((m) => /To: carol@example.com/.test(m) && /confirm/i.test(m));
  const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(mailBody(verify))[1];
  assert.equal((await anon.post('/api/auth/verify-email', { token })).status, 200);
  assert.equal((await carol.get('/api/notifications/settings')).data.email_verified, true);

  await anon.post('/api/auth/forgot-password', { login: 'carol' });
  const reset = await waitFor(async () => mails.find((m) => /To: carol@example.com/.test(m) && /reset/i.test(m)), { what: 'reset email' });
  const rt = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mailBody(reset))[1];
  assert.equal((await anon.post('/api/auth/reset-password', { token: rt, password: 'new-pass-123' })).status, 200);
  assert.equal((await new Client(inst.url).post('/api/auth/login', { username: 'carol', password: 'new-pass-123' })).status, 200);
  assert.equal((await anon.post('/api/auth/reset-password', { token: rt, password: 'again-123' })).status, 400, 'reset links work once');
  await carol.post('/api/auth/login', { username: 'carol', password: 'new-pass-123' });
});

test('search: relevance, exact phrases, filters and sorting', async () => {
  const titles = async (q) => (await anon.get(`/api/search?${q}`)).data.videos.map((v) => v.title);
  assert.deepEqual(await titles('q=smoke'), ['Insane flick with the operator']);
  assert.deepEqual(await titles('q=flic'), ['Insane flick with the operator'], 'prefix match');
  assert.deepEqual(await titles(`q=${encodeURIComponent('"exact phrase"')}`), ['Exact phrase test clip']);
  assert.deepEqual(await titles(`q=${encodeURIComponent('"phrase exact"')}`), []);
  assert.deepEqual(await titles('q=bob'), ['Insane flick with the operator'], 'channel names are searchable');
  assert.deepEqual(await titles('game=valorant'), ['Insane flick with the operator']);
  assert.equal((await titles('duration=short')).length, 2);
  assert.equal((await titles('duration=long')).length, 0);
  assert.equal((await titles('date=day')).length, 2);
  assert.equal((await anon.get(`/api/search?q=${encodeURIComponent('"" * AND (')}`)).status, 200);
});

test('vertical clips have their own filter', async () => {
  const vert = await uploadReady(bob, { title: 'Phone clip' }, 'vertical');
  const ids = async (q) => (await anon.get(`/api/videos?${q}`)).data.videos.map((v) => v.id);
  assert.deepEqual(await ids('shape=vertical'), [vert.id]);
  assert.ok(!(await ids('shape=landscape')).includes(vert.id));
});

test('"For you" says why, and listens to "not interested" and "less of this"', async () => {
  await carol.post(`/api/videos/${v1.id}/like`, { value: 1 });
  let feed = (await carol.get('/api/feed/for-you')).data.videos;
  const flick = feed.find((v) => v.id === v1.id);
  assert.match(flick.reason, /subscribe|liked|Valorant/);
  assert.ok(feed.every((v) => v.reason));
  await carol.req('PUT', '/api/feed/preferences', { kind: 'video', target: v2.id, weight: -9 });
  feed = (await carol.get('/api/feed/for-you')).data.videos;
  assert.ok(!feed.some((v) => v.id === v2.id));
  assert.equal((await carol.get('/api/feed/preferences')).data.preferences.length, 1);
  assert.equal((await anon.get('/api/feed/for-you')).status, 401);
});

test('analytics: daily views, sources, watch time and retention, for the owner only', async () => {
  await anon.post(`/api/videos/${v2.id}/view`, { ref: 'https://discord.com/channels/1/2' });
  await carol.post(`/api/videos/${v2.id}/view`, { from: 'search' });
  await anon.post(`/api/videos/${v2.id}/watch`, { seconds: 3.5, buckets: [0, 1, 2, 3, 4, 10, 49, 99, -1] });
  const a = (await admin.get(`/api/studio/analytics?video=${v2.id}`)).data;
  assert.equal(a.totals.views, 2);
  assert.ok(a.totals.watch_seconds >= 3);
  assert.deepEqual(a.referrers.map((r) => r.source).sort(), ['discord.com', 'site:search']);
  assert.equal(a.retention.length, 50);
  assert.equal(a.retention[0].share, 1);
  assert.equal(a.retention[5].share, 0);
  assert.equal((await bob.get(`/api/studio/analytics?video=${v2.id}`)).status, 404);
  const channel = (await admin.get('/api/studio/analytics')).data;
  assert.equal(channel.top[0].id, v2.id);
});
