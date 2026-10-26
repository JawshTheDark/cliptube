import { parseRemoteId } from './api';
import type { Video } from './types';

/** A video's reference for playlists and parties: 'v:<id>' here, 'n:<instance>:<remote id>' from the network. */
export function refOf(v: { id: string; remote?: { peer_id: number; remote_id: string } }): string {
  if (v.remote) return `n:${v.remote.peer_id}:${v.remote.remote_id}`;
  const r = parseRemoteId(v.id);
  return r ? `n:${r.peer}:${r.remote}` : `v:${v.id}`;
}

/** The reference for a watch screen's route params. */
export function refFromRoute(p: { id?: string; peer?: string; remote?: string }): string | null {
  if (p.peer && p.remote) return `n:${p.peer}:${p.remote}`;
  return p.id ? `v:${p.id}` : null;
}

/** A pasted link to a video on this server (/watch/<id>) or from its network (/n/<peer>/<remote>). */
export function refFromLink(text: string): string | null {
  const s = text.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://x${s.startsWith('/') ? '' : '/'}${s}`);
    let m = /^\/watch\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    if (m) return `v:${m[1]}`;
    m = /^\/n\/(\d+)\/(.+?)\/?$/.exec(u.pathname);
    if (m) return `n:${m[1]}:${decodeURIComponent(m[2])}`;
  } catch {
    /* not a link */
  }
  return null;
}

/** The app route for a live stream: one on another server opens from that server. */
export function liveHref(s: { url: string; channel: { username: string } }, activeServer: string): string {
  const path = `/live/${encodeURIComponent(s.channel.username)}`;
  try {
    const u = new URL(s.url);
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    if (origin !== activeServer) return `${path}?server=${encodeURIComponent(origin)}`;
  } catch {
    /* relative: this server */
  }
  return path;
}

/** The app route for a playlist item, playing through the list (the website's paths are the app's routes). */
export const itemHref = (it: { url: string }, listId: string, shuffle = false) =>
  `${it.url}${it.url.includes('?') ? '&' : '?'}list=${encodeURIComponent(listId)}${shuffle ? '&shuffle=1' : ''}`;

export type { Video };
