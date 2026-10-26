// Checks OurTube against real fediverse software in the sandbox (sandbox/docker-compose.yml): GoToSocial,
// which speaks the Mastodon client API, and PeerTube. Every step prints PASS or FAIL, and the exit code is
// the number of failed steps. Run it through scripts/fediverse-sandbox.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CT = 'https://clips.sandbox.test';
const GTS = 'https://gts.sandbox.test';
const PT = 'https://tube.sandbox.test';
const CT_HOST = new URL(CT).host;
const CLIP = '/tmp/sandbox-clip.mp4';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (x) => (typeof x === 'string' ? x : JSON.stringify(x) || '').replace(/\s+/g, ' ').slice(0, 300);

async function waitFor(fn, { timeout = 90000, interval = 1500, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ''} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    return true;
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL  ${name}: ${e.message}`);
    return false;
  }
}

/** fetch with a cookie jar and manual redirects (OurTube's session, GoToSocial's sign-in pages). */
class Session {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async req(method, p, { json, form, body, headers = {} } = {}) {
    const h = { Accept: 'application/json, text/html;q=0.9', ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    if (form !== undefined) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    }
    const url = /^https?:/.test(p) ? p : this.base + p;
    const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    const location = res.headers.get('location');
    return { status: res.status, data, location: location ? new URL(location, url).href : null, url };
  }

  get(p, o) {
    return this.req('GET', p, o);
  }
  post(p, json, o = {}) {
    return this.req('POST', p, { json, ...o });
  }
  patch(p, json) {
    return this.req('PATCH', p, { json });
  }
}

function must(r, what, ok = (s) => s >= 200 && s < 300) {
  if (!ok(r.status)) throw new Error(`${what}: HTTP ${r.status} ${short(r.data)}`);
  return r.data;
}

/** A bearer-token API client (GoToSocial's Mastodon API, PeerTube's REST API). */
function bearer(base, token) {
  return async (method, p, { json, form, multipart } = {}) => {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    if (form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    if (multipart) body = multipart;
    const res = await fetch(base + p, { method, headers, body });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  };
}

// ---- helpers for each server -----------------------------------------------------------------------------

function makeClip() {
  execFileSync('/app/node_modules/ffmpeg-static/ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', CLIP,
  ]);
}

async function uploadToOurTube(ct, title) {
  const form = new FormData();
  form.append('title', title);
  form.append('visibility', 'public');
  form.append('description', `${title}, uploaded by the sandbox check`);
  form.append('file', new Blob([fs.readFileSync(CLIP)]), 'clip.mp4');
  const v = must(await ct.req('POST', '/api/videos', { body: form }), `upload ${title}`).video;
  return waitFor(
    async () => {
      const x = (await ct.get(`/api/videos/${v.id}`)).data.video;
      if (x.status === 'failed') throw new Error(x.error);
      return x.status === 'ready' ? x : null;
    },
    { what: `${title} to process` },
  );
}

const ctComments = async (ct, id) => (await ct.get(`/api/videos/${id}/comments`)).data.comments || [];

/** GoToSocial has no password grant: register an app, sign in through its pages, authorize, swap the code. */
async function gtsToken() {
  const redirect = 'urn:ietf:wg:oauth:2.0:oob';
  const scope = 'read write follow';
  const app = must(await new Session(GTS).post('/api/v1/apps', { client_name: 'OurTube sandbox check', redirect_uris: redirect, scopes: scope }), 'register an app');
  const s = new Session(GTS);
  const authorize = `/oauth/authorize?${new URLSearchParams({ client_id: app.client_id, redirect_uri: redirect, response_type: 'code', scope })}`;
  let r = await s.get(authorize);
  const trail = [`GET authorize ${r.status} -> ${r.location}`];
  if (r.location && /sign_in/.test(r.location)) {
    await s.get(r.location);
    r = await s.req('POST', r.location, { form: { username: process.env.GTS_EMAIL, password: process.env.GTS_PASSWORD } });
    trail.push(`POST sign_in ${r.status} -> ${r.location}`);
  }
  let code = null;
  for (let i = 0; i < 8 && !code; i++) {
    const at = r.location || (typeof r.data === 'string' ? null : null);
    const m = /[?&]code=([^&]+)/.exec(at || '');
    if (m) {
      code = decodeURIComponent(m[1]);
      break;
    }
    if (typeof r.data === 'string') {
      // The out-of-band page shows the code; the authorize page has a form to submit.
      const shown = /<code[^>]*>\s*([A-Za-z0-9_-]{16,})\s*<\/code>/.exec(r.data) || /value="([A-Za-z0-9_-]{20,})"/.exec(r.data);
      if (shown && /oob|code/i.test(r.url)) {
        code = shown[1];
        break;
      }
      const action = /<form[^>]*action="([^"]*authorize[^"]*)"/i.exec(r.data)?.[1];
      if (action) {
        const fields = Object.fromEntries([...r.data.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)].map((x) => [x[1], x[2]]));
        r = await s.req('POST', new URL(action.replace(/&amp;/g, '&'), r.url).href, { form: fields });
        trail.push(`POST authorize ${r.status} -> ${r.location}`);
        continue;
      }
    }
    if (!r.location) break;
    r = await s.get(r.location);
    trail.push(`GET ${r.url} ${r.status} -> ${r.location}`);
  }
  if (!code) throw new Error(`no authorization code (${trail.join('; ')}; last page: ${short(r.data)})`);
  const tok = must(
    await new Session(GTS).req('POST', '/oauth/token', { form: { grant_type: 'authorization_code', code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: redirect, scope } }),
    'swap the code for a token',
  );
  return tok.access_token;
}

async function ptToken() {
  const c = must(await new Session(PT).get('/api/v1/oauth-clients/local'), 'PeerTube client');
  const t = must(
    await new Session(PT).req('POST', '/api/v1/users/token', {
      form: { client_id: c.client_id, client_secret: c.client_secret, grant_type: 'password', response_type: 'code', username: 'root', password: process.env.PT_ROOT_PASSWORD },
    }),
    'PeerTube token',
  );
  return t.access_token;
}

async function upFor(url, what) {
  await waitFor(async () => (await fetch(url)).status < 500, { timeout: 300000, interval: 3000, what: `${what} to start` });
}

// ---- the checks ------------------------------------------------------------------------------------------

async function main() {
  await upFor(`${CT}/api/site`, 'OurTube');
  await upFor(`${GTS}/api/v1/instance`, 'GoToSocial');
  await upFor(`${PT}/api/v1/config`, 'PeerTube');
  const versions = {
    gotosocial: (await (await fetch(`${GTS}/api/v1/instance`)).json()).version,
    peertube: (await (await fetch(`${PT}/api/v1/config`)).json()).serverVersion,
    cliptube: (await (await fetch(`${CT}/nodeinfo/2.0`)).json()).software?.version,
  };
  console.log(`versions: OurTube ${versions.cliptube}, GoToSocial ${versions.gotosocial}, PeerTube ${versions.peertube}`);
  makeClip();

  const ct = new Session(CT);
  must(await ct.post('/api/auth/register', { username: 'alice', password: 'alice-sandbox-pass-1', setup_code: 'sandbox-setup', display_name: 'Alice in the sandbox' }), 'register on OurTube');
  must(await ct.patch('/api/admin/settings', { public_url: CT }), 'set the public URL');
  must(await ct.patch('/api/mod/settings', { spam_hold_first_comments: false }), 'comment settings');
  const one = await uploadToOurTube(ct, 'Sandbox clip one');

  // ---- GoToSocial, the Mastodon-compatible side -------------------------------------------------------------
  let gts = null;
  let alice = null;
  let status = null;
  let two = null;
  let reply = null;
  await step('GoToSocial: sign in as a test account', async () => {
    gts = bearer(GTS, await gtsToken());
    // GoToSocial accounts start out approving followers by hand; this one takes them like most do.
    must(await gts('PATCH', '/api/v1/accounts/update_credentials', { form: { locked: 'false' } }), 'unlock the account');
    const me = must(await gts('GET', '/api/v1/accounts/verify_credentials'), 'verify credentials');
    return `@${me.acct}${me.locked ? ' (still locked)' : ''}`;
  });
  const gtsReady = await step('GoToSocial: finds the OurTube account by its handle', async () => {
    if (!gts) throw new Error('not signed in');
    const r = must(await gts('GET', `/api/v2/search?${new URLSearchParams({ q: `@alice@${CT_HOST}`, resolve: 'true', type: 'accounts' })}`), 'search');
    alice = r.accounts?.[0];
    if (!alice) throw new Error(`no account found: ${short(r)}`);
    return `${alice.acct}, "${alice.display_name}"`;
  });
  if (gtsReady) {
    await step('GoToSocial: follows it, and OurTube accepts', async () => {
      must(await gts('POST', `/api/v1/accounts/${alice.id}/follow`), 'follow');
      await waitFor(async () => (await gts('GET', `/api/v1/accounts/relationships?id[]=${alice.id}`)).data?.[0]?.following, { what: 'the follow to be accepted' });
    });
    await step('GoToSocial: a new clip shows up in the home timeline with a playable video', async () => {
      two = await uploadToOurTube(ct, 'Sandbox clip two');
      const uri = `${CT}/ap/videos/${two.id}`;
      status = await waitFor(async () => (await gts('GET', '/api/v1/timelines/home?limit=40')).data.find?.((s) => s.uri === uri || s.reblog?.uri === uri), { what: 'the clip in the timeline' });
      if (status.reblog) status = status.reblog;
      const m = status.media_attachments?.[0];
      if (!m) throw new Error(`no attachment; status: ${short({ content: status.content, spoiler: status.spoiler_text })}`);
      if (m.type !== 'video' && !/\.mp4/.test(m.remote_url || '')) throw new Error(`attachment is ${m.type}: ${m.remote_url}`);
      return `${m.type} attachment from ${m.remote_url}; text: ${short(status.content).slice(0, 120)}`;
    });
    await step('GoToSocial: a reply there becomes an OurTube comment, without the leading mention', async () => {
      if (!status) throw new Error('no status to reply to');
      reply = must(await gts('POST', '/api/v1/statuses', { json: { status: `@alice@${CT_HOST} great clip from the sandbox`, in_reply_to_id: status.id, visibility: 'public' } }), 'reply');
      const c = await waitFor(async () => (await ctComments(ct, two.id)).find((x) => /great clip from the sandbox/.test(x.body)), { what: 'the comment on OurTube' });
      if (/^@/.test(c.body)) throw new Error(`body still starts with a mention: ${c.body}`);
      if (!/^mona@gts\.sandbox\.test$/i.test(c.author.username)) throw new Error(`author is ${c.author.username}`);
      return `"${c.body}" by @${c.author.username}`;
    });
    await step('GoToSocial: a favourite counts as a like on OurTube', async () => {
      must(await gts('POST', `/api/v1/statuses/${status.id}/favourite`), 'favourite');
      const v = await waitFor(async () => {
        const x = (await ct.get(`/api/videos/${two.id}`)).data.video;
        return x.likes >= 1 ? x : null;
      }, { what: 'the like' });
      return `${v.likes} like`;
    });
    await step('GoToSocial: a boost counts as a share on OurTube', async () => {
      must(await gts('POST', `/api/v1/statuses/${status.id}/reblog`), 'boost');
      const n = await waitFor(async () => {
        const c = await (await fetch(`${CT}/ap/videos/${two.id}/shares`, { headers: { Accept: 'application/activity+json' } })).json();
        return c.totalItems >= 1 ? c.totalItems : null;
      }, { what: 'the share' });
      return `${n} share`;
    });
    await step('GoToSocial: an OurTube reply arrives in the GoToSocial thread', async () => {
      if (!reply) throw new Error('no reply to answer');
      const c = (await ctComments(ct, two.id)).find((x) => /great clip from the sandbox/.test(x.body));
      must(await ct.post(`/api/videos/${two.id}/comments`, { body: 'thanks mona, this is OurTube answering', parent_id: c.id }), 'reply on OurTube');
      const d = await waitFor(async () => (await gts('GET', `/api/v1/statuses/${reply.id}/context`)).data.descendants?.find((x) => /OurTube answering/.test(x.content)), { what: 'the reply in the thread' });
      return `by @${d.account.acct}`;
    });
    await step('OurTube: follows the GoToSocial account', async () => {
      must(await ct.post('/api/fediverse/follow', { handle: '@mona@gts.sandbox.test' }), 'follow');
      await waitFor(
        async () => {
          // In case the account still approves followers by hand, approve it the way a person would.
          for (const r of (await gts('GET', '/api/v1/follow_requests')).data || []) await gts('POST', `/api/v1/follow_requests/${r.id}/authorize`);
          return (await ct.get('/api/fediverse/follows')).data.follows?.find((f) => f.status === 'accepted' && /mona/.test(f.handle));
        },
        { what: 'GoToSocial to accept' },
      );
    });
  }

  // ---- PeerTube --------------------------------------------------------------------------------------------
  let pt = null;
  let ptVideo = null;
  let thread = null;
  const ptReady = await step('PeerTube: sign in as root', async () => {
    pt = bearer(PT, await ptToken());
    return `PeerTube ${versions.peertube}`;
  });
  if (ptReady) {
    const subscribed = await step('PeerTube: subscribes to the OurTube channel and imports its videos', async () => {
      must(await pt('POST', '/api/v1/users/me/subscriptions', { json: { uri: `alice_channel@${CT_HOST}` } }), 'subscribe');
      const list = await waitFor(
        async () => {
          const d = (await pt('GET', '/api/v1/users/me/subscriptions/videos?count=25&sort=-publishedAt')).data?.data || [];
          return d.some((v) => v.name === 'Sandbox clip one') ? d : null;
        },
        { timeout: 120000, what: 'the OurTube videos on PeerTube' },
      );
      ptVideo = list.find((v) => v.name === 'Sandbox clip one');
      return list.map((v) => v.name).join(', ');
    });
    if (subscribed) {
      await step('PeerTube: plays the OurTube video from its MP4 file', async () => {
        const d = must(await pt('GET', `/api/v1/videos/${ptVideo.uuid}`), 'video');
        const files = [...(d.files || []), ...(d.streamingPlaylists || []).flatMap((p) => p.files || [])];
        const f = files.find((x) => (x.fileUrl || '').includes(CT_HOST));
        if (!f) throw new Error(`no OurTube file in ${short(files)}`);
        const r = await fetch(f.fileUrl, { headers: { Range: 'bytes=0-1023' } });
        if (![200, 206].includes(r.status)) throw new Error(`the file answered ${r.status}`);
        return `${f.resolution?.label || '?'} from ${f.fileUrl}`;
      });
      await step('PeerTube: a comment there becomes an OurTube comment', async () => {
        const c = must(await pt('POST', `/api/v1/videos/${ptVideo.uuid}/comment-threads`, { json: { text: 'nice one, from PeerTube' } }), 'comment').comment;
        thread = c.threadId || c.id;
        const x = await waitFor(async () => (await ctComments(ct, one.id)).find((y) => /nice one, from PeerTube/.test(y.body)), { what: 'the comment on OurTube' });
        return `by @${x.author.username}`;
      });
      await step('PeerTube: a like there counts on OurTube', async () => {
        must(await pt('PUT', `/api/v1/videos/${ptVideo.uuid}/rate`, { json: { rating: 'like' } }), 'like');
        const v = await waitFor(async () => {
          const x = (await ct.get(`/api/videos/${one.id}`)).data.video;
          return x.likes >= 1 ? x : null;
        }, { what: 'the like' });
        return `${v.likes} like`;
      });
      await step('PeerTube: an OurTube reply shows in the PeerTube thread', async () => {
        if (!thread) throw new Error('no thread');
        const c = (await ctComments(ct, one.id)).find((y) => /nice one, from PeerTube/.test(y.body));
        must(await ct.post(`/api/videos/${one.id}/comments`, { body: 'glad you liked it, PeerTube', parent_id: c.id }), 'reply on OurTube');
        const child = await waitFor(
          async () => {
            const t = (await pt('GET', `/api/v1/videos/${ptVideo.uuid}/comment-threads/${thread}`)).data;
            return (t.children || []).find((ch) => /glad you liked it/.test(ch.comment?.text || ''));
          },
          { what: 'the reply on PeerTube' },
        );
        return `by ${child.comment.account?.name}@${child.comment.account?.host}`;
      });
    }
    await step('OurTube: follows a PeerTube channel and plays its new video', async () => {
      must(await ct.post('/api/fediverse/follow', { handle: 'root_channel@tube.sandbox.test' }), 'follow');
      await waitFor(async () => (await ct.get('/api/fediverse/follows')).data.follows?.find((f) => f.status === 'accepted' && /root_channel/.test(f.handle)), { what: 'PeerTube to accept' });
      const channel = must(await pt('GET', '/api/v1/video-channels/root_channel'), 'channel');
      const form = new FormData();
      form.append('channelId', String(channel.id));
      form.append('name', 'PeerTube sandbox video');
      form.append('privacy', '1');
      form.append('waitTranscoding', 'true');
      form.append('videofile', new Blob([fs.readFileSync(CLIP)], { type: 'video/mp4' }), 'clip.mp4');
      const up = must(await pt('POST', '/api/v1/videos/upload', { multipart: form }), 'upload to PeerTube').video;
      await waitFor(async () => (await pt('GET', `/api/v1/videos/${up.uuid}`)).data?.state?.id === 1, { timeout: 180000, what: 'PeerTube to publish it' });
      const nv = await waitFor(async () => (await ct.get('/api/videos?scope=network&limit=50')).data.videos?.find((v) => v.title === 'PeerTube sandbox video'), { timeout: 120000, what: 'the video on OurTube' });
      const src = nv.video_url || nv.hls_url;
      const r = await fetch(src, { headers: { Range: 'bytes=0-1023' } });
      if (![200, 206].includes(r.status)) throw new Error(`${src} answered ${r.status}`);
      return `playable from ${src}`;
    });
    await step('OurTube: follows the whole PeerTube server', async () => {
      must(await ct.post('/api/admin/fediverse/follow', { server: 'tube.sandbox.test' }), 'follow the server');
      await waitFor(async () => (await ct.get('/api/admin/fediverse')).data.servers?.find((s) => s.status === 'accepted'), { what: 'PeerTube to accept' });
    });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  for (const f of failed) console.log(`  failed: ${f.name}: ${f.error}`);
  process.exit(failed.length);
}

main().catch((e) => {
  console.error(`sandbox check crashed: ${e.stack || e.message}`);
  process.exit(100);
});
