/**
 * Extra renditions of a published video, built in the background after processing and after edits:
 *  - HLS for adaptive streaming: the published file itself as the "source" rung (copied without
 *    re-encoding, so full quality is always there and never paywalled) plus a ladder of smaller rungs.
 *    The ladder is an instance setting: off, 720 (720p plus source) or full (1080p, 720p, 480p plus source).
 *  - A ~720p MP4 for federation, for platforms that only cache remote videos under a size limit.
 * The MP4 stays the fallback, the download and what link previews use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings } from './db.js';
import { DIRS } from './config.js';
import { defineJob, enqueueJob } from './jobs.js';
import { encodeWithFallback, ffmpegBin, probe, run } from './media.js';

const LADDERS = { off: [], 720: [720], full: [1080, 720, 480] };
// Target video bitrates in kbps: [high frame rate, 30 fps and below].
const RUNG_KBPS = { 1080: [6000, 4500], 720: [3500, 2500], 480: [1400, 1000] };
const SEGMENT_SECONDS = 4;
const FEDERATION_MAX_BYTES = 40 * 1024 * 1024;

export const hlsLadder = (settings = getSettings()) => LADDERS[settings.hls_ladder] || [];

export function enqueueRenditions(id) {
  return enqueueJob('video.renditions', { id }, { dedupe: `renditions:${id}` });
}

/** Queues renditions for every ready video, after the ladder or the federation setting changes. */
export function enqueueAllRenditions() {
  let n = 0;
  for (const r of db.prepare("SELECT id FROM videos WHERE status = 'ready' AND file_path IS NOT NULL").all()) if (enqueueRenditions(r.id)) n++;
  return n;
}

function filesSize(dir, prefix) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(prefix)) total += fs.statSync(path.join(dir, f)).size;
  return total;
}

function writeMaster(dir, rungs) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of [...rungs].sort((a, b) => a.bandwidth - b.bandwidth)) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(r.bandwidth * 1.25)},AVERAGE-BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height},FRAME-RATE=${r.fps.toFixed(3)},NAME="${r.name}"`,
      `${r.name}.m3u8`,
    );
  }
  fs.writeFileSync(path.join(dir, 'master.m3u8'), `${lines.join('\n')}\n`);
}

function hlsArgs(name) {
  return [
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `${name}-init.mp4`, '-hls_segment_filename', `${name}-%04d.m4s`, `${name}.m3u8`,
  ];
}

export function removeRendition(r) {
  if (!r) return;
  const target = path.join(r.kind === 'hls' ? DIRS.hls : DIRS.renditions, path.basename(r.path));
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
  db.prepare('DELETE FROM renditions WHERE video_id = ? AND kind = ?').run(r.video_id, r.kind);
}

/** Deletes every rendition file of a video (after the video itself was deleted). */
export function removeRenditionFiles(id) {
  for (const dir of [DIRS.hls, DIRS.renditions]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) if (n.startsWith(`${id}-`)) try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {}
  }
}

const stillCurrent = (id, version) => db.prepare('SELECT 1 FROM videos WHERE id = ? AND edit_version = ? AND status = ?').get(id, version, 'ready');

async function buildHls(v, input, info, version, settings) {
  const existing = db.prepare("SELECT * FROM renditions WHERE video_id = ? AND kind = 'hls'").get(v.id);
  if (settings.hls_ladder === 'off' || !LADDERS[settings.hls_ladder]) {
    removeRendition(existing);
    return;
  }
  const meta = existing ? JSON.parse(existing.meta || '{}') : null;
  if (existing && existing.edit_version === version && meta?.ladder === settings.hls_ladder) return;

  const name = `${v.id}-v${version}`;
  const dir = path.join(DIRS.hls, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const fps = info.fps || 30;
  const rungs = [];
  try {
    await run(ffmpegBin, ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', ...hlsArgs('source')], { cwd: dir });
    const sourceBits = (filesSize(dir, 'source-') * 8) / Math.max(1, info.duration);
    rungs.push({ name: 'source', width: info.width, height: info.height, fps, bandwidth: Math.round(sourceBits) });
    for (const h of hlsLadder(settings).filter((x) => x < info.height)) {
      const outFps = h <= 480 ? Math.min(fps, 30) : fps;
      const kbps = RUNG_KBPS[h][outFps > 31 ? 0 : 1];
      const gop = Math.max(1, Math.round(outFps * SEGMENT_SECONDS));
      const rung = `${h}p`;
      await encodeWithFallback(
        settings,
        (enc) => [
          '-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale=-2:${h}${outFps < fps ? `,fps=${outFps}` : ''}`,
          ...enc, '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.1)}k`, '-bufsize', `${kbps * 2}k`,
          '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2', ...hlsArgs(rung),
        ],
        null,
        { cwd: dir },
      );
      const bits = (filesSize(dir, `${rung}-`) * 8) / Math.max(1, info.duration);
      rungs.push({ name: rung, width: Math.round((info.width * h) / info.height / 2) * 2, height: h, fps: outFps, bandwidth: Math.round(bits) });
    }
    writeMaster(dir, rungs);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  if (!stillCurrent(v.id, version)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const size = filesSize(dir, '');
  db.prepare(
    `INSERT INTO renditions (video_id, kind, edit_version, path, height, size_bytes, meta, created_at) VALUES (?, 'hls', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id, kind) DO UPDATE SET edit_version = excluded.edit_version, path = excluded.path, height = excluded.height,
       size_bytes = excluded.size_bytes, meta = excluded.meta, created_at = excluded.created_at`,
  ).run(v.id, version, name, info.height, size, JSON.stringify({ ladder: settings.hls_ladder, rungs }), Date.now());
  if (existing && existing.path !== name) try { fs.rmSync(path.join(DIRS.hls, existing.path), { recursive: true, force: true }); } catch {}
  console.log(`[renditions] ${v.id}: HLS ${rungs.map((r) => r.name).join(', ')} (${(size / 1048576).toFixed(1)} MB)`);
}

