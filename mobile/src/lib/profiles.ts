import { Linking } from 'react-native';
import { router } from 'expo-router';
import { Api, normalizeServerUrl } from './api';
import type { Site } from './types';

/** Addresses the app knows to be ClipTube servers: the saved ones and the active server's network. */
export function knownServers(saved: { url: string }[], site: Site | null): Set<string> {
  const out = new Set(saved.map((s) => s.url));
  for (const p of site?.network_peers || []) {
    try {
      out.add(normalizeServerUrl(p.url));
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Opens someone's profile link: a channel on a known ClipTube server opens in the app (from that server),
 * anything else (Mastodon, PeerTube, unknown sites) in the browser.
 */
export function openProfile(url: string, known: Set<string>) {
  openChannelLink(url, known);
}

// Servers found (or not) to be ClipTube by asking them, so each is asked once.
const probed = new Map<string, Promise<boolean>>();
const isClipTube = (origin: string) => {
  let p = probed.get(origin);
  if (!p) {
    p = Promise.race([
      new Api(origin).get<{ site_name?: unknown }>('/site').then((s) => typeof s?.site_name === 'string'),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000)),
    ]).catch(() => false);
    probed.set(origin, p);
  }
  return p;
};

/**
 * Opens a channel from its web address. A ClipTube channel (/c/<name>) opens in the app, read from its own server:
 * at once for a server the app knows, after a quick check for any other. Everything else (Mastodon, PeerTube,
 * a server that doesn't answer) opens in the browser.
 */
export async function openChannelLink(url: string, known: Set<string>) {
  try {
    const u = new URL(url);
    const m = /^\/c\/([A-Za-z0-9_]{3,20})\/?$/.exec(u.pathname);
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    if (m && (known.has(origin) || (await isClipTube(origin)))) {
      router.push(`/c/${m[1]}?server=${encodeURIComponent(origin)}` as any);
      return;
    }
  } catch {
    /* not a URL: let the system try */
  }
  Linking.openURL(url).catch(() => {});
}
