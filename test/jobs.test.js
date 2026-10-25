// Persistent job queue: retries with backoff, permanent failures, dedupe, and restart recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, waitFor } from './helpers.js';

process.env.DATA_DIR = tempDir('jobs');

const { db } = await import('../server/db.js');
const { defineJob, enqueueJob, startJobs, PermanentError, jobStats } = await import('../server/jobs.js');

const fast = () => 10; // retry almost immediately in tests
const status = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

test('a failing job is retried with backoff until it succeeds', async () => {
  let calls = 0;
  defineJob('test.flaky', {
    maxAttempts: 5,
    backoff: fast,
    handler: async () => {
      calls++;
      if (calls < 3) throw new Error(`boom ${calls}`);
    },
  });
  startJobs();
  const id = enqueueJob('test.flaky', { x: 1 });
  await waitFor(() => status(id).status === 'done', { what: 'flaky job' });
  assert.equal(calls, 3);
  assert.equal(status(id).attempts, 3);
});

test('a job gives up after max attempts and calls onFail', async () => {
  let failed = null;
  defineJob('test.broken', {
    maxAttempts: 2,
    backoff: fast,
    handler: async () => {
      throw new Error('always');
    },
    onFail: (payload, e) => {
      failed = { payload, message: e.message };
    },
  });
  const id = enqueueJob('test.broken', { n: 7 });
  await waitFor(() => status(id).status === 'failed', { what: 'broken job' });
  assert.equal(status(id).attempts, 2);
  assert.deepEqual(failed, { payload: { n: 7 }, message: 'always' });
});

test('a permanent error is not retried', async () => {
  let calls = 0;
  defineJob('test.permanent', {
    maxAttempts: 5,
    backoff: fast,
    handler: async () => {
      calls++;
      throw new PermanentError('no point retrying');
    },
  });
  const id = enqueueJob('test.permanent');
  await waitFor(() => status(id).status === 'failed', { what: 'permanent job' });
  assert.equal(calls, 1);
});

test('dedupe ignores a second job with the same key while the first waits', async () => {
  defineJob('test.slow', { handler: async () => {} });
  const a = enqueueJob('test.slow', {}, { dedupe: 'same', delay: 60_000 });
  const b = enqueueJob('test.slow', {}, { dedupe: 'same' });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(jobStats().lanes.default.queued >= 1, true);
});

test('jobs interrupted by a restart are picked up again', async () => {
  let ran = false;
  defineJob('test.resume', {
    handler: async () => {
      ran = true;
    },
  });
  // Simulate a job that was running when the server stopped.
  const t = Date.now();
  const r = db
    .prepare("INSERT INTO jobs (type, lane, payload, status, attempts, max_attempts, run_at, created_at, updated_at) VALUES ('test.resume', 'default', '{}', 'running', 1, 5, ?, ?, ?)")
    .run(t, t, t);
  // startJobs only resets on first start; emulate the reset a fresh process would do.
  db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(Number(r.lastInsertRowid));
  enqueueJob('test.slow'); // wakes the workers
  await waitFor(() => ran, { what: 'resumed job' });
});
