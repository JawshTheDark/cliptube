// Trust and safety: reports, moderator actions, spam holds, sign-up modes, quotas,
// takedowns with strikes and counter-notices, data export and account deletion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor, tempDir } from './helpers.js';
import { listTar } from '../server/tar.js';

let inst, admin, bob, carol, bobVideo;

before(async () => {
  inst = await startInstance('mod');
  admin = await setupAdmin(inst, 'alice', 'Mod Test');
  bob = await registerUser(inst, 'bob');
  carol = await registerUser(inst, 'carol');
  bobVideo = await uploadReady(bob, { title: 'Bob clip' });
});
after(async () => {
  await inst?.stop();
});

const userId = async (name) => (await admin.get('/api/admin/users')).data.users.find((u) => u.username === name).id;

test('reports reach moderators, who can hide and restore', async () => {
  const r = await carol.post('/api/reports', { target_type: 'video', target_id: bobVideo.id, reason: 'spam', details: 'reupload' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // A second report from the same person updates the first instead of piling up.
  await carol.post('/api/reports', { target_type: 'video', target_id: bobVideo.id, reason: 'harassment' });
  const open = (await admin.get('/api/mod/reports')).data.reports;
  assert.equal(open.length, 1);
  assert.equal(open[0].reason, 'harassment');
  assert.equal(open[0].reporter, 'carol');

  // Members can't see the queue; a new moderator can.
  assert.equal((await bob.get('/api/mod/reports')).status, 403);
  await admin.patch(`/api/admin/users/${await userId('carol')}`, { role: 'moderator' });
  assert.equal((await carol.get('/api/mod/summary')).data.open_reports, 1);
  await admin.patch(`/api/admin/users/${await userId('carol')}`, { role: 'user' });

  const act = await admin.post(`/api/mod/reports/${open[0].id}/action`, { action: 'hide_video', reason: 'Testing' });
  assert.equal(act.status, 200, JSON.stringify(act.data));
  assert.equal(act.data.report.status, 'resolved');
  const anon = new Client(inst.url);
  assert.equal((await anon.get(`/api/videos/${bobVideo.id}`)).status, 404);
  assert.equal((await anon.get('/api/videos')).data.videos.length, 0);
  const own = (await bob.get(`/api/videos/${bobVideo.id}`)).data.video;
  assert.equal(own.moderation_status, 'hidden');
  assert.equal(own.moderation_reason, 'Testing');

  // The uploader can appeal; a rejected appeal leaves the video hidden.
  const appeal = await bob.post(`/api/videos/${bobVideo.id}/counter-notice`, { statement: 'This is my own clip and it is not spam at all.' });
  assert.equal(appeal.status, 201, JSON.stringify(appeal.data));
  const appeals = (await admin.get('/api/mod/counter-notices')).data.counter_notices;
  assert.equal((await admin.post(`/api/mod/counter-notices/${appeals[0].id}`, { decision: 'reject' })).status, 200);
  assert.equal((await bob.get(`/api/videos/${bobVideo.id}/moderation`)).data.counter_notice.status, 'rejected');

  assert.equal((await admin.post(`/api/mod/videos/${bobVideo.id}`, { action: 'restore' })).status, 200);
  assert.equal((await anon.get(`/api/videos/${bobVideo.id}`)).status, 200);
  const log = (await admin.get('/api/mod/log')).data.actions.map((a) => a.action);
  assert.ok(log.includes('video.hide'), log.join());
  assert.ok(log.includes('video.restore'), log.join());
});

test('spam checks hold first comments, filters and comment modes', async () => {
  const anon = new Client(inst.url);
  const first = await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'nice clip' });
  assert.equal(first.status, 201);
  assert.equal(first.data.held, true);
  assert.equal((await anon.get(`/api/videos/${bobVideo.id}/comments`)).data.comments.length, 0);
  // The author and the uploader can see it; the uploader approves it.
  assert.equal((await carol.get(`/api/videos/${bobVideo.id}/comments`)).data.comments.length, 1);
  const held = (await bob.get('/api/me/comments/held')).data.comments;
  assert.equal(held.length, 1);
  assert.equal((await bob.patch(`/api/videos/${bobVideo.id}/comments/${held[0].id}`, { status: 'visible' })).status, 200);
  assert.equal((await anon.get(`/api/videos/${bobVideo.id}/comments`)).data.comments.length, 1);

  // Once someone has an approved comment, plain comments go straight through, links from new accounts don't.
  assert.equal((await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'second one' })).data.held, false);
  const link = await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'see https://example.com' });
  assert.equal(link.data.held, true);
  assert.match(link.data.held_reason, /Links/);

  await bob.req('PUT', '/api/me/comment-filters', { filters: [{ word: 'Rude', action: 'reject' }, { word: 'meh', action: 'hold' }] });
  assert.equal((await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'that was RUDE' })).status, 400);
  assert.equal((await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'meh' })).data.held, true);

  await bob.patch(`/api/videos/${bobVideo.id}`, { comment_mode: 'off' });
  assert.equal((await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'hello?' })).status, 400);
  assert.equal((await bob.post(`/api/videos/${bobVideo.id}/comments`, { body: 'owner can still post' })).status, 201);
  await bob.patch(`/api/videos/${bobVideo.id}`, { comment_mode: 'hold_all' });
  assert.equal((await carol.post(`/api/videos/${bobVideo.id}/comments`, { body: 'plain' })).data.held, true);
  await bob.patch(`/api/videos/${bobVideo.id}`, { comment_mode: 'inherit' });

  // Pin and heart.
  const visible = (await anon.get(`/api/videos/${bobVideo.id}/comments`)).data.comments;
  const target = visible.find((c) => c.body === 'second one');
  await bob.patch(`/api/videos/${bobVideo.id}/comments/${target.id}`, { pinned: true, hearted: true });
  const after = (await anon.get(`/api/videos/${bobVideo.id}/comments`)).data.comments;
  assert.equal(after[0].id, target.id);
  assert.equal(after[0].pinned, true);
  assert.equal(after[0].hearted, true);
});

