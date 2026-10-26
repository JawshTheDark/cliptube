/**
 * Channel export and import, for moving a channel to another instance.
 *
 * The export is one tar archive: channel.json (profile, videos with their details, comments, the
 * subscriber list) plus each video, its thumbnail and captions. The import recreates the channel under
 * the importing account: videos go through the normal processing, comments keep their authors as
 * placeholder accounts that link back to them, and old videos are not announced to anyone as new.
 *
 * An export also has a private link, so the new instance can fetch it straight from the old one instead
 * of the archive passing through someone's phone or laptop. Routes are mounted at /api/me, plus the
 * public download behind that link.
 */
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, getSettings } from './db.js';
import { DIRS, VERSION } from './config.js';
import { requireAuth } from './auth.js';
import { HttpError, newId, now, parseTags, str } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';
import { copyTarEntry, listTar, readTarEntry, writeTar } from './tar.js';
import { convertImage, enqueue as enqueueProcessing } from './media.js';
import { defineUploadKind, finishedUpload } from './uploads.js';
import { setTags, storageFor } from './routes/videos.js';
import { indexVideo } from './search.js';
import { findGame } from './games.js';
import { toVtt } from './watching.js';
import { notify } from './notify.js';
import { apEnabled, hostOf, originOf, urls } from './ap/common.js';
import { instanceFor } from './ap/actors.js';
import { assertPublic } from './ap/http.js';

const DAY = 86400_000;
const FORMAT = 'cliptube-channel-1';
const SEGMENT_KINDS = new Set(['sponsor', 'intro', 'outro', 'recap', 'selfpromo']);
const COMMENT_MODES = new Set(['inherit', 'open', 'hold_all', 'off']);
const VISIBILITIES = new Set(['public', 'unlisted', 'private']);

const siteBase = () => {
  const s = getSettings();
  return (s.public_url || s.network_self_url || '').replace(/\/+$/, '');
};
const importMaxBytes = () => (Number(getSettings().import_max_mb) || 51200) * 1048576;
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 500 ? u : null);
const iso = (t) => (t ? new Date(Number(t)).toISOString() : null);
const fromIso = (s, fallback) => {
  const t = Date.parse(s || '');
  return Number.isFinite(t) ? t : fallback;
};

// ---- export -------------------------------------------------------------------------------------------

