// Shared helpers for the integration tests: real server instances, an HTTP client with cookies,
// and small generated video clips.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(fn, { timeout = 20000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

export function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cliptube-${name}-`));
}

/** Starts a real ClipTube server on a free port with its own temporary data folder. */
export async function startInstance(name = 'test', { env = {}, args = [], allowPrivate = true } = {}) {
  const port = await freePort();
  const dataDir = tempDir(name);
  const child = spawn(process.execPath, ['server/index.js', '--port', String(port), ...(allowPrivate ? ['--allow-private-federation'] : []), ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, SETUP_CODE: 'testcode', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(`${url}/api/site`)).ok, { what: `${name} to start` });
  } catch (e) {
    child.kill();
    throw new Error(`${e.message}\n--- ${name} log ---\n${log}`);
  }
  return {
    name,
    url,
    port,
    dataDir,
    log: () => log,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Minimal fetch client that keeps a session cookie. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async req(method, p, body, { form } = {}) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + p, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair.startsWith('ct_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, ok: res.ok };
  }

  get(p) {
    return this.req('GET', p);
  }
  post(p, b = {}) {
    return this.req('POST', p, b);
  }
  patch(p, b = {}) {
    return this.req('PATCH', p, b);
  }
  del(p, b) {
    return this.req('DELETE', p, b);
  }

  async upload(file, fields = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    return this.req('POST', '/api/videos', undefined, { form });
  }
}

/** Registers the first account (admin) on a fresh instance and returns a logged-in client. */
export async function setupAdmin(inst, username = 'admin', siteName) {
  const c = new Client(inst.url);
  const r = await c.post('/api/auth/register', { username, password: `${username}-pass-1`, setup_code: 'testcode', display_name: username });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  if (siteName) await c.patch('/api/admin/settings', { site_name: siteName });
  return c;
}

export async function registerUser(inst, username) {
  const c = new Client(inst.url);
  const r = await c.post('/api/auth/register', { username, password: `${username}-pass-1` });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  return c;
}

const clipCache = path.join(os.tmpdir(), 'cliptube-test-clips');

/** Generates (once, cached) a small test clip: 'h264' (remux path), 'vp9' (transcode path) or 'hd' (1080p60 H.264). */
export function testClip(kind = 'h264') {
  fs.mkdirSync(clipCache, { recursive: true });
  const file = path.join(clipCache, { vp9: 'clip-vp9.webm', hd: 'clip-hd.mp4', vertical: 'clip-vertical.mp4' }[kind] || 'clip-h264.mp4');
  if (fs.existsSync(file)) return file;
  const size = kind === 'hd' ? 'size=1920x1080:rate=60' : kind === 'vertical' ? 'size=240x426:rate=30' : 'size=320x240:rate=30';
  const common = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=${size}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', kind === 'hd' ? '3' : '4'];
  const codec =
    kind === 'vp9'
      ? ['-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  execFileSync(ffmpegPath, [...common, ...codec, '-shortest', file], { stdio: 'ignore' });
  return file;
}

/** Uploads a clip and waits until it is processed. Returns the video. */
export async function uploadReady(client, fields = {}, kind = 'h264') {
  const r = await client.upload(testClip(kind), { visibility: 'public', ...fields });
  if (r.status !== 201) throw new Error(`upload failed: ${JSON.stringify(r.data)}`);
  const id = r.data.video.id;
  return waitFor(
    async () => {
      const v = (await client.get(`/api/videos/${id}`)).data.video;
      if (v.status === 'failed') throw new Error(`processing failed: ${v.error}`);
      return v.status === 'ready' ? v : null;
    },
    { timeout: 60000, what: `video ${id} to process` },
  );
}
