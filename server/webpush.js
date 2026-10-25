/**
 * Web Push without dependencies: VAPID (RFC 8292) for the application server key and the payload
 * encryption from RFC 8291 (aes128gcm), using node:crypto only.
 */
import crypto from 'node:crypto';
import { getSettings, setSetting } from './db.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** The VAPID key pair, created on first use. The public key (uncompressed point) goes to browsers. */
export function vapidKeys() {
  const s = getSettings();
  if (s.vapid_public_key && s.vapid_private_key) return { publicKey: s.vapid_public_key, privatePem: s.vapid_private_key };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  const pub = b64u(raw);
  setSetting('vapid_public_key', pub);
  setSetting('vapid_private_key', privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { publicKey: pub, privatePem: getSettings().vapid_private_key };
}

export function vapidHeader(endpoint, subject) {
  const { publicKey, privatePem } = vapidKeys();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privatePem, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Encrypts a payload for one subscription (RFC 8291, single record). */
export function encryptPayload(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Sends one push message. Returns 'ok', 'gone' (the subscription expired and should be dropped) or
 * throws for other failures.
 */
export async function sendPush(sub, data, { subject, ttl = 86400 } = {}) {
  const endpoint = new URL(sub.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('Push endpoints must use HTTPS');
  const body = encryptPayload(JSON.stringify(data), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) throw new Error(`push service answered ${res.status}`);
  return 'ok';
}
