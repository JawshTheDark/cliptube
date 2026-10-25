/**
 * HTTP for ActivityPub: requests signed the way Mastodon and PeerTube expect (draft-cavage HTTP
 * Signatures, rsa-sha256, over (request-target), host, date, digest and content type), verification of
 * incoming signatures, and fetches with SSRF protection and a few same-scheme redirects.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { ALLOW_PRIVATE_FEDERATION, VERSION } from '../config.js';
import { HttpError } from '../util.js';
import { isPrivateIp } from '../network.js';
import { AP_ACCEPT, AP_CONTENT_TYPE } from './common.js';

export class ApError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function assertPublic(url) {
  const u = new URL(url);
  if (!['https:', 'http:'].includes(u.protocol)) throw new ApError(0, 'Only http(s) addresses');
  if (ALLOW_PRIVATE_FEDERATION) return;
  if (u.protocol !== 'https:') throw new ApError(0, 'The fediverse needs HTTPS');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new ApError(0, `Could not resolve ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new ApError(0, `${host} points to a private network address`);
}

export const digestOf = (body) => `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`;

/** Headers for a signed request. `signer` = { keyId, privateKey }. */
export function signedHeaders({ method, url, body, signer, accept = AP_ACCEPT }) {
  const u = new URL(url);
  const headers = {
    host: u.host,
    date: new Date().toUTCString(),
    accept,
    'user-agent': `ClipTube/${VERSION} (+${u.protocol}//activitypub)`,
  };
  const names = ['(request-target)', 'host', 'date'];
  if (body !== undefined) {
    headers['content-type'] = AP_CONTENT_TYPE;
    headers.digest = digestOf(body);
    names.push('digest', 'content-type');
  }
  if (signer) {
    const target = `${method.toLowerCase()} ${u.pathname}${u.search}`;
    const text = names.map((n) => (n === '(request-target)' ? `(request-target): ${target}` : `${n}: ${headers[n]}`)).join('\n');
    const sig = crypto.sign('sha256', Buffer.from(text), signer.privateKey).toString('base64');
    headers.signature = `keyId="${signer.keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${sig}"`;
  }
  return headers;
}

/**
 * Fetches (or posts) ActivityPub JSON. GETs are signed when a signer is given (servers with authorized
 * fetch require it). Follows up to three redirects, re-checking each target.
 */
export async function apFetch(url, { method = 'GET', body, signer, timeout = 15000, accept } = {}) {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(target);
    const raw = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
    let res;
    try {
      res = await fetch(target, { method, headers: signedHeaders({ method, url: target, body: raw, signer, accept }), body: raw, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new ApError(0, e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location') && method === 'GET') {
      target = new URL(res.headers.get('location'), target).href;
      continue;
    }
    const text = await res.text();
    if (text.length > 8 * 1024 * 1024) throw new ApError(res.status, 'response too large');
    if (!res.ok) throw new ApError(res.status, `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
    if (method !== 'GET') return { status: res.status };
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('not an object');
      return data;
    } catch {
      throw new ApError(res.status, 'response was not JSON');
    }
  }
  throw new ApError(0, 'too many redirects');
}

/** Parses a Signature header into its fields. */
export function parseSignature(header) {
  const out = {};
  for (const m of String(header || '').matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  if (!out.keyId || !out.signature) return null;
  out.headers = (out.headers || 'date').toLowerCase().split(/\s+/).filter(Boolean);
  return out;
}

/**
 * Checks an incoming request's HTTP signature. `getKey(keyId, { refresh })` returns { actorId, pem }.
 * Returns the signing actor's id.
 */
export async function verifyRequest(req, getKey) {
  const sig = parseSignature(req.get('signature'));
  if (!sig) throw new HttpError(401, 'Missing HTTP signature');
  if (sig.algorithm && !['rsa-sha256', 'hs2019'].includes(sig.algorithm.toLowerCase())) throw new HttpError(401, `Unsupported signature algorithm ${sig.algorithm}`);
  if (!sig.headers.includes('(request-target)')) throw new HttpError(401, 'The signature must cover (request-target)');
  const date = req.get('date');
  if (sig.headers.includes('date')) {
    const t = Date.parse(date || '');
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 3600_000) throw new HttpError(401, 'Signature date too far off');
  }
  if (req.method === 'POST') {
    if (!sig.headers.includes('digest')) throw new HttpError(401, 'The signature must cover the digest');
    const want = digestOf(req.rawBody || Buffer.alloc(0));
    const got = String(req.get('digest') || '').split(',').map((s) => s.trim()).find((d) => /^sha-256=/i.test(d));
    if (!got || got.slice(8) !== want.slice(8)) throw new HttpError(401, 'Digest does not match the body');
  }
  const text = sig.headers
    .map((h) => {
      if (h === '(request-target)') return `(request-target): ${req.method.toLowerCase()} ${req.originalUrl}`;
      const v = req.get(h);
      if (v === undefined) throw new HttpError(401, `Signed header ${h} is missing`);
      return `${h}: ${v}`;
    })
    .join('\n');
  const check = (pem) => {
    try {
      return crypto.verify('sha256', Buffer.from(text), pem, Buffer.from(sig.signature, 'base64'));
    } catch {
      return false;
    }
  };
  let key = await getKey(sig.keyId, { refresh: false });
  if (!key || !check(key.pem)) {
    key = await getKey(sig.keyId, { refresh: true }); // the key may have rotated
    if (!key || !check(key.pem)) throw new HttpError(401, 'Bad HTTP signature');
  }
  return key.actorId;
}
