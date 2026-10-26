import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { router } from 'expo-router';
import { Api } from './api';
import type { Site } from './types';

/**
 * Addresses the app knows to be OurTube servers: the saved ones, and the network peers the server marks as OurTube
 * (`software`, 1.19+). Since 1.16 the peer list also holds the PeerTube instances it follows, so unmarked peers
 * are checked before a link to them opens in the app.
 */
export function knownServers(saved: { url: string }[], site?: Site | null): Set<string> {
  const out = new Set(saved.map((s) => s.url));
  for (const p of site?.network_peers || []) if (p.software === 'ourtube') out.add(p.url.replace(/\/+$/, '').toLowerCase());
  return out;
}

/**
 * Opens someone's profile link: a channel on a known OurTube server opens in the app (from that server),
 * anything else (Mastodon, PeerTube, unknown sites) in the browser.
 */
export function openProfile(url: string, known: Set<string>) {
  openChannelLink(url, known);
}

// Servers found (or not) to be OurTube by asking them, so each is asked once.
const probed = new Map<string, Promise<boolean>>();
export const isOurTube = (origin: string) => {
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
 * Opens a channel from its web address. An OurTube channel (/c/<name>) opens in the app, read from its own server:
 * at once for a server the app knows, after a quick check for any other. Everything else (Mastodon, PeerTube,
 * a server that doesn't answer) opens in the browser.
 */
export async function openChannelLink(url: string, known: Set<string>) {
  try {
    const u = new URL(url);
    const m = /^\/c\/([A-Za-z0-9_]{3,20})\/?$/.exec(u.pathname);
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    if (m && (known.has(origin) || (await isOurTube(origin)))) {
      router.push(`/c/${m[1]}?server=${encodeURIComponent(origin)}` as any);
      return;
    }
  } catch {
    /* not a URL: let the system try */
  }
  Linking.openURL(url).catch(() => {});
}

/**
 * The network peers that are OurTube servers, asked once each: the others (PeerTube instances the server follows)
 * can't be added or signed in to. Fills in as the answers arrive.
 */
export function useOurTubePeers<P extends { url: string; name: string; software?: string | null }>(peers: P[]): P[] {
  const [ok, setOk] = useState<Set<string>>(new Set());
  const key = peers.map((p) => `${p.url}:${p.software ?? ''}`).join(' ');
  useEffect(() => {
    let live = true;
    // Marked by the server (1.19+): no need to ask. Unmarked (older servers, or not read yet): ask the peer.
    setOk(new Set(peers.filter((p) => p.software === 'ourtube').map((p) => p.url)));
    for (const p of peers) {
      if (p.software) continue;
      isOurTube(p.url).then((yes) => {
        if (yes && live) setOk((x) => (x.has(p.url) ? x : new Set(x).add(p.url)));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return peers.filter((p) => ok.has(p.url));
}