/** Everything about a channel that another instance needs to recreate it, and the files to go with it. */
function buildExport(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const base = siteBase();
  const host = hostOf(base) || 'localhost';
  const root = `cliptube-channel-${u.username}`;
  const files = [];
  const add = (name, file) => {
    if (file && fs.existsSync(file)) {
      files.push({ name: `${root}/${name}`, file });
      return name;
    }
    return null;
  };
  // Videos taken down by moderators stay behind.
  const videos = db.prepare("SELECT * FROM videos WHERE user_id = ? AND status = 'ready' AND moderation_status IS NULL ORDER BY created_at").all(userId);
  const ids = new Set(videos.map((v) => v.id));
  const counts = (id) => db.prepare('SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes FROM likes WHERE video_id = ?').get(id);
  const out = videos.map((v) => {
    const game = v.game_id ? db.prepare('SELECT id, name FROM games WHERE id = ?').get(v.game_id) : null;
    const lk = counts(v.id);
    return {
      id: v.id,
      title: v.title,
      description: v.description,
      visibility: v.visibility,
      tags: db.prepare('SELECT tag FROM tags WHERE video_id = ?').all(v.id).map((t) => t.tag),
      game: game ? { slug: game.id, name: game.name } : null,
      created_at: iso(v.created_at),
      published_at: iso(v.published_at),
      duration: v.duration,
      width: v.width,
      height: v.height,
      views: v.views,
      likes: lk.likes,
      dislikes: lk.dislikes,
      comment_mode: v.comment_mode,
      allow_clips: !!v.allow_clips,
      allow_original_download: !!v.allow_original_download,
      federate: !!v.federate,
      clip_of: v.source_video_id && ids.has(v.source_video_id) ? { video_id: v.source_video_id, start: v.source_start, end: v.source_end } : null,
      pinned_comment_id: v.pinned_comment_id || null,
      watch_url: base ? `${base}/watch/${v.id}` : null,
      file: add(`videos/${v.id}/video.mp4`, v.file_path ? path.join(DIRS.videos, v.file_path) : null),
      thumbnail: add(`videos/${v.id}/thumb.jpg`, v.thumb_path ? path.join(DIRS.thumbs, v.thumb_path) : null),
      custom_thumbnail: !!v.custom_thumb,
      captions: db
        .prepare("SELECT * FROM captions WHERE video_id = ? AND status = 'published'")
        .all(v.id)
        .map((c) => ({ lang: c.lang, label: c.label, file: add(`videos/${v.id}/captions/${c.id}.vtt`, path.join(DIRS.captions, c.file)) }))
        .filter((c) => c.file),
      segments: db.prepare("SELECT kind, start_s, end_s FROM segments WHERE video_id = ? AND status = 'published'").all(v.id),
    };
  });
  const comments = videos.length
    ? db
        .prepare(
          `SELECT c.*, x.username, x.display_name, x.avatar, x.remote_instance_id, x.remote_avatar_url, x.remote_profile_url, x.ap_actor
           FROM comments c JOIN users x ON x.id = c.user_id
           WHERE c.status = 'visible' AND c.video_id IN (SELECT id FROM videos WHERE user_id = ? AND status = 'ready' AND moderation_status IS NULL)
           ORDER BY c.created_at`,
        )
        .all(userId)
        .map((c) => {
          const remote = !!c.remote_instance_id;
          return {
            id: c.id,
            video_id: c.video_id,
            parent_id: c.parent_id,
            body: c.body,
            created_at: iso(c.created_at),
            hearted: !!c.hearted,
            author: {
              is_owner: c.user_id === u.id,
              handle: remote ? c.username : `${c.username}@${host}`,
              display_name: c.display_name,
              avatar_url: remote ? c.remote_avatar_url : c.avatar && base ? `${base}/media/avatars/${c.avatar}` : null,
              profile_url: remote ? c.remote_profile_url : base ? `${base}/c/${c.username}` : null,
              ap_actor: remote ? c.ap_actor || null : apEnabled() && base ? urls(base).person(c.username) : null,
            },
          };
        })
    : [];
  const subscribers = db.prepare('SELECT x.username, x.remote_instance_id, x.ap_actor FROM subscriptions s JOIN users x ON x.id = s.subscriber_id WHERE s.channel_id = ?').all(userId);
  const data = {
    format: FORMAT,
    exported_at: new Date().toISOString(),
    software: { name: 'cliptube', version: VERSION },
    source: {
      url: base || null,
      handle: `@${u.username}@${host}`,
      channel_url: base ? `${base}/c/${u.username}` : null,
      person: base ? urls(base).person(u.username) : null,
      group: base ? urls(base).group(u.username) : null,
    },
    profile: {
      username: u.username,
      display_name: u.display_name,
      bio: u.bio,
      support_links: (() => {
        try {
          return JSON.parse(u.support_links || '[]');
        } catch {
          return [];
        }
      })(),
      comment_mode: u.comment_mode,
      avatar: add('avatar.jpg', u.avatar ? path.join(DIRS.avatars, u.avatar) : null),
      banner: add('banner.jpg', u.banner ? path.join(DIRS.avatars, u.banner) : null),
    },
    videos: out,
    comments,
    subscribers: {
      count: subscribers.length,
      here: subscribers.filter((s) => !s.remote_instance_id).map((s) => `${s.username}@${host}`),
      network: subscribers.filter((s) => s.remote_instance_id && !s.ap_actor).map((s) => s.username),
      fediverse: db.prepare('SELECT DISTINCT remote_actor FROM ap_followers WHERE local_actor IN (?, ?)').all(`u:${userId}`, `c:${userId}`).map((r) => r.remote_actor),
    },
  };
  return { root, data, files };
}

defineJob('channel.export', {
  lane: 'transfer',
  maxAttempts: 2,
  handler: async ({ id }) => {
    const row = db.prepare('SELECT * FROM channel_exports WHERE id = ?').get(id);
    if (!row || row.status === 'ready') return;
    db.prepare("UPDATE channel_exports SET status = 'working', error = NULL WHERE id = ?").run(id);
    const file = `channel-${row.user_id}-${id}.tar`;
    const tmp = path.join(DIRS.exports, `${file}.part`);
    try {
      fs.mkdirSync(DIRS.exports, { recursive: true });
      const { root, data, files } = buildExport(row.user_id);
      await writeTar(tmp, [{ name: `${root}/channel.json`, data: JSON.stringify(data, null, 2) }, ...files]);
      fs.renameSync(tmp, path.join(DIRS.exports, file));
      const size = fs.statSync(path.join(DIRS.exports, file)).size;
      db.prepare("UPDATE channel_exports SET status = 'ready', file = ?, size_bytes = ?, expires_at = ? WHERE id = ?").run(file, size, now() + 7 * DAY, id);
      enqueueJob('channel.export.expire', { id, file }, { delay: 7 * DAY });
      notify(row.user_id, { kind: 'move', title: 'Your channel export is ready to download', url: '/settings#move', dedupe: `channel-export:${id}` });
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      db.prepare("UPDATE channel_exports SET status = 'failed', error = ? WHERE id = ?").run(str(e.message, 500), id);
      console.warn(`[transfer] export ${id} failed: ${e.message}`);
    }
  },
});

