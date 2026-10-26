import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Api } from '@/lib/api';
import { hostOf } from '@/lib/format';
import { useScope } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Site } from '@/lib/types';
import { Text } from './Text';

// The website's colors (web/src/components/ServerTag.jsx). No reds: red means live.
const COLORS = ['#f59e0b', '#22c55e', '#38bdf8', '#f472b6', '#a78bfa', '#2dd4bf', '#facc15', '#60a5fa', '#c084fc', '#fb923c'];

/** A server's color comes from its address, so it is the same on every server in the network and in the app. */
export function serverColor(host: string): string {
  let h = 0;
  for (const c of host.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// Site info of servers browsed through a shared link (?server=), asked once each.
const foreignSites = new Map<string, Promise<Site | null>>();
function siteOf(api: Api): Promise<Site | null> {
  let p = foreignSites.get(api.base);
  if (!p) {
    p = api.get<Site>('/site').catch(() => null);
    foreignSites.set(api.base, p);
  }
  return p;
}

/** The site info of the server this part of the screen reads from: the active one, or a linked one. */
export function useScopeSite(): { site: Site | null; base: string } {
  const { api, foreign } = useScope();
  const session = useSession();
  const [linked, setLinked] = useState<Site | null>(null);
  useEffect(() => {
    if (!foreign) return;
    let live = true;
    siteOf(api).then((s) => live && setLinked(s));
    return () => {
      live = false;
    };
  }, [api, foreign]);
  return foreign ? { site: linked, base: foreign } : { site: session.site, base: session.server || '' };
}

export type Remote = { peer_name?: string | null; peer_url: string } | null | undefined;
export type ServerInfo = { name: string; host: string; local: boolean };

/**
 * The server a video, channel or stream lives on: `remote` for another server, nothing for this one. This server is
 * only named when it is part of a network, as on the website.
 */
export function useServer(remote: Remote): ServerInfo | null {
  const { site, base } = useScopeSite();
  if (remote?.peer_url) return { name: remote.peer_name || hostOf(remote.peer_url), host: hostOf(remote.peer_url), local: false };
  if (!site?.federation || !(site.network_peers || []).length) return null;
  return { name: site.site_name, host: site.ap_host || hostOf(base), local: true };
}

/**
 * A colored dot and the server's name. `onThumb` is the pill on a thumbnail's top-left corner; `fallback` shows
 * instead when there is no tag (a server outside a network).
 */
export function ServerTag({ remote, onThumb, small, style, fallback = null }: { remote?: Remote; onThumb?: boolean; small?: boolean; style?: StyleProp<ViewStyle>; fallback?: ReactNode }) {
  const s = useServer(remote);
  if (!s) return <>{fallback}</>;
  return <ServerPill server={s} onThumb={onThumb} small={small} style={style} />;
}

export function ServerPill({ server, onThumb, small, style }: { server: ServerInfo; onThumb?: boolean; small?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[st.tag, onThumb && st.onThumb, onThumb && small && st.onThumbSmall, style]}
      accessibilityLabel={server.local ? `On this server, ${server.name}` : `On ${server.name}`}
    >
      <View style={[st.dot, small && { width: 7, height: 7 }, { backgroundColor: serverColor(server.host) }]} />
      <Text style={[st.name, onThumb && { color: '#fff', fontSize: small ? 10 : 11 }]} numberOfLines={1}>
        {server.name}
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  tag: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', minWidth: 0 },
  onThumb: {
    position: 'absolute',
    left: 8,
    top: 8,
    maxWidth: '86%',
    paddingLeft: 7,
    paddingRight: 9,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.overlay,
  },
  onThumbSmall: { left: 6, top: 6, paddingLeft: 6, paddingRight: 7, paddingVertical: 2, gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  name: { color: colors.text, fontSize: 12, fontWeight: '700', flexShrink: 1 },
});
