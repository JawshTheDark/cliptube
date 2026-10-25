import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { db, getSettings } from './db.js';
import { DIRS } from './config.js';

// Bundled binaries by default; set FFMPEG_PATH / FFPROBE_PATH to use a system build (e.g. one with NVENC).
const ffmpegBin = process.env.FFMPEG_PATH || ffmpegPath;
const ffprobeBin = process.env.FFPROBE_PATH || ffprobeStatic.path;

function run(bin, args, { onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdoutLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onStdoutLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
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
  const { stdout } = await run(ffprobeBin,['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
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
  if (video.r_frame_rate) {
    const [a, b] = video.r_frame_rate.split('/').map(Number);
    if (a && b) fps = a / b;
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
  await run(ffmpegBin,['-y', '-v', 'error', '-ss', String(seek), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', output]);
}

/** Normalise an uploaded image: thumbnails become 1280-wide JPEGs, avatars 256x256 squares. */
export async function convertImage(input, output, kind) {
  const vf = kind === 'avatar'
    ? 'scale=256:256:force_original_aspect_ratio=increase,crop=256:256'
    : "scale='min(1280,iw)':-2";
  await run(ffmpegBin,['-y', '-v', 'error', '-i', input, '-frames:v', '1', '-vf', vf, '-q:v', '3', output]);
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
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-profile:v', 'high'];
  }
}

/**
 * Produce a browser friendly MP4. If the source is already H.264/AAC we just remux
 * (lossless, takes seconds), otherwise we transcode with the configured encoder and
 * fall back to libx264 if a hardware encoder is not available.
 */
export async function transcode(input, output, info, settings, onProgress) {
  const maxHeight = Number(settings.max_height) || 1080;
  const base = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
  const tail = ['-movflags', '+faststart', '-f', 'mp4', output];
  const onLine = (line) => {
    const t = parseOutTime(line);
    if (t != null && info.duration > 0) onProgress?.(Math.min(99, Math.round((t / info.duration) * 100)));
  };

  if (!needsTranscode(info, maxHeight)) {
    await run(ffmpegBin,[...base, '-c', 'copy', ...tail], { onStdoutLine: onLine });
    return { copied: true, encoder: 'copy' };
  }

  const vf = info.height > maxHeight ? ['-vf', `scale=-2:${maxHeight}`] : [];
  const audio = info.acodec ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : [];
  const encoders = [settings.encoder || 'libx264'];
  if (!encoders.includes('libx264')) encoders.push('libx264');

  let lastErr;
  for (const enc of encoders) {
    try {
      await run(ffmpegBin,[...base, ...vf, ...encoderArgs(enc), '-pix_fmt', 'yuv420p', ...audio, ...tail], { onStdoutLine: onLine });
      return { copied: false, encoder: enc };
    } catch (e) {
      lastErr = e;
      const last = encoders.indexOf(enc) === encoders.length - 1;
      console.warn(`[media] encoder ${enc} failed, ${last ? 'giving up' : 'falling back to libx264'}: ${e.message}`);
    }
  }
  throw lastErr;
}

// ---- processing queue -------------------------------------------------------

const queue = [];
let running = false;
let current = null;

export function queueInfo() {
  return { waiting: queue.length, current };
}

export function enqueue(videoId) {
  if (!queue.includes(videoId) && current !== videoId) queue.push(videoId);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    current = id;
    try {
      await processVideo(id);
    } catch (e) {
      console.error(`[media] processing ${id} failed: ${e.message}`);
      db.prepare("UPDATE videos SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 1000), id);
    }
    current = null;
  }
  running = false;
}

async function processVideo(id) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!v || v.status === 'ready') return;
  const settings = getSettings();
  const input = v.original_path ? path.join(DIRS.originals, v.original_path) : null;
  if (!input || !fs.existsSync(input)) throw new Error('Original file is missing');

  db.prepare("UPDATE videos SET status = 'processing', progress = 0, error = NULL WHERE id = ?").run(id);
  const info = await probe(input);
  db.prepare('UPDATE videos SET duration = ?, width = ?, height = ? WHERE id = ?').run(info.duration, info.width, info.height, id);

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

  let lastProgress = -1;
  let lastWrite = 0;
  const result = await transcode(input, outTmp, info, settings, (p) => {
    const t = Date.now();
    if (p !== lastProgress && t - lastWrite > 700) {
      lastProgress = p;
      lastWrite = t;
      db.prepare('UPDATE videos SET progress = ? WHERE id = ?').run(p, id);
    }
  });

  // The video may have been deleted while we were encoding.
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id)) {
    try { fs.unlinkSync(outTmp); } catch {}
    return;
  }

  fs.renameSync(outTmp, outFinal);
  const size = fs.statSync(outFinal).size;
  let duration = info.duration;
  try { duration = (await probe(outFinal)).duration || duration; } catch {}

  db.prepare(
    "UPDATE videos SET status = 'ready', progress = 100, file_path = ?, size_bytes = ?, duration = ?, published_at = COALESCE(published_at, ?) WHERE id = ?",
  ).run(outName, size, duration, Date.now(), id);

  // A remux is lossless, so the original is redundant. Transcodes keep the original unless configured otherwise.
  if (result.copied || settings.delete_originals === 'true') {
    try {
      fs.unlinkSync(input);
      db.prepare('UPDATE videos SET original_path = NULL WHERE id = ?').run(id);
    } catch {}
  }
  console.log(`[media] ${id}: ready (${result.encoder}, ${(size / 1048576).toFixed(1)} MB)`);
}

/** Re-queue anything that was mid-flight when the server last stopped. */
export function resumePending() {
  const rows = db.prepare("SELECT id FROM videos WHERE status IN ('queued', 'processing') ORDER BY created_at").all();
  for (const r of rows) enqueue(r.id);
  if (rows.length) console.log(`[media] resumed ${rows.length} pending job(s)`);
}

export function ffmpegInfo() {
  return { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
}
