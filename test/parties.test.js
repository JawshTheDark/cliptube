// Watch parties: a host starts one from a video, guests join by link and name, everyone hears playback,
// queue and chat changes over server-sent events, and the host steers, hands over control, kicks and ends it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startInstance, setupAdmin, registerUser, uploadReady, waitFor } from './helpers.js';

let inst, alice, bob, v1, v2, party, guest, hostEvents, guestEvents;
const streams = [];

/** Follows a server-sent event stream, collecting { event, data }. */
function follow(url, headers = {}) {
  const ctrl = new AbortController();
  const s = { got: [], status: null, ended: false };
  s.close = () => ctrl.abort();
  s.wait = (pred, what) => waitFor(() => s.got.find(pred), { what, timeout: 10000 });
  (async () => {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    s.status = res.status;
    if (!res.ok) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event) s.got.push({ event, data: data ? JSON.parse(data) : null });
      }
    }
    s.ended = true;
  })().catch(() => {
    s.ended = true;
  });
  streams.push(s);
  return s;
}

const as = (token) => ({ 'x-room-member': token });
async function guestPost(path, body, token) {
  const res = await fetch(`${inst.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...as(token) }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  inst = await startInstance('parties');
  alice = await setupAdmin(inst, 'alice');
  bob = await registerUser(inst, 'bob');
  [v1, v2] = await Promise.all([uploadReady(alice, { title: 'First clip' }), uploadReady(alice, { title: 'Second clip' })]);
});
after(async () => {
  for (const s of streams) s.close();
  await inst?.stop();
});

test('a host starts a party from a video, and a guest joins by link and name', async () => {
  const r = await alice.post('/api/parties', { ref: `v:${v1.id}` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  party = r.data.party;
  assert.deepEqual(party.queue.map((it) => it.title), ['First clip']);
  assert.equal(party.state.playing, false);
  assert.equal(party.you.is_host, true);
  assert.equal((await new Client(inst.url).get(`/api/parties/${party.id}`)).data.party.you, null);

  const j = await new Client(inst.url).post(`/api/parties/${party.id}/join`, { name: 'Gus' });
  assert.equal(j.status, 201, JSON.stringify(j.data));
  guest = j.data;
  hostEvents = follow(`${inst.url}/api/parties/${party.id}/events`, { Cookie: alice.cookie });
  guestEvents = follow(`${inst.url}/api/parties/${party.id}/events?member=${guest.token}`);
  const hello = await guestEvents.wait((e) => e.event === 'hello', 'the guest hello');
  assert.equal(hello.data.you.name, 'Gus');
  assert.equal(hello.data.you.can_control, false);
  await hostEvents.wait((e) => e.event === 'members' && e.data.members.length === 2, 'both members');
  assert.equal((await new Client(inst.url).post(`/api/parties/${party.id}/join`, { name: 'x' })).status, 400, 'names need two characters');
});

test('the host steers playback, or lets everyone steer', async () => {
  assert.equal((await guestPost(`/api/parties/${party.id}/control`, { action: 'play', position: 0 }, guest.token)).status, 403);
  assert.equal((await alice.post(`/api/parties/${party.id}/control`, { action: 'play', position: 1.5 })).status, 200);
  const st = await guestEvents.wait((e) => e.event === 'state' && e.data.playing, 'playing for the guest');
  assert.equal(st.data.position, 1.5);
  assert.ok(Math.abs(st.data.now - st.data.at) < 5000);

  assert.equal((await alice.patch(`/api/parties/${party.id}`, { control: 'everyone' })).status, 200);
  await guestEvents.wait((e) => e.event === 'settings' && e.data.control === 'everyone', 'the new setting');
  assert.equal((await guestPost(`/api/parties/${party.id}/control`, { action: 'pause', position: 2 }, guest.token)).status, 200);
  await hostEvents.wait((e) => e.event === 'state' && e.data.playing === false && e.data.position === 2, 'the guest pause, for the host');
  await alice.patch(`/api/parties/${party.id}`, { control: 'host' });
});

test('the queue grows, plays in order and stops at the end', async () => {
  const q = await alice.post(`/api/parties/${party.id}/queue`, { ref: `v:${v2.id}` });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  await guestEvents.wait((e) => e.event === 'queue' && e.data.queue.length === 2, 'the bigger queue');
  const [first, second] = q.data.queue;
  await alice.post(`/api/parties/${party.id}/control`, { action: 'next' });
  await guestEvents.wait((e) => e.event === 'state' && e.data.item_id === second.id && e.data.playing, 'the second video');
  // A late "ended" for the first video changes nothing; the end of the last one pauses.
  await alice.post(`/api/parties/${party.id}/control`, { action: 'ended', item_id: first.id });
  const end = await alice.post(`/api/parties/${party.id}/control`, { action: 'ended', item_id: second.id, position: 4 });
  assert.equal(end.data.state.item_id, second.id);
  assert.equal(end.data.state.playing, false);
  // Taking out the current video moves to what is left.
  await alice.del(`/api/parties/${party.id}/queue/${second.id}`);
  assert.equal((await alice.get(`/api/parties/${party.id}`)).data.party.state.item_id, first.id);
});

test('chat and reactions reach everyone; the host can remove people', async () => {
  assert.equal((await guestPost(`/api/parties/${party.id}/chat`, { body: 'hi all' }, guest.token)).status, 201);
  const msg = await hostEvents.wait((e) => e.event === 'chat' && e.data.body === 'hi all', 'the chat message');
  assert.equal(msg.data.name, 'Gus');
  let status = 201;
  for (let i = 0; i < 6 && status === 201; i++) status = (await guestPost(`/api/parties/${party.id}/chat`, { body: `spam ${i}` }, guest.token)).status;
  assert.equal(status, 429, 'chat is rate limited');
  assert.equal((await guestPost(`/api/parties/${party.id}/react`, { emoji: '💩' }, guest.token)).status, 400);
  assert.equal((await alice.post(`/api/parties/${party.id}/react`, { emoji: '🔥' })).status, 200);
  await guestEvents.wait((e) => e.event === 'react' && e.data.emoji === '🔥', 'the reaction');
  // New people see what was said.
  assert.ok((await alice.get(`/api/parties/${party.id}`)).data.party.messages.some((m) => m.body === 'hi all'));

  assert.equal((await alice.post(`/api/parties/${party.id}/kick`, { member_id: guest.member_id })).status, 200);
  await waitFor(() => guestEvents.ended, { what: 'the guest stream to close' });
  assert.equal((await guestPost(`/api/parties/${party.id}/chat`, { body: 'still here?' }, guest.token)).status, 403);
});

test('a locked party keeps newcomers out, and ending it closes it for everyone', async () => {
  await alice.patch(`/api/parties/${party.id}`, { locked: true });
  assert.equal((await new Client(inst.url).post(`/api/parties/${party.id}/join`, { name: 'Late' })).status, 403);
  const bobs = follow(`${inst.url}/api/parties/${party.id}/events`, { Cookie: bob.cookie });
  await waitFor(() => bobs.status, { what: 'the answer to bob' });
  assert.equal(bobs.status, 403);

  assert.equal((await alice.del(`/api/parties/${party.id}`)).status, 200);
  await hostEvents.wait((e) => e.event === 'ended', 'the end');
  assert.equal((await alice.get(`/api/parties/${party.id}`)).status, 404);
  assert.equal((await bob.post('/api/parties', {})).status, 400, 'a party needs something to watch');
});
