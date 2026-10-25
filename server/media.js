import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { db, getSettings } from './db.js';
import { DIRS } from './config.js';
import { onLocalVideosChanged } from './network.js';
import { defineJob, enqueueJob, jobStats, jobPending } from './jobs.js';

// Bundled binaries by default; set FFMPEG_PATH / FFPROBE_PATH to use a system build (e.g. one with NVENC).
export const ffmpegBin = process.env.FFMPEG_PATH || ffmpegPath;
export const ffprobeBin = process.env.FFPROBE_PATH || ffprobeStatic.path;

export function run(bin, args, { onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (onStdoutLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onStdoutLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      } else {
        stdout += s;
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
      reject(new Error(`${path.basename(bin)} exited with code ${code}: ${tail}`));
    });
  });
}

export async function probe(file) {
  const { stdout } = await run(ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream found in this file');

  const duration = parseFloat(info.format?.duration) || parseFloat(video.duration) || 0;
  let width = video.width || 0;
  let height = video.height || 0;
  const rotation = Number(video.tags?.rotate || 0) || (video.side_data_list || []).find((s) => s.rotation)?.rotation || 0;
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  let fps = 0;
  for (const r of [video.avg_frame_rate, video.r_frame_rate]) {
    const [a, b] = String(r || '').split('/').map(Number);
    if (a && b && a / b > 1 && a / b < 400) {
      fps = a / b;
      break;
    }
  }
  return {
    duration, width, height, fps,
    vcodec: video.codec_name,
    acodec: audio?.codec_name || null,
    pix_fmt: video.pix_fmt || '',
    format: info.format?.format_name || '',
    size: Number(info.format?.size) || 0,
  };
}

export async function makeThumbnail(input, output, seek) {
  await run(ffmpegBin, ['-y', '-v', 'error', '-ss', String(seek), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', output]);
}

/** Grabs the exact frame at `t` seconds as a thumbnail-sized JPEG. */
export async function grabFrame(input, t, output) {
  await run(ffmpegBin, ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', input, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', output]);
}

/** Normalise an uploaded image: thumbnails become 1280-wide JPEGs, avatars 256x256 squares. */
export async function convertImage(input, output, kind) {
  const vf = kind === 'avatar'
    ? 'scale=256:256:force_original_aspect_ratio=increase,crop=256:256'
    : kind === 'cover'
      ? 'scale=600:800:force_original_aspect_ratio=increase,crop=600:800'
      : "scale='min(1280,iw)':-2";
  await run(ffmpegBin, ['-y', '-v', 'error', '-i', input, '-frames:v', '1', '-vf', vf, '-q:v', '3', output]);
}

function parseOutTime(line) {
  const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const WEB_AUDIO = new Set(['aac', 'mp3']);

function needsTranscode(info, maxHeight) {
  if (info.vcodec !== 'h264') return true;
  if (info.pix_fmt && info.pix_fmt !== 'yuv420p') return true;
  if (info.acodec && !WEB_AUDIO.has(info.acodec)) return true;
  if (info.height > maxHeight) return true;
  return false;
}

function encoderArgs(enc) {
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-profile:v', 'high'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-global_quality', '23', '-preset', 'medium'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];
  }
}

/** Runs an encode with the configured encoder, falling back to libx264 if a hardware encoder fails. */
export async function encodeWithFallback(settings, buildArgs, onLine) {
  const encoders = [settings.encoder || 'libx264'];
  if (!encoders.includes('libx264')) encoders.push('libx264');
  let lastErr;
  for (const enc of encoders) {
    try {
      await run(ffmpegBin, buildArgs(encoderArgs(enc)), { onStdoutLine: onLine });
      return enc;
    } catch (e) {
      lastErr = e;
      const last = encoders.indexOf(enc) === encoders.length - 1;
      console.warn(`[media] encoder ${enc} failed, ${last ? 'giving up' : 'falling back to libx264'}: ${e.message}`);
    }
  }
  throw lastErr;
}

export function progressReader(total, onProgress) {
  return (line) => {
    const t = parseOutTime(line);
    if (t != null && total > 0) onProgress?.(Math.min(99, Math.round((t / total) * 100)));
  };
}

export function throttledWriter(write) {
  let last = -1;
  let lastAt = 0;
  return (p) => {
    const t = Date.now();
    if (p !== last && t - lastAt > 700) {
      last = p;
      lastAt = t;
      write(p);
    }
  };
}

/**
 * Produce a browser friendly MP4. If the source is already H.264/AAC we just remux
 * (lossless, takes seconds), otherwise we transcode with the configured encoder.
 */
export async function transcode(input, output, info, settings, onProgress) {
  const maxHeight = Number(settings.max_height) || 1080;
  const base = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  const tail = ['-movflags', '+faststart', '-f', 'mp4', output];
  const onLine = progressReader(info.duration, onProgress);

  if (!needsTranscode(info, maxHeight)) {
    await run(ffmpegBin, [...base, '-c', 'copy', ...tail], { onStdoutLine: onLine });
    return { copied: true, encoder: 'copy' };
  }
  const vf = info.height > maxHeight ? ['-vf', `scale=-2:${maxHeight}`] : [];
  const audio = info.acodec ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : [];
  const encoder = await encodeWithFallback(settings, (enc) => [...base, ...vf, ...enc, '-pix_fmt', 'yuv420p', ...audio, ...tail], onLine);
  return { copied: false, encoder };
}

// ---- edit rendering -----------------------------------------------------------

/**
 * Builds the ffmpeg command for an edit decision list. Each kept segment is opened as its own
 * input with an accurate seek, padded/trimmed to an exact length so audio and video stay in sync,
 * then everything is concatenated and the volume and fades are applied.
 */
function renderArgs(src, out, info, edit, settings, encArgs) {
  const segs = edit.segments;
  const hasAudio = !!info.acodec && !edit.muted;
  const total = segs.reduce((s, x) => s + (x.end - x.start), 0);
  const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
  for (const s of segs) args.push('-ss', s.start.toFixed(3), '-t', (s.end - s.start).toFixed(3), '-i', src);

  const graph = [];
  let concatIn = '';
  segs.forEach((s, i) => {
    const d = (s.end - s.start).toFixed(3);
    graph.push(`[${i}:v:0]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=0.2,trim=duration=${d},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) graph.push(`[${i}:a:0]asetpts=PTS-STARTPTS,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
    concatIn += hasAudio ? `[v${i}][a${i}]` : `[v${i}]`;
  });
  graph.push(`${concatIn}concat=n=${segs.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? '[ac]' : ''}`);

  const maxHeight = Number(settings.max_height) || 1080;
  const fadeIn = Math.min(edit.fade_in || 0, total / 2);
  const fadeOut = Math.min(edit.fade_out || 0, total / 2);
  const vf = [];
  if (info.height > maxHeight) vf.push(`scale=-2:${maxHeight}`);
  if (fadeIn > 0) vf.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) vf.push(`fade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  vf.push('format=yuv420p');
  graph.push(`[vc]${vf.join(',')}[vout]`);

  if (hasAudio) {
    const af = [];
    if (Math.abs((edit.volume ?? 1) - 1) > 0.001) af.push(`volume=${(edit.volume ?? 1).toFixed(3)}`);
    if (fadeIn > 0) af.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    if (fadeOut > 0) af.push(`afade=t=out:st=${(total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    graph.push(`[ac]${af.length ? af.join(',') : 'anull'}[aout]`);
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (hasAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push(...encArgs, '-movflags', '+faststart', '-f', 'mp4', out);
  return { args, total };
}

async function renderEdit(id) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v || !v.edit_json || v.status !== 'ready') return;
  const version = v.edit_version;
  const edit = JSON.parse(v.edit_json);
  const src = v.base_path ? path.join(DIRS.videos, v.base_path) : null;
  if (!src || !fs.existsSync(src)) throw new Error('The source file for editing is missing');

  db.prepare("UPDATE videos SET render_status = 'rendering', render_progress = 0, render_error = NULL WHERE id = ?").run(id);
  const settings = getSettings();
  const info = await probe(src);
  const tmp = path.join(DIRS.tmp, `${id}.render-${version}.mp4`);
  const write = throttledWriter((p) => db.prepare('UPDATE videos SET render_progress = ? WHERE id = ? AND edit_version = ?').run(p, id, version));
  let total = 0;
  const encoder = await encodeWithFallback(
    settings,
    (enc) => {
      const r = renderArgs(src, tmp, info, edit, settings, enc);
      total = r.total;
      return r.args;
    },
    (line) => progressReader(total, write)(line),
  );

  // Deleted, reverted or re-edited while we were rendering: throw this result away.
  const cur = db.prepare('SELECT edit_version, file_path, base_path FROM videos WHERE id = ?').get(id);
  if (!cur || cur.edit_version !== version) {
    try { fs.unlinkSync(tmp); } catch {}
    return;
  }
  const outName = `${id}-e${version}.mp4`;
  fs.renameSync(tmp, path.join(DIRS.videos, outName));
  let duration = total;
  try { duration = (await probe(path.join(DIRS.videos, outName))).duration || total; } catch {}
  const size = fs.statSync(path.join(DIRS.videos, outName)).size;
  db.prepare(
    'UPDATE videos SET file_path = ?, duration = ?, size_bytes = ?, render_status = NULL, render_progress = 100, render_error = NULL, updated_at = ? WHERE id = ?',
  ).run(outName, duration, size, Date.now(), id);
  if (cur.file_path && cur.file_path !== cur.base_path && cur.file_path !== outName) {
    try { fs.unlinkSync(path.join(DIRS.videos, cur.file_path)); } catch {}
  }
  console.log(`[media] ${id}: edit v${version} rendered (${encoder}, ${edit.segments.length} part(s), ${duration.toFixed(1)}s)`);
  onLocalVideosChanged();
}

// ---- processing jobs (persistent, see jobs.js) ---------------------------------------

defineJob('video.process', {
  lane: 'media',
  maxAttempts: 1, // a failed encode needs a person to look at it; the Retry button re-queues
  handler: ({ id }) => processVideo(id),
  onFail: ({ id }, e) => {
    console.error(`[media] processing ${id} failed: ${e.message}`);
    db.prepare("UPDATE videos SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 1000), id);
  },
});

defineJob('video.render', {
  lane: 'media',
  maxAttempts: 1,
  handler: ({ id }) => renderEdit(id),
  onFail: ({ id }, e) => {
    console.error(`[media] render ${id} failed: ${e.message}`);
    db.prepare("UPDATE videos SET render_status = 'failed', render_error = ? WHERE id = ?").run(String(e.message).slice(0, 1000), id);
  },
});

export const enqueue = (id) => enqueueJob('video.process', { id }, { dedupe: `process:${id}` });
// A running render may be stale (renderEdit discards it by version), so only waiting renders are deduplicated.
export const enqueueRender = (id) => enqueueJob('video.render', { id }, { dedupe: `render:${id}` });

export function queueInfo() {
  const s = jobStats();
  const media = s.running.find((j) => j.lane === 'media');
  return { waiting: s.lanes.media.queued, current: media ? `${media.type} #${media.id}` : null, jobs: s };
}

export async function processVideo(id) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v || v.status === 'ready') return;
  const settings = getSettings();
  const input = v.original_path ? path.join(DIRS.originals, v.original_path) : null;
  if (!input || !fs.existsSync(input)) throw new Error('Original file is missing');

  db.prepare("UPDATE videos SET status = 'processing', progress = 0, error = NULL WHERE id = ?").run(id);
  const info = await probe(input);
  db.prepare('UPDATE videos SET duration = ?, width = ?, height = ?, fps = ? WHERE id = ?').run(info.duration, info.width, info.height, info.fps, id);

  if (!v.thumb_path) {
    const thumbName = `${id}.jpg`;
    const seek = info.duration > 2 ? Math.min(info.duration * 0.2, 10) : 0;
    try {
      await makeThumbnail(input, path.join(DIRS.thumbs, thumbName), seek);
      db.prepare('UPDATE videos SET thumb_path = ? WHERE id = ? AND thumb_path IS NULL').run(thumbName, id);
    } catch (e) {
      console.warn(`[media] thumbnail failed for ${id}: ${e.message}`);
    }
  }

  const outName = `${id}.mp4`;
  const outTmp = path.join(DIRS.tmp, `${id}.processing.mp4`);
  const outFinal = path.join(DIRS.videos, outName);
  console.log(`[media] ${id}: ${info.vcodec}/${info.acodec || 'no audio'} ${info.width}x${info.height} ${Math.round(info.fps)}fps ${Math.round(info.duration)}s`);

  const write = throttledWriter((p) => db.prepare('UPDATE videos SET progress = ? WHERE id = ?').run(p, id));
  const result = await transcode(input, outTmp, info, settings, write);

  // The video may have been deleted while we were encoding.
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id)) {
    try { fs.unlinkSync(outTmp); } catch {}
    return;
  }

  fs.renameSync(outTmp, outFinal);
  const size = fs.statSync(outFinal).size;
  let duration = info.duration;
  let outInfo = null;
  try {
    outInfo = await probe(outFinal);
    duration = outInfo.duration || duration;
  } catch {}

  const t = Date.now();
  db.prepare(
    `UPDATE videos SET status = 'ready', progress = 100, file_path = ?, base_path = ?, base_duration = ?, size_bytes = ?, duration = ?,
       width = ?, height = ?, fps = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`,
  ).run(outName, outName, duration, size, duration, outInfo?.width || info.width, outInfo?.height || info.height, outInfo?.fps || info.fps, t, t, id);

  // A remux is lossless, so the original is redundant. Transcodes keep the original unless configured otherwise.
  if (result.copied || settings.delete_originals === 'true') {
    try {
      fs.unlinkSync(input);
      db.prepare('UPDATE videos SET original_path = NULL WHERE id = ?').run(id);
    } catch {}
  }
  console.log(`[media] ${id}: ready (${result.encoder}, ${(size / 1048576).toFixed(1)} MB)`);
  onLocalVideosChanged();
}

