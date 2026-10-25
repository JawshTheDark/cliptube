import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { VideoList } from '@/components/VideoList';
import { Avatar, Button, Chip, Empty, ErrorBox, toast } from '@/components/ui';
import { ApiScope, useLinkedApi } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { compact, hostOf, plural } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Channel, Video } from '@/lib/types';

const SORTS = [
  { key: 'new', label: 'Latest' },
  { key: 'views', label: 'Popular' },
  { key: 'old', label: 'Oldest' },
];

export default function ChannelScreen() {
  const { username, server } = useLocalSearchParams<{ username: string; server?: string }>();
  const scope = useLinkedApi(server);
  const { api, foreign } = scope;
  const { user } = useSession();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState('new');
  const [busy, setBusy] = useState(false);
  const paged = usePaged<Video>(api, `/users/${encodeURIComponent(username)}/videos?sort=${sort}`);

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
            {`${plural(channel.subscriber_count, 'subscriber')} · ${plural(channel.video_count, 'clip')} · ${compact(channel.total_views)} views`}
          </Text>
        </View>
      </View>
      {!!channel.bio && <Text style={s.bio}>{channel.bio}</Text>}
      {channel.moved ? (
        <Pressable onPress={() => Linking.openURL(channel.moved!.url)} style={s.moved}>
          <Text style={{ color: colors.text }}>This channel moved to {channel.moved.handle || channel.moved.url}</Text>
        </Pressable>
      ) : (
        !channel.is_self && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <Button title={channel.subscribed ? 'Subscribed' : 'Subscribe'} kind={channel.subscribed ? 'secondary' : 'primary'} onPress={toggle} busy={busy} />
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
      <View style={s.sorts}>
        {SORTS.map((x) => (
          <Chip key={x.key} label={x.label} active={sort === x.key} onPress={() => setSort(x.key)} />
        ))}
      </View>
    </View>
  ) : null;

  return (
    <ApiScope value={scope}>
      <Stack.Screen options={{ title: channel?.display_name || '' }} />
      {error ? (
        <ErrorBox message={error} onRetry={load} />
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
  sorts: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
});