defineJob('channel.export.expire', {
  handler: ({ id, file }) => {
    try {
      fs.unlinkSync(path.join(DIRS.exports, path.basename(String(file))));
    } catch {}
    db.prepare('DELETE FROM channel_exports WHERE id = ?').run(id);
  },
});

const exportRow = (r) => {
  const base = siteBase();
  return {
    id: r.id,
    status: r.status,
    size_bytes: r.size_bytes,
    error: r.error,
    created_at: r.created_at,
    expires_at: r.expires_at,
    download_url: r.status === 'ready' ? `/api/me/channel-exports/${r.id}/download` : null,
    // For "import from a link" on the new instance. Anyone with the link can download the archive.
    link: r.status === 'ready' && base ? `${base}/api/channel-exports/${r.id}?token=${r.token}` : null,
  };
};

// ---- import -------------------------------------------------------------------------------------------

/** A placeholder account for someone who commented on the old site, linking back to them there. */
function placeholderFor(a, sourceOrigin, cache) {
  const key = `${a.ap_actor || ''}|${a.handle || ''}`;
  if (cache.has(key)) return cache.get(key);
  const apActor = safeUrl(a.ap_actor);
  let id = apActor ? db.prepare('SELECT id FROM users WHERE ap_actor = ?').get(apActor)?.id : null;
  if (!id) {
    const raw = String(a.handle || '').replace(/^@/, '');
    const m = /^([A-Za-z0-9_.-]{1,50})@([A-Za-z0-9.-]+(?::\d+)?)$/.exec(raw);
    const host = m ? m[2].toLowerCase() : hostOf(sourceOrigin) || 'unknown';
    const name = (m ? m[1] : str(a.display_name, 30).replace(/[^A-Za-z0-9_.-]/g, '')) || 'someone';
    // People from this very site (a channel coming back home) are themselves.
    if (host === hostOf(siteBase())) id = db.prepare('SELECT id FROM users WHERE username = ? AND remote_instance_id IS NULL').get(name)?.id;
    if (!id) {
      let handle = `${name.toLowerCase()}@${host}`;
      const existing = db.prepare('SELECT id, remote_instance_id FROM users WHERE username = ?').get(handle);
      if (existing?.remote_instance_id) id = existing.id;
      else {
        if (existing) handle = `${name.toLowerCase()}.${newId(3)}@${host}`;
        const profile = safeUrl(a.profile_url);
        const inst = instanceFor(apActor || profile || `https://${host}/`);
        id = newId();
        db.prepare(
          "INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at, remote_instance_id, remote_avatar_url, remote_profile_url, ap_actor) VALUES (?, ?, ?, '!', 0, ?, ?, ?, ?, ?)",
        ).run(id, handle, str(a.display_name || name, 50) || name, now(), inst.id, safeUrl(a.avatar_url), profile, apActor);
      }
    }
  }
  cache.set(key, id);
  return id;
}

/** Downloads an archive from another instance's private export link. */
async function download(url, dest) {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(target);
    const res = await fetch(target, { redirect: 'manual', headers: { 'User-Agent': `OurTube/${VERSION} (channel import)` }, signal: AbortSignal.timeout(6 * 3600_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      target = new URL(res.headers.get('location'), target).href;
      continue;
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'The link has expired or is wrong' : `The other site answered ${res.status}`);
    const max = importMaxBytes();
    if (Number(res.headers.get('content-length')) > max) throw new Error('The archive is larger than this site accepts');
    let seen = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) ctl.error(new Error('The archive is larger than this site accepts'));
        else ctl.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(dest));
    return seen;
  }
  throw new Error('Too many redirects');
}