test('sign-up modes, invites and terms', async () => {
  const signUp = (username, extra = {}) => new Client(inst.url).post('/api/auth/register', { username, password: 'password1', ...extra });

  await admin.patch('/api/admin/settings', { registration_mode: 'closed' });
  assert.equal((await signUp('dave')).status, 403);
  assert.equal((await new Client(inst.url).get('/api/site')).data.registration_mode, 'closed');

  await admin.patch('/api/admin/settings', { registration_mode: 'invite' });
  assert.equal((await signUp('dave')).status, 403);
  const inv = (await admin.post('/api/admin/invites', { note: 'for dave', max_uses: 1 })).data.invite;
  assert.equal((await signUp('dave', { invite: inv.code })).status, 201);
  assert.equal((await signUp('erin', { invite: inv.code })).status, 403);

  await admin.patch('/api/admin/settings', { registration_mode: 'approval' });
  const pending = await signUp('erin');
  assert.equal(pending.status, 202);
  assert.equal(pending.data.pending, true);
  const login = await new Client(inst.url).post('/api/auth/login', { username: 'erin', password: 'password1' });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /approve/);
  assert.equal((await admin.get('/api/mod/summary')).data.pending_accounts, 1);
  await admin.patch(`/api/admin/users/${await userId('erin')}`, { status: 'active' });
  assert.equal((await new Client(inst.url).post('/api/auth/login', { username: 'erin', password: 'password1' })).status, 200);
  // An invite skips approval.
  const inv2 = (await admin.post('/api/admin/invites', { max_uses: 0 })).data.invite;
  assert.equal((await signUp('frank', { invite: inv2.code })).status, 201);

  await admin.patch('/api/admin/settings', { registration_mode: 'open' });
  await admin.patch('/api/admin/legal', { legal_terms: 'Be nice.' });
  assert.equal((await new Client(inst.url).get('/api/site')).data.has_terms, true);
  assert.equal((await signUp('gina')).status, 400);
  assert.equal((await signUp('gina', { accept_terms: true })).status, 201);
  await admin.patch('/api/admin/legal', { legal_terms: '' });
});

test('storage quotas refuse uploads that would go over', async () => {
  const dave = new Client(inst.url);
  await dave.post('/api/auth/login', { username: 'dave', password: 'password1' });
  await admin.patch(`/api/admin/users/${await userId('dave')}`, { quota_mb: 1 });
  const big = path.join(tempDir('quota'), 'big.mp4');
  fs.writeFileSync(big, Buffer.alloc(1.5 * 1048576, 7));
  const r = await dave.upload(big, { title: 'too big' });
  assert.equal(r.status, 413, JSON.stringify(r.data));
  assert.match(r.data.error, /quota/);
  const s = (await dave.get('/api/me/settings')).data.storage;
  assert.equal(s.quota, 1048576);
  const row = (await admin.get('/api/admin/users')).data.users.find((u) => u.username === 'dave');
  assert.equal(row.quota_mb, 1);
});

