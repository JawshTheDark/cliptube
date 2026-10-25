import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/components/AppHeader';
import { VideoList } from '@/components/VideoList';
import { Avatar, Button, Chip, Empty, ErrorBox } from '@/components/ui';
import { compact } from '@/lib/format';
import { liveHref } from '@/lib/refs';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { colors } from '@/lib/theme';
import type { LiveNow, LiveStream, Video } from '@/lib/types';

type Feed = { key: string; label: string; path: string };

export default function Home() {
  const { api, user, site, siteError, refresh, server } = useSession();
  const [feed, setFeed] = useState('all');
  const [tags, setTags] = useState<string[]>([]);
  const [live, setLive] = useState<LiveStream[]>([]);

  // Who's live, here and on the rest of the network (ClipTube 1.9; older servers have none).
  const loadLive = useCallback(() => {
    if (!server) return;
    api
      .get<LiveNow>('/live/now')
      .then((r) => setLive([...(r.live || []), ...(r.network || [])]))
      .catch(() => setLive([]));
  }, [api, server]);
  useFocusEffect(loadLive);
  const networked = !!site?.federation && (site.network_peers || []).length > 0;

  useEffect(() => {
    setTags([]);
    api
      .get<{ tags: { tag: string }[] }>('/videos/tags')
      .then((r) => setTags(r.tags.slice(0, 12).map((t) => t.tag)))
      .catch(() => {});
  }, [api]);

  // Same choices as the website's home page chips.
  const feeds = useMemo<Feed[]>(() => {
    const scope = networked ? 'all' : 'local';
    const list: Feed[] = [{ key: 'all', label: 'All', path: `/videos?sort=new&scope=${scope}` }];
    if (networked) list.push({ key: 'local', label: 'This site', path: '/videos?sort=new&scope=local' });
    if (user) {
      list.push({ key: 'foryou', label: 'For you', path: '/feed/for-you?hide_watched=0' });
      list.push({ key: 'subs', label: 'Subscriptions', path: '/me/feed' });
    }
    list.push({ key: 'trending', label: 'Trending', path: `/videos?sort=views&scope=${scope}` });
    list.push({ key: 'vertical', label: 'Vertical', path: `/videos?sort=new&shape=vertical&scope=${scope}` });
    list.push({ key: 'top', label: 'Top rated', path: `/videos?sort=top&scope=${scope}` });
    for (const t of tags) list.push({ key: `tag:${t}`, label: `#${t}`, path: `/videos?sort=new&scope=${scope}&tag=${encodeURIComponent(t)}` });
    return list;
  }, [networked, user, tags]);

  const current = feeds.find((f) => f.key === feed) || feeds[0];
  // A feed that disappears (signed out, other server) falls back to All.
  useEffect(() => {
    if (!feeds.some((f) => f.key === feed)) setFeed('all');
  }, [feeds, feed]);
  useEffect(() => setFeed('all'), [server]);

  const paged = usePaged<Video>(api, current.path);

  const header = (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} style={{ backgroundColor: colors.bg }}>
        {feeds.map((f) => (
          <Chip key={f.key} label={f.label} active={f.key === current.key} onPress={() => setFeed(f.key)} />
        ))}
      </ScrollView>
      {live.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.liveRow}>
          {live.map((st) => (
            <Pressable key={st.url} style={s.liveCard} onPress={() => router.push(liveHref(st, server) as any)} accessibilityLabel={`${st.channel.display_name} is live: ${st.title}`}>
              <View>
                <Avatar uri={api.abs(st.channel.avatar_url)} name={st.channel.display_name} size={44} />
                <View style={s.liveDot} />
              </View>
              <View style={{ flexShrink: 1 }}>
                <Text style={s.liveName} numberOfLines={1}>
                  {st.channel.display_name}
                </Text>
                <Text style={s.liveTitle} numberOfLines={1}>
                  {st.title}
                </Text>
                <Text style={s.liveMeta}>{`LIVE · ${compact(st.viewers)} watching`}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );

  const empty =
    current.key === 'subs' ? (
      <Empty icon="subscriptions" title="Nothing from your subscriptions yet">
        Subscribe to channels and their new clips show up here.
      </Empty>
    ) : current.key === 'foryou' ? (
      <Empty icon="auto-awesome" title="Nothing picked yet">
        Like a few clips and subscribe to some channels, and this fills up.
      </Empty>
    ) : (
      <Empty title="No clips yet">
        <View style={{ marginTop: 8 }}>{user ? <Button title="Upload a clip" kind="accent" icon="file-upload" onPress={() => router.push('/upload')} /> : null}</View>
      </Empty>
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader />
      {!!siteError && <ErrorBox message={siteError} onRetry={refresh} />}
      <VideoList paged={paged} header={header} empty={empty} />
    </View>
  );
}

const s = StyleSheet.create({
  chips: { gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  liveRow: { gap: 10, paddingHorizontal: 12, paddingBottom: 12 },
  liveCard: { flexDirection: 'row', alignItems: 'center', gap: 10, width: 250, padding: 10, borderRadius: 12, backgroundColor: colors.surface },
  liveDot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.surface },
  liveName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  liveTitle: { color: colors.text2, fontSize: 12.5 },
  liveMeta: { color: colors.accent, fontSize: 11.5, fontWeight: '700', marginTop: 2 },
});