/**
 * Jobs are persistent now, so this only catches videos left waiting without a job (for example
 * from a version before the job queue existed).
 */
export function resumePending() {
  let n = 0;
  for (const r of db.prepare("SELECT id FROM videos WHERE status IN ('queued', 'processing') ORDER BY created_at").all()) {
    // Clips are cut by their own job, which then processes them.
    if (!jobPending(`process:${r.id}`) && !jobPending(`clip:${r.id}`)) {
      enqueue(r.id);
      n++;
    }
  }
  for (const r of db.prepare("SELECT id FROM videos WHERE render_status IN ('queued', 'rendering') ORDER BY updated_at").all()) {
    if (!jobPending(`render:${r.id}`)) {
      enqueueRender(r.id);
      n++;
    }
  }
  if (n) console.log(`[media] queued ${n} video job(s) that had no job`);
}

export function ffmpegInfo() {
  return { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
}

// ---- editor assets (filmstrip sprite + audio waveform) ----------------------------

export function editorDir(id) {
  return path.join(DIRS.editor, id);
}

const assetJobs = new Map(); // id -> { error }
let assetChain = Promise.resolve();

/** Returns the editor assets for a video, starting a background build if they don't exist yet. */
export function editorAssets(v) {
  const metaFile = path.join(editorDir(v.id), 'meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta.base === v.base_path) return { status: 'ready', meta };
  } catch {}
  const job = assetJobs.get(v.id);
  if (job?.error) {
    assetJobs.delete(v.id); // let the next request retry
    return { status: 'failed', error: job.error };
  }
  if (!job) {
    const entry = {};
    assetJobs.set(v.id, entry);
    assetChain = assetChain
      .then(() => buildEditorAssets(v))
      .then(() => assetJobs.delete(v.id))
      .catch((e) => {
        console.error(`[media] editor assets for ${v.id} failed: ${e.message}`);
        entry.error = e.message;
      });
  }
  return { status: 'building' };
}

async function buildEditorAssets(v) {
  const src = path.join(DIRS.videos, v.base_path);
  const dir = editorDir(v.id);
  fs.mkdirSync(dir, { recursive: true });
  const info = await probe(src);
  const duration = info.duration || v.base_duration || v.duration || 1;

  // Filmstrip: up to ~120 frames tiled into one JPEG sprite.
  const interval = Math.max(0.5, duration / 120);
  const count = Math.max(1, Math.ceil(duration / interval));
  const th = 72;
  const tw = Math.max(32, Math.round((th * (info.width || 16)) / (info.height || 9) / 2) * 2);
  const cols = 10;
  const rows = Math.ceil((count + 1) / cols);
  const spriteTmp = path.join(dir, 'sprite.tmp.jpg');
  const pre = duration > 300 ? ['-skip_frame', 'nokey'] : [];
  await run(ffmpegBin, [
    '-y', '-v', 'error', ...pre, '-i', src, '-an', '-sn',
    '-vf', `fps=${(1 / interval).toFixed(6)},scale=${tw}:${th},tile=${cols}x${rows}`,
    '-frames:v', '1', '-q:v', '5', spriteTmp,
  ]);
  fs.renameSync(spriteTmp, path.join(dir, 'sprite.jpg'));

  // Waveform: peak amplitude per bucket, from 8 kHz mono PCM streamed out of ffmpeg.
  const peaks = [];
  let pps = 0;
  if (info.acodec) {
    pps = Math.max(10, Math.min(100, Math.floor(20000 / Math.max(1, duration))));
    const perBucket = 8000 / pps;
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegBin, ['-v', 'error', '-i', src, '-vn', '-sn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
      let max = 0;
      let n = 0;
      let bucketEnd = perBucket;
      let carry = null;
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        let b = carry ? Buffer.concat([carry, chunk]) : chunk;
        carry = null;
        const usable = b.length - (b.length % 2);
        if (usable < b.length) carry = b.subarray(usable);
        for (let i = 0; i < usable; i += 2) {
          const s = Math.abs(b.readInt16LE(i));
          if (s > max) max = s;
          if (++n >= bucketEnd) {
            peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
            max = 0;
            bucketEnd += perBucket;
          }
        }
      });
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (n > bucketEnd - perBucket) peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
        code === 0 ? resolve() : reject(new Error(`waveform extraction failed: ${stderr.trim().split('\n').pop()}`));
      });
    });
  }
  fs.writeFileSync(path.join(dir, 'waveform.json'), JSON.stringify({ pps, peaks }));

  const meta = {
    base: v.base_path,
    duration,
    fps: info.fps || 30,
    width: info.width,
    height: info.height,
    has_audio: !!info.acodec,
    sprite: { interval, count, cols, rows, tw, th },
    waveform: { pps, length: peaks.length },
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  console.log(`[media] ${v.id}: editor assets ready (${count} frames, ${peaks.length} peaks)`);
}
