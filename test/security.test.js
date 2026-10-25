// Abuse limits on accounts: password guessing and mass sign-ups from one address are slowed down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startInstance, setupAdmin, registerUser } from './helpers.js';

let inst;

before(async () => {
  inst = await startInstance('security');
  await setupAdmin(inst, 'owner');
  await registerUser(inst, 'pat');
  await registerUser(inst, 'quinn');
});
after(async () => {
  await inst?.stop();
});

test('ten wrong passwords for an account lock that address out of it for a while', async () => {
  const login = (username, password) => new Client(inst.url).post('/api/auth/login', { username, password });
  for (let i = 0; i < 10; i++) assert.equal((await login('pat', `guess-${i}`)).status, 401);
  const blocked = await login('pat', 'pat-pass-1');
  assert.equal(blocked.status, 429, 'even the right password waits now');
  assert.match(blocked.data.error, /Too many failed sign-ins/);
  // Other accounts from the same address still work.
  assert.equal((await login('quinn', 'quinn-pass-1')).status, 200);
});

test('one address can only create so many accounts an hour', async () => {
  // owner, pat and quinn already count.
  let status = 201;
  let made = 3;
  while (status === 201 && made < 30) {
    status = (await new Client(inst.url).post('/api/auth/register', { username: `bulk${made}`, password: 'bulk-pass-1' })).status;
    if (status === 201) made++;
  }
  assert.equal(status, 429);
  assert.equal(made, 20);
});
