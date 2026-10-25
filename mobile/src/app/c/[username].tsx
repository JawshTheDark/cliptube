import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { PlaylistRow } from '@/components/PlaylistRow';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { VideoList } from '@/components/VideoList';
import { Avatar, Button, Chip, Empty, ErrorBox, Icon, Loading, toast } from '@/components/ui';
import { knownServers, openProfile } from '@/lib/profiles';
import { ApiScope, useLinkedApi, withServer } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { hostOf, plural } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Channel, LivePage, PlaylistSummary, Video } from '@/lib/types';

const SORTS = [
  { key: 'new', label: 'Latest' },
  { key: 'views', label: 'Popular' },
  { key: 'old', label: 'Oldest' },
];

export default function ChannelScreen() {
  const { username, server } = useLocalSearchParams<{ username: string; server?: string }>();
  const scope = useLinkedApi(server);
  const { api, foreign } = scope;
  const { user, servers, site } = useSession();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState('new');
  const [withLinked, setWithLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'videos' | 'playlists'>('videos');
  const [live, setLive] = useState<LivePage | null>(null);
  useEffect(() => {
    api
      .get<LivePage>(`/live/${encodeURIComponent(username)}`)
      .then(setLive)
      .catch(() => setLive(null)); // no live streaming before ClipTube 1.9
  }, [api, username]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  useEffect(() => {
    if (tab !== 'playlists') return;
    setPlaylists(null);
    api
      .get<{ playlists: PlaylistSummary[] }>(`/users/${encodeURIComponent(username)}/playlists`)
      .then((r) => setPlaylists(r.playlists))
      .catch(() => setPlaylists([])); // servers before 1.7 have none
  }, [tab, api, username]);
  // "All accounts" adds the videos of the channel's linked accounts on other servers.
  const paged = usePaged<Video>(api, `/users/${encodeURIComponent(username)}/videos?sort=${sort}${withLinked ? '&linked=1' : ''}`);
  const known = knownServers(servers, site);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ channel: Channel }>(`/users/${encodeURIComponent(username)}`)
      .then((r) => setChannel(r.channel))
      .catch((e) => setError(e.message));
  }, [api, username]);
  useEffect(load, [load]);

  const toggle = async () => {
    if (!channel) return;
    if (foreign) return toast(`Switch to ${hostOf(foreign)} to subscribe`);
    if (!user) return router.push('/login');
    setBusy(true);
    try {
      const r = await api.req<{ channel: Channel }>(`/users/${encodeURIComponent(username)}/subscribe`, { method: channel.subscribed ? 'DELETE' : 'POST' });
      setChannel(r.channel);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const linked = channel?.linked_accounts || [];
  // Linked accounts with a channel can be followed; a plain Mastodon account has no videos.
  const linkedChannels = linked.filter((l) => l.channel);

  const subscribeAll = async () => {
    if (!channel) return;
    if (foreign) return toast(`Switch to ${hostOf(foreign)} to subscribe`);
    if (!user) return router.push('/login');
    setBusy(true);
    try {
      const r = await api.post<{ channel: Channel; followed: string[] }>(`/users/${encodeURIComponent(username)}/subscribe-all`);
      setChannel(r.channel);
      toast(r.followed.length ? `Subscribed here and followed ${r.followed.join(', ')}` : `Subscribed to ${r.channel.display_name}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const header = channel ? (
    <View>
      {!!channel.banner_url && <Image source={{ uri: api.abs(channel.banner_url)! }} style={s.banner} contentFit="cover" />}
      <View style={s.head}>
        <Avatar uri={api.abs(channel.avatar_url)} name={channel.display_name} size={72} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.name} numberOfLines={2}>
            {channel.display_name}
          </Text>
          <Text style={s.meta}>@{channel.username}</Text>
          <Text style={s.meta}>
            {`${plural(channel.subscriber_count, 'subscriber')} · ${plural(channel.video_count, 'clip')} · ${plural(channel.total_views, 'view')}`}
          </Text>
        </View>
      </View>
      {!!channel.bio && <Text style={s.bio}>{channel.bio}</Text>}
      {!!live?.live && live.stream && (
        <Pressable style={s.liveBanner} onPress={() => router.push(withServer(`/live/${encodeURIComponent(username)}`, foreign) as any)} accessibilityRole="button">
          <View style={s.liveBadge}>
            <Text style={s.liveBadgeText}>LIVE</Text>
          </View>
          <Text style={{ color: colors.text, flex: 1, fontWeight: '600' }} numberOfLines={1}>
            {live.stream.title}
          </Text>
          <Icon name="chevron-right" size={22} color={colors.text2} />
        </Pressable>
      )}
      {linked.length > 0 && (
        <View style={s.alsoOn}>
          <Text style={s.meta}>Also on</Text>
          {linked.map((l) => (
            <Pressable key={l.handle} style={s.alsoChip} onPress={() => openProfile(l.url, known)} accessibilityRole="link" accessibilityLabel={`${l.handle}, linked both ways`}>
              <Icon name="check" size={14} color={colors.ok} />
              <Text style={{ color: colors.text, fontSize: 13 }}>{l.host}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {channel.moved ? (
        <Pressable onPress={() => Linking.openURL(channel.moved!.url)} style={s.moved}>
          <Text style={{ color: colors.text }}>This channel moved to {channel.moved.handle || channel.moved.url}</Text>
        </Pressable>
      ) : (
        !channel.is_self && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 8, gap: 8 }}>
            <Button title={channel.subscribed ? 'Subscribed' : 'Subscribe'} kind={channel.subscribed ? 'secondary' : 'primary'} onPress={toggle} busy={busy} />
            {linkedChannels.length > 0 && (!channel.subscribed || linkedChannels.some((l) => !l.following)) && (
              <Button title={`Subscribe to all ${linkedChannels.length + 1}`} icon="link" onPress={subscribeAll} disabled={busy} />
            )}
          </View>
        )
      )}
      {channel.support_links?.length > 0 && (
        <View style={s.links}>
          {channel.support_links.map((l) => (
            <Button key={l.url} title={l.label} icon="favorite-border" small onPress={() => Linking.openURL(l.url)} />
          ))}
        </View>
      )}
      <View style={s.tabs}>
        {(['videos', 'playlists'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
            <Text style={[s.tabText, tab === t && { color: colors.text }]}>{t === 'videos' ? 'Clips' : 'Playlists'}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'videos' && (
        <View style={s.sorts}>
          {SORTS.map((x) => (
            <Chip key={x.key} label={x.label} active={sort === x.key} onPress={() => setSort(x.key)} />
          ))}
          {linkedChannels.length > 0 && <Chip label="All accounts" active={withLinked} onPress={() => setWithLinked((x) => !x)} />}
        </View>
      )}
    </View>
  ) : null;

  return (
    <ApiScope value={scope}>
      <Stack.Screen options={{ title: channel?.display_name || '' }} />
      {error ? (
        <ErrorBox message={error} onRetry={load} />
      ) : tab === 'playlists' ? (
        <FlatList
          data={playlists || []}
          keyExtractor={(p) => p.id}
          ListHeaderComponent={header || undefined}
          ListEmptyComponent={playlists === null ? <Loading /> : <Empty icon="playlist-play" title="No playlists yet" />}
          renderItem={({ item }) => <PlaylistRow p={item} />}
          contentContainerStyle={{ paddingBottom: 24 }}
        />
      ) : (
        <VideoList paged={paged} header={header} showChannel={false} empty={<Empty title="No clips yet">{channel?.is_self ? 'Your uploads show up here.' : ''}</Empty>} />
      )}
    </ApiScope>
  );
}

const s = StyleSheet.create({
  banner: { width: '100%', aspectRatio: 6, backgroundColor: colors.surface },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12 },
  name: { color: colors.text, fontSize: 22, fontWeight: '700' },
  meta: { color: colors.text2, fontSize: 13 },
  bio: { color: colors.text, fontSize: 14, lineHeight: 20, paddingHorizontal: 12, paddingBottom: 10 },
  moved: { margin: 12, padding: 12, borderRadius: 10, backgroundColor: colors.surface2 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  sorts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  alsoOn: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  liveBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginBottom: 10, padding: 12, borderRadius: 12, backgroundColor: 'rgba(255,0,51,0.15)' },
  liveBadge: { backgroundColor: colors.accent, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  liveBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.text },
  tabText: { color: colors.text2, fontSize: 14, fontWeight: '600' },
  alsoChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
});