test('takedowns remove videos, strike uploaders and counter-notices restore them', async () => {
  await admin.patch('/api/admin/legal', { strike_threshold: 2, legal_transparency_public: 'true' });
  const notice = await admin.post('/api/admin/legal/takedowns', {
    video: `${inst.url}/watch/${bobVideo.id}`,
    claimant: 'Big Games Inc',
    work: 'Our trailer',
    action: 'removed',
  });
  assert.equal(notice.status, 201, JSON.stringify(notice.data));
  assert.equal(notice.data.notices.length, 1);

  const anon = new Client(inst.url);
  assert.equal((await anon.get(`/api/videos/${bobVideo.id}`)).status, 404);
  const own = (await bob.get(`/api/videos/${bobVideo.id}`)).data.video;
  assert.equal(own.moderation_status, 'removed');
  assert.equal(own.video_url, null);
  assert.equal((await anon.get(`/media/videos/${bobVideo.id}.mp4`)).status, 404);
  let row = (await admin.get('/api/admin/users')).data.users.find((u) => u.username === 'bob');
  assert.equal(row.strikes, 1);

  assert.equal((await bob.post(`/api/videos/${bobVideo.id}/counter-notice`, { statement: 'too short' })).status, 400);
  const cn = await bob.post(`/api/videos/${bobVideo.id}/counter-notice`, { statement: 'This is my own gameplay recording, no trailer in it.', contact: 'bob@example.com' });
  assert.equal(cn.status, 201, JSON.stringify(cn.data));
  const list = (await admin.get('/api/mod/counter-notices')).data.counter_notices.filter((c) => c.status === 'pending');
  assert.equal(list.length, 1);
  assert.equal((await admin.post(`/api/mod/counter-notices/${list[0].id}`, { decision: 'accept' })).status, 200);
  assert.equal((await anon.get(`/api/videos/${bobVideo.id}`)).status, 200);
  // A successful counter-notice takes the strike away again.
  row = (await admin.get('/api/admin/users')).data.users.find((u) => u.username === 'bob');
  assert.equal(row.strikes, 0);

  const t = (await anon.get('/api/transparency')).data;
  assert.equal(t.takedown_notices, 1);
  assert.equal(t.videos_restored, 1);
  assert.equal(t.notices[0].claimant, 'Big Games Inc');
  assert.equal(t.notices[0].status, 'restored');
  assert.equal(t.notices[0].claimant_contact, undefined);

  // Two strikes reach the threshold and suspend the account.
  const second = await uploadReady(bob, { title: 'Bob clip 2' });
  const third = await uploadReady(bob, { title: 'Bob clip 3' });
  await admin.post('/api/admin/legal/takedowns', { video: second.id, claimant: 'Big Games Inc', work: 'Our soundtrack', action: 'removed' });
  row = (await admin.get('/api/admin/users')).data.users.find((u) => u.username === 'bob');
  assert.equal(row.strikes, 1);
  assert.equal(row.status, 'active');
  await admin.post('/api/admin/legal/takedowns', { video: third.id, claimant: 'Big Games Inc', work: 'Our logo', action: 'removed' });
  row = (await admin.get('/api/admin/users')).data.users.find((u) => u.username === 'bob');
  assert.equal(row.strikes, 2);
  assert.equal(row.status, 'suspended');
  assert.equal((await bob.get('/api/auth/me')).data.user, null);
  await admin.patch(`/api/admin/users/${row.id}`, { status: 'active', clear_strikes: true });
  await bob.post('/api/auth/login', { username: 'bob', password: 'bob-pass-1' });
  assert.equal((await bob.get('/api/auth/me')).data.user.username, 'bob');
});

test('people can export their data and delete their account', async () => {
  assert.equal((await bob.post('/api/me/exports')).status, 202);
  const ready = await waitFor(async () => {
    const r = (await bob.get('/api/me/exports')).data;
    return !r.preparing && r.exports.length ? r.exports[0] : null;
  }, { timeout: 30000, what: 'export' });
  // Other people can't download it.
  assert.equal((await carol.get(`/api/me/exports/${ready.file}`)).status, 404);
  const res = await fetch(`${inst.url}/api/me/exports/${ready.file}`, { headers: { Cookie: bob.cookie } });
  assert.equal(res.status, 200);
  const file = path.join(tempDir('export'), 'export.tar');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const names = (await listTar(file)).map((e) => e.name);
  assert.ok(names.some((n) => n.endsWith('/export.json')), names.join());
  assert.ok(names.some((n) => n.includes('/videos/')), names.join());

  assert.equal((await bob.post('/api/me/deletion', { password: 'wrong' })).status, 400);
  const del = (await bob.post('/api/me/deletion', { password: 'bob-pass-1' })).data;
  assert.ok(del.deletes_at > del.requested_at);
  assert.equal((await bob.del('/api/me/deletion')).data.requested_at, null);

  // Admin deletion removes the account and the videos.
  const id = await userId('bob');
  assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 200);
  assert.equal((await new Client(inst.url).get(`/api/videos/${bobVideo.id}`)).status, 404);
  assert.equal((await new Client(inst.url).get('/api/users/bob')).status, 404);
  const log = (await admin.get('/api/mod/log')).data.actions.map((a) => a.action);
  assert.ok(log.includes('user.delete'), log.join());
});
