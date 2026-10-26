import net from 'node:net';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const now = () => Date.now();

/** Short YouTube-style id (11 chars, URL safe). */
export function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function str(v, max = 5000) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

/** Accepts an array or a comma separated string, returns clean unique lowercase tags. */
export function parseTags(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (let t of arr) {
    t = String(t).trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, ' ');
    if (!t || t.length > 30) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 15) break;
  }
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Whether an address is in a private, loopback, link-local or otherwise non-public network. */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}
