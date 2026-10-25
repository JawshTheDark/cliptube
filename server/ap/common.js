/**
 * ActivityPub basics shared by the other ap/ modules: switches, URLs of local actors and objects,
 * and small text helpers.
 *
 * Local actors (PeerTube-style): every account is a Person (`/ap/users/<name>`, handle @name) with one
 * channel Group (`/ap/channels/<name>`, handle @name_channel), plus one Application actor for the
 * instance (`/ap/actor`). Videos are `/ap/videos/<id>`, comments `/ap/comments/<id>`.
 */
import crypto from 'node:crypto';
import { getSettings } from '../db.js';
import { escapeHtml } from '../util.js';

export const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
export const AP_CONTENT_TYPE = 'application/activity+json';
export const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
export const CONTEXT = ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'];

export const apEnabled = () => getSettings().activitypub_enabled === 'true';

/** The public base URL that ActivityPub ids are built from (set by the Public URL or by joining a network). */
export function apBase(req) {
  const s = getSettings();
  const base = s.public_url || s.network_self_url || (req ? `${req.protocol}://${req.get('host')}` : '');
  return base.replace(/\/+$/, '').toLowerCase();
}

export const urls = (base) => ({
  person: (username) => `${base}/ap/users/${username}`,
  group: (username) => `${base}/ap/channels/${username}`,
  instance: () => `${base}/ap/actor`,
  video: (id) => `${base}/ap/videos/${id}`,
  comment: (id) => `${base}/ap/comments/${id}`,
  activity: () => `${base}/ap/activities/${crypto.randomUUID()}`,
  sharedInbox: () => `${base}/ap/inbox`,
});

/** Which local actor a local URI points at: { kind: 'u'|'c'|'i'|'video'|'comment', name|id } or null. */
export function parseLocal(uri, base) {
  if (typeof uri !== 'string' || !base || !uri.toLowerCase().startsWith(`${base}/ap/`)) return null;
  const rest = uri.slice(base.length + 4).split(/[?#]/)[0];
  let m;
  if ((m = /^users\/([A-Za-z0-9_]{3,20})$/.exec(rest))) return { kind: 'u', name: m[1] };
  if ((m = /^channels\/([A-Za-z0-9_]{3,20})$/.exec(rest))) return { kind: 'c', name: m[1] };
  if (rest === 'actor') return { kind: 'i' };
  if ((m = /^videos\/([A-Za-z0-9_-]{1,64})$/.exec(rest))) return { kind: 'video', id: m[1] };
  if ((m = /^comments\/([A-Za-z0-9_-]{1,64})$/.exec(rest))) return { kind: 'comment', id: m[1] };
  return null;
}

/** A stable UUID for a local id (PeerTube requires a uuid on every video). */
export function uuidFor(id) {
  const h = crypto.createHash('sha256').update(`cliptube:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const isoDuration = (seconds) => `PT${Math.max(0, Math.round(Number(seconds) || 0))}S`;

export function parseDuration(d) {
  if (typeof d === 'number') return d;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(d || ''));
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

/** Plain text for display, from the HTML of a remote Note (links keep their address). */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, '');
      // Mentions and hashtags keep their text; other links keep their address.
      return /^[@#]/.test(t) ? t : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Safe HTML for an outgoing Note, from plain text. */
export function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="nofollow noopener noreferrer">$1</a>')}</p>`)
    .join('');
}

export const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
};
export const originOf = (u) => {
  try {
    return new URL(u).origin.toLowerCase();
  } catch {
    return '';
  }
};
/** First value when a field is a list (ActivityStreams allows both). */
export const first = (v) => (Array.isArray(v) ? v[0] : v);
/** An id from a field that may hold a URI or an object with an id. */
export const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.id || v.href || null : null);