const setImport = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE channel_imports SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
};

async function runImport(id) {
  const row = db.prepare('SELECT * FROM channel_imports WHERE id = ?').get(id);
  if (!row || row.status === 'done') return;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return;
  let file = row.file ? path.join(DIRS.tmp, path.basename(row.file)) : null;
  if (!file || !fs.existsSync(file)) {
    if (!row.source_url) throw new Error('The uploaded archive is missing');
    setImport(id, { status: 'downloading', error: null });
    const name = `import-${id}.tar`;
    file = path.join(DIRS.tmp, name);
    const size = await download(row.source_url, file);
    setImport(id, { file: name, size_bytes: size });
  }
  setImport(id, { status: 'working', error: null, progress: 0 });

  const entries = await listTar(file);
  const meta = entries.find((e) => e.name === 'channel.json' || e.name.endsWith('/channel.json'));
  if (!meta) throw new Error("This isn't an OurTube channel export (channel.json is missing)");
  if (meta.size > 64 * 1048576) throw new Error('channel.json is too large');
  const root = meta.name.slice(0, meta.name.length - 'channel.json'.length);
  let data;
  try {
    data = JSON.parse((await readTarEntry(file, meta)).toString('utf8'));
  } catch {
    throw new Error('channel.json is not valid JSON');
  }
  if (data?.format !== FORMAT) throw new Error(`Unsupported export format: ${String(data?.format || 'none').slice(0, 40)}`);
  const entry = (name) => (typeof name === 'string' && name ? entries.find((e) => e.name === `${root}${name}`) : null);
  const videos = (Array.isArray(data.videos) ? data.videos : []).filter((v) => v && typeof v.id === 'string');
  const sourceKey = safeUrl(data.source?.url) || `archive:${String(data.source?.handle || 'unknown').slice(0, 100)}`;
  const sourceOrigin = originOf(data.source?.url || '') || '';

  // Storage: the whole channel has to fit.
  const needed = videos.reduce((n, v) => n + (entry(v.file)?.size || 0), 0);
  const { used, quota } = storageFor(user.id);
  if (quota > 0 && used + needed > quota) {
    const mb = (n) => `${Math.round(n / 1048576).toLocaleString()} MB`;
    throw new Error(`This channel needs ${mb(needed)}, more than your storage quota leaves (${mb(used)} of ${mb(quota)} used). Ask an admin for more space.`);
  }

  // Profile.
  if (row.apply_profile && data.profile && typeof data.profile === 'object') {
    const p = data.profile;
    const links = (Array.isArray(p.support_links) ? p.support_links : [])
      .filter((l) => l && /^https:\/\//.test(String(l.url || '')))
      .slice(0, 5)
      .map((l) => ({ label: str(l.label, 40).trim() || hostOf(l.url), url: String(l.url).slice(0, 500) }));
    db.prepare('UPDATE users SET display_name = ?, bio = ?, support_links = ?, comment_mode = ? WHERE id = ?').run(
      str(p.display_name, 50).trim() || user.display_name, str(p.bio, 1000), JSON.stringify(links), p.comment_mode === 'hold_all' ? 'hold_all' : 'open', user.id,
    );
    for (const [field, kind] of [['avatar', 'avatar'], ['banner', 'banner']]) {
      const e = entry(p[field]);
      if (!e || e.size > 15 * 1048576) continue;
      const tmp = path.join(DIRS.tmp, `${newId()}.img`);
      const name = `${newId()}.jpg`;
      try {
        await copyTarEntry(file, e, tmp);
        await convertImage(tmp, path.join(DIRS.avatars, name), kind); // re-encoded, never served as uploaded
        const old = db.prepare(`SELECT ${field} AS f FROM users WHERE id = ?`).get(user.id)?.f;
        db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(name, user.id);
        if (old && old !== name) fs.rmSync(path.join(DIRS.avatars, old), { force: true });
      } catch (err) {
        console.warn(`[transfer] import ${id}: could not use the ${field}: ${err.message}`);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  }

  // Videos, oldest first.
  const map = new Map();
  let imported = 0;
  let skipped = 0;
  videos.sort((a, b) => fromIso(a.created_at, 0) - fromIso(b.created_at, 0));
  for (const [i, v] of videos.entries()) {
    const key = `${sourceKey}#${v.id}`;
    const existing = db.prepare('SELECT id FROM videos WHERE user_id = ? AND import_key = ?').get(user.id, key);
    if (existing) {
      map.set(v.id, existing.id);
      continue;
    }
    const e = entry(v.file);
    if (!e) {
      skipped++;
      continue;
    }
    const vid = newId();
    const original = `${vid}.mp4`;
    await copyTarEntry(file, e, path.join(DIRS.originals, original));
    let thumb = null;
    const te = entry(v.thumbnail);
    if (te && te.size <= 15 * 1048576) {
      const tmp = path.join(DIRS.tmp, `${vid}.thumb`);
      try {
        await copyTarEntry(file, te, tmp);
        await convertImage(tmp, path.join(DIRS.thumbs, `${vid}.jpg`), 'thumb');
        thumb = `${vid}.jpg`;
      } catch {}
      fs.rmSync(tmp, { force: true });
    }
    const game = v.game ? findGame(v.game.slug) || findGame(v.game.name) : null;
    const created = fromIso(v.created_at, now());
    const t = now();
    db.prepare(
      `INSERT INTO videos (id, user_id, title, description, visibility, status, original_name, original_path, size_bytes, created_at, updated_at, published_at,
         game_id, allow_clips, allow_original_download, comment_mode, federate, views, thumb_path, custom_thumb, import_key, notified_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      vid, user.id, str(v.title, 120).trim() || 'Untitled clip', str(v.description, 5000), VISIBILITIES.has(v.visibility) ? v.visibility : 'public',
      'video.mp4', original, e.size, created, t, v.published_at ? fromIso(v.published_at, created) : null,
      game?.id || null, v.allow_clips ? 1 : 0, v.allow_original_download ? 1 : 0, COMMENT_MODES.has(v.comment_mode) ? v.comment_mode : 'inherit',
      v.federate === false ? 0 : 1, Math.max(0, Math.floor(Number(v.views) || 0)), thumb, thumb && v.custom_thumbnail ? 1 : 0, key, t,
    );
    setTags(vid, parseTags(Array.isArray(v.tags) ? v.tags : []));
    for (const c of Array.isArray(v.captions) ? v.captions : []) {
      const ce = entry(c?.file);
      if (!ce || ce.size > 2 * 1048576) continue;
      const cid = newId();
      const name = `${vid}-${cid}.vtt`;
      try {
        fs.writeFileSync(path.join(DIRS.captions, name), toVtt((await readTarEntry(file, ce)).toString('utf8')));
        db.prepare("INSERT INTO captions (id, video_id, lang, label, file, status, created_at) VALUES (?, ?, ?, ?, ?, 'published', ?)").run(
          cid, vid, str(c.lang, 12).trim() || 'und', str(c.label, 40).trim() || 'Captions', name, t,
        );
      } catch {}
    }
    for (const s of Array.isArray(v.segments) ? v.segments : []) {
      const start = Number(s?.start_s);
      const end = Number(s?.end_s);
      if (!SEGMENT_KINDS.has(s?.kind) || !(start >= 0) || !(end > start)) continue;
      db.prepare("INSERT INTO segments (id, video_id, kind, start_s, end_s, status, created_at) VALUES (?, ?, ?, ?, ?, 'published', ?)").run(newId(), vid, s.kind, start, end, t);
    }
    map.set(v.id, vid);
    indexVideo(vid);
    enqueueProcessing(vid);
    imported++;
    setImport(id, { progress: Math.round(((i + 1) / videos.length) * 90) });
  }
  // Clips cut from videos that came along keep pointing at them.
  for (const v of videos) {
    if (v.clip_of && map.has(v.id) && map.has(v.clip_of.video_id)) {
      db.prepare('UPDATE videos SET source_video_id = ?, source_start = ?, source_end = ? WHERE id = ? AND source_video_id IS NULL').run(
        map.get(v.clip_of.video_id), Number(v.clip_of.start) || 0, Number(v.clip_of.end) || 0, map.get(v.id),
      );
    }
  }

  // Comments, parents before replies; the owner's own comments become the importing account's.
  const cache = new Map();
  const cmap = new Map();
  let comments = 0;
  const list = (Array.isArray(data.comments) ? data.comments : []).filter((c) => c && typeof c.id === 'string' && map.has(c.video_id));
  list.sort((a, b) => fromIso(a.created_at, 0) - fromIso(b.created_at, 0));
  for (const c of list) {
    const key = `${sourceKey}#c:${c.id}`;
    const existing = db.prepare('SELECT id FROM comments WHERE import_key = ?').get(key);
    if (existing) {
      cmap.set(c.id, existing.id);
      continue;
    }
    const body = str(c.body, 2000).trim();
    if (!body) continue;
    const authorId = c.author?.is_owner ? user.id : placeholderFor(c.author || {}, sourceOrigin, cache);
    const parent = c.parent_id ? cmap.get(c.parent_id) || null : null;
    if (c.parent_id && !parent) continue; // its thread didn't come along
    const cid = newId();
    db.prepare("INSERT INTO comments (id, video_id, user_id, parent_id, body, status, hearted, created_at, import_key) VALUES (?, ?, ?, ?, ?, 'visible', ?, ?, ?)").run(
      cid, map.get(c.video_id), authorId, parent, body, c.hearted ? 1 : 0, fromIso(c.created_at, now()), key,
    );
    cmap.set(c.id, cid);
    comments++;
  }
  for (const v of videos) {
    if (v.pinned_comment_id && cmap.has(v.pinned_comment_id) && map.has(v.id)) {
      db.prepare('UPDATE videos SET pinned_comment_id = ? WHERE id = ?').run(cmap.get(v.pinned_comment_id), map.get(v.id));
    }
  }

  const subs = data.subscribers || {};
  const stats = {
    source: { handle: str(data.source?.handle, 200) || null, url: safeUrl(data.source?.channel_url) },
    videos: imported,
    already_here: videos.length - imported - skipped,
    skipped,
    comments,
    subscribers: Number(subs.count) || 0,
    fediverse_followers: Array.isArray(subs.fediverse) ? subs.fediverse.length : 0,
  };
  setImport(id, { status: 'done', progress: 100, stats: JSON.stringify(stats), finished_at: now(), file: null });
  fs.rmSync(file, { force: true });
  notify(user.id, {
    kind: 'move',
    title: `Channel import finished: ${imported} video${imported === 1 ? '' : 's'}, ${comments} comment${comments === 1 ? '' : 's'}`,
    body: imported ? 'The videos are processing now and appear on your channel as they finish.' : null,
    url: `/c/${user.username}`,
    dedupe: `channel-import:${id}`,
  });
}

defineJob('channel.import', {
  lane: 'transfer',
  maxAttempts: 2,
  handler: async ({ id }) => {
    try {
      await runImport(id);
    } catch (e) {
      console.warn(`[transfer] import ${id} failed: ${e.message}`);
      const row = db.prepare('SELECT * FROM channel_imports WHERE id = ?').get(id);
      if (row) {
        setImport(id, { status: 'failed', error: str(e.message, 500), finished_at: now() });
        if (row.file) fs.rmSync(path.join(DIRS.tmp, path.basename(row.file)), { force: true });
        setImport(id, { file: null });
      }
    }
  },
});

const importRow = (r) => {
  let stats = null;
  try {
    stats = r.stats ? JSON.parse(r.stats) : null;
  } catch {}
  return { id: r.id, status: r.status, progress: r.progress, source_url: r.source_url ? r.source_url.replace(/token=[^&]+/, 'token=…') : null, size_bytes: r.size_bytes, stats, error: r.error, created_at: r.created_at, finished_at: r.finished_at };
};

// ---- routes -------------------------------------------------------------------------------------------

export const transferRouter = Router();
transferRouter.use(requireAuth);

transferRouter.get('/channel-exports', (req, res) => {
  const rows = db.prepare('SELECT * FROM channel_exports WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ exports: rows.map(exportRow) });
});

transferRouter.post('/channel-exports', (req, res) => {
  if (db.prepare("SELECT 1 FROM channel_exports WHERE user_id = ? AND status IN ('queued', 'working')").get(req.user.id)) {
    throw new HttpError(409, 'An export is already being prepared');
  }
  const id = newId();
  db.prepare("INSERT INTO channel_exports (id, user_id, status, token, created_at) VALUES (?, ?, 'queued', ?, ?)").run(id, req.user.id, crypto.randomBytes(24).toString('base64url'), now());
  enqueueJob('channel.export', { id }, { dedupe: `channel-export:${id}` });
  res.status(202).json({ export: exportRow(db.prepare('SELECT * FROM channel_exports WHERE id = ?').get(id)) });
});

transferRouter.delete('/channel-exports/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM channel_exports WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
  if (!r) throw new HttpError(404, 'Export not found');
  if (r.file) fs.rmSync(path.join(DIRS.exports, path.basename(r.file)), { force: true });
  db.prepare('DELETE FROM channel_exports WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

transferRouter.get('/channel-exports/:id/download', (req, res) => {
  const r = db.prepare("SELECT * FROM channel_exports WHERE id = ? AND user_id = ? AND status = 'ready'").get(String(req.params.id), req.user.id);
  const full = r?.file && path.join(DIRS.exports, path.basename(r.file));
  if (!full || !fs.existsSync(full)) throw new HttpError(404, 'This export has expired');
  res.download(full, `ourtube-channel-${req.user.username}.tar`);
});

// A channel archive can also go up in pieces (/api/uploads), then be imported by its upload_id.
defineUploadKind('archive', { label: 'Channel archive', extensions: new Set(['.tar']), maxBytes: importMaxBytes });

const archiveStorage = multer.diskStorage({ destination: DIRS.tmp, filename: (req, f, cb) => cb(null, `import-${newId()}.tar`) });
// Built per request, so the size limit follows the settings.
const archiveUpload = () =>
  multer({
    storage: archiveStorage,
    limits: { files: 1, fileSize: importMaxBytes() },
    fileFilter: (req, f, cb) => (/\.tar$/i.test(f.originalname) ? cb(null, true) : cb(new HttpError(400, 'Choose the .tar file from an OurTube channel export'))),
  }).single('archive');

transferRouter.get('/channel-imports', (req, res) => {
  const rows = db.prepare('SELECT * FROM channel_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json({ imports: rows.map(importRow), max_bytes: importMaxBytes() });
});

transferRouter.post('/channel-imports', (req, res, next) => {
  if (db.prepare("SELECT 1 FROM channel_imports WHERE user_id = ? AND status IN ('queued', 'downloading', 'working')").get(req.user.id)) {
    return next(new HttpError(409, 'An import is already running'));
  }
  const start = (fields) => {
    const id = newId();
    db.prepare('INSERT INTO channel_imports (id, user_id, status, source_url, file, size_bytes, apply_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, req.user.id, 'queued', fields.source_url || null, fields.file || null, fields.size || null, fields.apply_profile ? 1 : 0, now(),
    );
    enqueueJob('channel.import', { id }, { dedupe: `channel-import:${id}` });
    res.status(202).json({ import: importRow(db.prepare('SELECT * FROM channel_imports WHERE id = ?').get(id)) });
  };
  if (!req.is('multipart/form-data')) {
    if (req.body?.upload_id) {
      const pieces = finishedUpload(req.body.upload_id, req.user, 'archive');
      const name = `import-${newId()}.tar`;
      fs.renameSync(pieces.path, path.join(DIRS.tmp, name));
      pieces.done();
      return start({ file: name, size: pieces.size, apply_profile: req.body.apply_profile !== false });
    }
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\/\S+$/.test(url)) return next(new HttpError(400, 'Paste the export link from the old site, or upload the .tar file'));
    return start({ source_url: url, apply_profile: req.body?.apply_profile !== false });
  }
  archiveUpload()(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'The archive is larger than this site accepts'));
    if (err) return next(err);
    if (!req.file) return next(new HttpError(400, 'No archive was received'));
    start({ file: path.basename(req.file.path), size: req.file.size, apply_profile: req.body?.apply_profile !== 'false' });
  });
});

transferRouter.delete('/channel-imports/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM channel_imports WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
  if (!r) throw new HttpError(404, 'Import not found');
  if (['queued', 'downloading', 'working'].includes(r.status)) throw new HttpError(409, 'That import is still running');
  db.prepare('DELETE FROM channel_imports WHERE id = ?').run(r.id);
  res.json({ ok: true });
});

/** The private link from an export: lets the new instance download the archive itself. */
export const channelExportPublicRouter = Router();
channelExportPublicRouter.get('/api/channel-exports/:id', (req, res) => {
  const r = db.prepare("SELECT * FROM channel_exports WHERE id = ? AND status = 'ready'").get(String(req.params.id));
  const token = String(req.query.token || '');
  const ok = r && token.length === r.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token)) && (!r.expires_at || r.expires_at > now());
  const full = ok && r.file && path.join(DIRS.exports, path.basename(r.file));
  if (!full || !fs.existsSync(full)) throw new HttpError(404, 'This export link has expired or is wrong');
  res.set('Cache-Control', 'no-store');
  res.download(full, 'ourtube-channel.tar');
});
