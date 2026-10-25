/**
 * Persistent background jobs.
 *
 * Jobs live in the `jobs` table, so they survive restarts. Each job type belongs to a lane with its
 * own concurrency, so a long video encode never holds up network deliveries. Failed attempts are
 * retried with exponential backoff until max_attempts, then marked failed.
 *
 *   defineJob('video.process', { lane: 'media', maxAttempts: 1, handler: async (payload) => {...} })
 *   enqueueJob('video.process', { id }, { dedupe: `process:${id}` })
 */
import { db } from './db.js';

export const LANES = { media: 1, network: 4, default: 2, transfer: 1 };

const handlers = new Map();
const active = Object.fromEntries(Object.keys(LANES).map((l) => [l, 0]));
const runningJobs = new Map(); // id -> job
let started = false;
let timer = null;
let scheduled = false;

/** Default backoff: 30s, 1m, 2m, 4m ... capped at 6h, with up to 20% jitter. */
export function defaultBackoff(attempt) {
  const base = Math.min(30_000 * 2 ** (attempt - 1), 6 * 3600_000);
  return Math.round(base * (1 + Math.random() * 0.2));
}

export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

export function defineJob(type, { lane = 'default', maxAttempts = 5, handler, onFail, backoff = defaultBackoff }) {
  if (!LANES[lane]) throw new Error(`Unknown job lane ${lane}`);
  handlers.set(type, { lane, maxAttempts, handler, onFail, backoff });
}

/**
 * Queues a job. With `dedupe`, a second job with the same key is ignored while the first is still
 * waiting (a running job does not block a new one). Returns the job id, or null if deduplicated.
 */
export function enqueueJob(type, payload = {}, { delay = 0, dedupe = null, maxAttempts } = {}) {
  const def = handlers.get(type);
  const t = Date.now();
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (type, lane, payload, status, attempts, max_attempts, run_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
    )
    .run(type, def?.lane || 'default', JSON.stringify(payload), maxAttempts || def?.maxAttempts || 5, t + delay, dedupe, t, t);
  kick();
  return r.changes ? Number(r.lastInsertRowid) : null;
}

function kick() {
  if (!started || scheduled) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    tick();
  });
}

function claim(lane) {
  const t = Date.now();
  const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND lane = ? AND run_at <= ? ORDER BY run_at, id LIMIT 1").get(lane, t);
  if (!job) return null;
  const r = db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(t, job.id);
  return r.changes ? { ...job, attempts: job.attempts + 1 } : null;
}

async function run(job) {
  const def = handlers.get(job.type);
  let payload = {};
  try {
    payload = JSON.parse(job.payload);
  } catch {}
  runningJobs.set(job.id, job);
  try {
    if (!def) throw new PermanentError(`No handler for job type ${job.type}`);
    await def.handler(payload, job);
    const t = Date.now();
    db.prepare("UPDATE jobs SET status = 'done', last_error = NULL, finished_at = ?, updated_at = ? WHERE id = ?").run(t, t, job.id);
  } catch (e) {
    const t = Date.now();
    const msg = String(e?.message || e).slice(0, 1000);
    if (e?.permanent || job.attempts >= job.max_attempts) {
      db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(msg, t, t, job.id);
      if (job.max_attempts > 1) console.warn(`[jobs] ${job.type} #${job.id} failed after ${job.attempts} attempt(s): ${msg}`);
      try {
        await def?.onFail?.(payload, e, job);
      } catch (err) {
        console.error(`[jobs] onFail for ${job.type} threw: ${err.message}`);
      }
    } else {
      const delay = (def?.backoff || defaultBackoff)(job.attempts);
      try {
        db.prepare("UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(t + delay, msg, t, job.id);
      } catch {
        // An identical job was queued meanwhile (dedupe key): this one is superseded.
        db.prepare("UPDATE jobs SET status = 'done', last_error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(`superseded: ${msg}`, t, t, job.id);
      }
    }
  } finally {
    runningJobs.delete(job.id);
  }
}

function tick() {
  clearTimeout(timer);
  for (const lane of Object.keys(LANES)) {
    while (active[lane] < LANES[lane]) {
      const job = claim(lane);
      if (!job) break;
      active[lane]++;
      run(job).finally(() => {
        active[lane]--;
        kick();
      });
    }
  }
  const next = db.prepare("SELECT MIN(run_at) AS t FROM jobs WHERE status = 'queued'").get().t;
  const wait = next ? Math.max(100, Math.min(60_000, next - Date.now())) : 60_000;
  timer = setTimeout(tick, wait);
  timer.unref?.();
}

/** Starts the workers. Jobs that were running when the server stopped go back in the queue. */
export function startJobs() {
  if (started) return;
  started = true;
  const r = db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(Date.now());
  if (r.changes) console.log(`[jobs] re-queued ${r.changes} job(s) interrupted by the last shutdown`);
  cleanupJobs();
  setInterval(cleanupJobs, 24 * 3600_000).unref();
  tick();
}

export function cleanupJobs() {
  const t = Date.now();
  db.prepare("DELETE FROM jobs WHERE status = 'done' AND finished_at < ?").run(t - 7 * 24 * 3600_000);
  db.prepare("DELETE FROM jobs WHERE status = 'failed' AND finished_at < ?").run(t - 30 * 24 * 3600_000);
}

export function jobStats() {
  const rows = db.prepare('SELECT lane, status, COUNT(*) AS n FROM jobs GROUP BY lane, status').all();
  const lanes = {};
  for (const lane of Object.keys(LANES)) lanes[lane] = { queued: 0, running: 0, failed: 0, done: 0 };
  for (const r of rows) if (lanes[r.lane]) lanes[r.lane][r.status] = r.n;
  return {
    lanes,
    running: [...runningJobs.values()].map((j) => ({ id: j.id, type: j.type, lane: j.lane, attempts: j.attempts })),
    recent_failures: db
      .prepare("SELECT id, type, lane, attempts, last_error, finished_at FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 10")
      .all(),
  };
}

/** True when a job of this type with this dedupe key is queued or running (used for status displays). */
export function jobPending(dedupe) {
  return !!db.prepare("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')").get(dedupe);
}
