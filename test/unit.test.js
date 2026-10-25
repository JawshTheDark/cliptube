// Pure-function tests. Server modules open the database on import, so point them at a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers.js';

process.env.DATA_DIR = tempDir('unit');

const { parseTags, escapeHtml } = await import('../server/util.js');
const { normalizeInstanceUrl, isPrivateIp, cleanItem } = await import('../server/network.js');
const { normalizeEdit } = await import('../server/routes/videos.js');

test('parseTags cleans, lowercases, dedupes and caps tags', () => {
  assert.deepEqual(parseTags('Valorant, #ACE, valorant,  clutch  '), ['valorant', 'ace', 'clutch']);
  assert.deepEqual(parseTags(['a'.repeat(31), 'ok']), ['ok']);
  assert.equal(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 15);
});

test('escapeHtml escapes markup', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('normalizeInstanceUrl reduces addresses to their origin', () => {
  assert.equal(normalizeInstanceUrl('clips.example.com'), 'https://clips.example.com');
  assert.equal(normalizeInstanceUrl('https://Clips.Example.com/some/path?x=1'), 'https://clips.example.com');
  assert.equal(normalizeInstanceUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.throws(() => normalizeInstanceUrl('https://user:pw@example.com'));
  assert.throws(() => normalizeInstanceUrl('ftp://example.com'));
  assert.throws(() => normalizeInstanceUrl(''));
});

test('isPrivateIp recognises private, loopback and link-local ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.97', '172.20.0.5', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '173.208.50.194', '24.26.6.202', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('cleanItem rejects media that is not hosted on the origin', () => {
  const origin = 'https://clips.example.com';
  const good = {
    id: 'abc123',
    title: 'Clip',
    video_url: `${origin}/media/videos/abc123.mp4`,
    watch_url: `${origin}/watch/abc123`,
    uploader: { username: 'bob' },
  };
  assert.equal(cleanItem(good, origin).remote_id, 'abc123');
  assert.equal(cleanItem({ ...good, video_url: 'https://evil.example/x.mp4' }, origin), null);
  assert.equal(cleanItem({ ...good, watch_url: 'javascript:alert(1)' }, origin), null);
  assert.equal(cleanItem({ ...good, id: '../etc' }, origin), null);
});

test('normalizeEdit sorts, merges touching parts and validates', () => {
  const e = normalizeEdit({ segments: [{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 3, end: 4 }], volume: 1.5 }, 10);
  assert.deepEqual(e.segments, [{ start: 1, end: 4 }, { start: 5, end: 7 }]);
  assert.equal(e.volume, 1.5);
  assert.throws(() => normalizeEdit({ segments: [{ start: 1, end: 5 }, { start: 4, end: 6 }] }, 10), /overlap/);
  assert.throws(() => normalizeEdit({ segments: [] }, 10));
  assert.equal(normalizeEdit({ segments: [{ start: 0, end: 99 }] }, 10).segments[0].end, 10);
});
