// Core site behaviour against a real server: setup, accounts, uploads, editing, comments, roles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

let inst;
let admin;

before(async () => {
  inst = await startInstance('core');
});
after(async () => {
  await inst?.stop();
});

test('the first account needs the setup code and becomes admin', async () => {
  const anon = new Client(inst.url);
  const bad = await anon.post('/api/auth/register', { username: 'sneaky', password: 'sneaky-pass', setup_code: 'wrong' });
  assert.equal(bad.status, 403);
  admin = await setupAdmin(inst, 'alice');
  const me = (await admin.get('/api/auth/me')).data.user;
  assert.equal(me.role, 'admin');
  assert.equal(me.is_admin, true);
});

test('uploads are processed; H.264 is remuxed and VP9 is transcoded', async () => {
  const a = await uploadReady(admin, { title: 'Remux me', tags: 'valorant, ace' });
  assert.equal(a.width, 320);
  assert.deepEqual(a.tags, ['ace', 'valorant']);
  const b = await uploadReady(admin, { title: 'Transcode me' }, 'vp9');
  assert.equal(b.status, 'ready');
  const list = (await new Client(inst.url).get('/api/videos')).data.videos.map((v) => v.title);
  assert.ok(list.includes('Remux me') && list.includes('Transcode me'));
});

test('private videos are hidden from others', async () => {
  const v = await uploadReady(admin, { title: 'Secret', visibility: 'private' });
  const anon = new Client(inst.url);
  assert.equal((await anon.get(`/api/videos/${v.id}`)).status, 404);
  assert.equal((await anon.get(`/media/videos/${v.id}.mp4`)).status, 404);
  assert.ok(!(await anon.get('/api/videos')).data.videos.some((x) => x.id === v.id));
});

test('the timeline editor renders a cut-down version', async () => {
  const v = (await admin.get('/api/videos')).data.videos.find((x) => x.title === 'Remux me');
  const r = await admin.post(`/api/videos/${v.id}/edit`, { segments: [{ start: 0.5, end: 1.5 }, { start: 2.5, end: 3.5 }], fade_out: 0.5 });
  assert.equal(r.status, 200);
  const done = await waitFor(
    async () => {
      const x = (await admin.get(`/api/videos/${v.id}`)).data.video;
      if (x.render_status === 'failed') throw new Error(x.render_error);
      return x.edited && !x.render_status ? x : null;
    },
    { timeout: 60000, what: 'edit render' },
  );
  assert.ok(Math.abs(done.duration - 2) < 0.2, `duration ${done.duration}`);
  assert.match(done.video_url, /\?v=1$/);
  const reverted = (await admin.del(`/api/videos/${v.id}/edit`)).data.video;
  assert.equal(reverted.edited, false);
});

test('comments, replies, likes and permissions', async () => {
  const v = (await admin.get('/api/videos')).data.videos.find((x) => x.title === 'Remux me');
  const bob = await registerUser(inst, 'bob');
  const c = (await bob.post(`/api/videos/${v.id}/comments`, { body: 'nice' })).data.comment;
  const reply = (await admin.post(`/api/videos/${v.id}/comments`, { body: 'thanks', parent_id: c.id })).data.comment;
  assert.equal(reply.parent_id, c.id);
  const liked = (await bob.post(`/api/videos/${v.id}/like`, { value: 1 })).data;
  assert.equal(liked.likes, 1);
  const carol = await registerUser(inst, 'carol');
  assert.equal((await carol.del(`/api/videos/${v.id}/comments/${c.id}`)).status, 403);
  assert.equal((await bob.del(`/api/videos/${v.id}/comments/${c.id}`)).status, 200);
});

test('roles and account status', async () => {
  const dave = await registerUser(inst, 'dave');
  const users = (await admin.get('/api/admin/users')).data.users;
  const d = users.find((u) => u.username === 'dave');
  assert.equal(d.role, 'user');
  // Moderators can delete any comment but cannot open admin settings.
  await admin.patch(`/api/admin/users/${d.id}`, { role: 'moderator' });
  const v = (await admin.get('/api/videos')).data.videos[0];
  const c = (await admin.post(`/api/videos/${v.id}/comments`, { body: 'mod test' })).data.comment;
  assert.equal((await dave.del(`/api/videos/${v.id}/comments/${c.id}`)).status, 200);
  assert.equal((await dave.get('/api/admin/settings')).status, 403);
  // Suspending ends the session and blocks login.
  await admin.patch(`/api/admin/users/${d.id}`, { status: 'suspended', reason: 'cool off' });
  assert.equal((await dave.get('/api/auth/me')).data.user, null);
  const login = await new Client(inst.url).post('/api/auth/login', { username: 'dave', password: 'dave-pass-1' });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /suspended: cool off/);
  // An admin cannot demote or suspend themselves.
  const me = users.find((u) => u.username === 'alice');
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { role: 'user' })).status, 400);
});

test('admin settings never expose keys or tokens', async () => {
  const s = (await admin.get('/api/admin/settings')).data.settings;
  assert.ok(!Object.keys(s).some((k) => /key|token|nonce|password/.test(k)));
});