async function buildFederation(v, input, info, version, settings) {
  const existing = db.prepare("SELECT * FROM renditions WHERE video_id = ? AND kind = 'federation'").get(v.id);
  const needed = settings.federation_rendition === 'true' && (info.height > 720 || fs.statSync(input).size > FEDERATION_MAX_BYTES);
  if (!needed) {
    removeRendition(existing);
    return;
  }
  if (existing && existing.edit_version === version) return;
  const name = `${v.id}-v${version}-720.mp4`;
  const tmp = path.join(DIRS.tmp, name);
  const fps = Math.min(info.fps || 30, 60);
  await encodeWithFallback(settings, (enc) => [
    '-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:'min(720,ih)'${(info.fps || 30) > 60 ? ',fps=60' : ''}`,
    ...enc, '-maxrate', fps > 31 ? '3000k' : '2200k', '-bufsize', '5000k', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp,
  ]);
  if (!stillCurrent(v.id, version)) {
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  fs.renameSync(tmp, path.join(DIRS.renditions, name));
  const size = fs.statSync(path.join(DIRS.renditions, name)).size;
  db.prepare(
    `INSERT INTO renditions (video_id, kind, edit_version, path, height, size_bytes, created_at) VALUES (?, 'federation', ?, ?, ?, ?, ?)
     ON CONFLICT(video_id, kind) DO UPDATE SET edit_version = excluded.edit_version, path = excluded.path, height = excluded.height,
       size_bytes = excluded.size_bytes, created_at = excluded.created_at`,
  ).run(v.id, version, name, Math.min(720, info.height), size, Date.now());
  if (existing && existing.path !== name) try { fs.unlinkSync(path.join(DIRS.renditions, existing.path)); } catch {}
}

defineJob('video.renditions', {
  lane: 'media',
  maxAttempts: 2,
  handler: async ({ id }) => {
    const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    if (!v || v.status !== 'ready' || !v.file_path) return;
    const input = path.join(DIRS.videos, v.file_path);
    if (!fs.existsSync(input)) return;
    const settings = getSettings();
    const info = await probe(input);
    const version = v.edit_version || 0;
    await buildHls(v, input, info, version, settings);
    await buildFederation(v, input, info, version, settings);
  },
});

/** Public URLs for a video's current renditions (null when not built for this version). */
export function renditionUrls(v) {
  const out = { hls_url: null, federation_url: null, hls_rungs: null };
  for (const r of db.prepare('SELECT * FROM renditions WHERE video_id = ? AND edit_version = ?').all(v.id, v.edit_version || 0)) {
    if (r.kind === 'hls') {
      out.hls_url = `/media/hls/${r.path}/master.m3u8`;
      try {
        out.hls_rungs = JSON.parse(r.meta || '{}').rungs?.map((x) => ({ name: x.name, height: x.height, fps: Math.round(x.fps) })) || null;
      } catch {}
    }
    if (r.kind === 'federation') out.federation_url = `/media/renditions/${r.path}`;
  }
  return out;
}
