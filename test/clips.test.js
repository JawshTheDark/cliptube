// Gaming clip tools: games, clipping a moment into a new video, and GIF / MP4 exports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startInstance, Client, setupAdmin, registerUser, uploadReady, waitFor, testClip } from './helpers.js';

let inst, admin, bob, carol, source;

before(async () => {
  inst = await startInstance('clips');
  admin = await setupAdmin(inst, 'alice', 'Clip Test');
  bob = await registerUser(inst, 'bob');
  carol = await registerUser(inst, 'carol');
});
after(async () => {
  await inst?.stop();
});

test('games: moderators manage the list, everyone files videos under it', async () => {
  const g = await admin.post('/api/games', { name: 'Call of Duty: Modern Warfare III', short_name: 'MW3', aliases: 'cod, Call of Duty' });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal(g.data.game.id, 'mw3');
  assert.deepEqual(g.data.game.aliases, ['cod', 'call-of-duty']);
  assert.equal((await bob.post('/api/games', { name: 'Nope' })).status, 403);

  // By name, short name or alias; unknown names are refused for members.
  source = await uploadReady(bob, { title: 'Bob ace', game: 'Call of Duty' });
  assert.equal(source.game.id, 'mw3');
  assert.equal(source.game.name, 'Call of Duty: Modern Warfare III');
  const bad = await bob.upload(testClip(), { title: 'x', game: 'Some Unknown Game' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /game list/);

  // Moderators add a game by typing a new name.
  const other = (await admin.patch(`/api/videos/${source.id}`, { game: 'Rocket League' })).data.video;
  assert.equal(other.game.id, 'rocket-league');
  await bob.patch(`/api/videos/${source.id}`, { game: 'mw3' });

  const list = (await new Client(inst.url).get('/api/games')).data.games;
  assert.deepEqual(list.map((x) => [x.id, x.video_count]), [['mw3', 1], ['rocket-league', 0]]);
  const byGame = (await new Client(inst.url).get('/api/videos?game=cod')).data.videos;
  assert.deepEqual(byGame.map((v) => v.id), [source.id]);
  assert.equal(byGame[0].game.id, 'mw3');
  assert.equal((await new Client(inst.url).get('/api/games/call-of-duty')).data.game.id, 'mw3');

  assert.equal((await admin.del('/api/games/rocket-league')).status, 200);
  assert.equal((await new Client(inst.url).get('/api/games/rocket-league')).status, 404);
});

test('clip a moment: exact and fast cuts link back to their source', async () => {
  const exact = await bob.post(`/api/videos/${source.id}/clip`, { start: 1.2, end: 3.2, title: 'The flick' });
  assert.equal(exact.status, 201, JSON.stringify(exact.data));
  const clipId = exact.data.video.id;
  const ready = await waitFor(async () => {
    const v = (await bob.get(`/api/videos/${clipId}`)).data.video;
    if (v.status === 'failed') throw new Error(v.error);
    return v.status === 'ready' ? v : null;
  }, { timeout: 60000, what: 'clip to process' });
  assert.ok(Math.abs(ready.duration - 2) < 0.3, `duration ${ready.duration}`);
  assert.equal(ready.title, 'The flick');
  assert.equal(ready.source.id, source.id);
  assert.equal(ready.source.title, 'Bob ace');
  assert.equal(ready.game.id, 'mw3');
  assert.equal((await bob.get(`/api/videos/${source.id}`)).data.video.clip_count, 1);

  // The test clip has a keyframe at 0, so this one is copied without re-encoding.
  const fast = (await bob.post(`/api/videos/${source.id}/clip`, { start: 0, end: 2, mode: 'fast' })).data.video;
  const fastReady = await waitFor(async () => {
    const v = (await bob.get(`/api/videos/${fast.id}`)).data.video;
    if (v.status === 'failed') throw new Error(v.error);
    return v.status === 'ready' ? v : null;
  }, { timeout: 60000, what: 'fast clip' });
  assert.ok(Math.abs(fastReady.duration - 2) < 0.3, `duration ${fastReady.duration}`);
  assert.equal(fastReady.title, 'Bob ace (clip)');

  assert.equal((await bob.post(`/api/videos/${source.id}/clip`, { start: 1, end: 1.5 })).status, 400);
});

test('others can clip only when the uploader allows it', async () => {
  assert.equal((await bob.get(`/api/videos/${source.id}`)).data.video.can_clip, true);
  assert.equal((await carol.get(`/api/videos/${source.id}`)).data.video.can_clip, false);
  assert.equal((await carol.post(`/api/videos/${source.id}/clip`, { start: 0, end: 2 })).status, 403);
  await bob.patch(`/api/videos/${source.id}`, { allow_clips: true });
  assert.equal((await carol.get(`/api/videos/${source.id}`)).data.video.can_clip, true);
  const r = await carol.post(`/api/videos/${source.id}/clip`, { start: 0, end: 2 });
  assert.equal(r.status, 201);
  assert.equal(r.data.video.uploader.username, 'carol');
  // Only the uploader can cut from the unedited recording.
  assert.equal((await carol.post(`/api/videos/${source.id}/clip`, { start: 0, end: 2, from: 'source' })).status, 403);
});

test('GIF and MP4 exports are private downloads', async () => {
  const gif = await bob.post(`/api/videos/${source.id}/exports`, { format: 'gif', start: 0.5, end: 2, width: 240 });
  assert.equal(gif.status, 202, JSON.stringify(gif.data));
  const mp4 = await bob.post(`/api/videos/${source.id}/exports`, { format: 'mp4', start: 0, end: 3, muted: true });
  assert.equal(mp4.status, 202);
  const done = (id) =>
    waitFor(async () => {
      const x = (await bob.get(`/api/exports/${id}`)).data.export;
      if (x.status === 'failed') throw new Error(x.error);
      return x.status === 'ready' ? x : null;
    }, { timeout: 60000, what: `export ${id}` });
  const g = await done(gif.data.export.id);
  const m = await done(mp4.data.export.id);
  assert.ok(g.size_bytes > 1000);

  const download = async (url) => Buffer.from(await (await fetch(inst.url + url, { headers: { Cookie: bob.cookie } })).arrayBuffer());
  assert.equal((await download(g.download_url)).subarray(0, 6).toString(), 'GIF89a');
  assert.equal((await download(m.download_url)).subarray(4, 8).toString(), 'ftyp');
  assert.equal((await carol.get(`/api/exports/${g.id}`)).status, 404);
  assert.equal((await carol.get(g.download_url)).status, 404);
  assert.equal((await bob.post(`/api/videos/${source.id}/exports`, { format: 'gif', start: 1, end: 1.2 })).status, 400);
});
