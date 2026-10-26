import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, Heading } from '@/components/Text';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/components/AppHeader';
import { ServerTag } from '@/components/ServerTag';
import { ShortCard } from '@/components/VideoCard';
import { VideoList } from '@/components/VideoList';
import { Avatar, Button, Chip, Empty, ErrorBox, Icon, LiveBadge, Segmented } from '@/components/ui';
import { compact } from '@/lib/format';
import { liveHref } from '@/lib/refs';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { colors } from '@/lib/theme';
import type { LiveNow, LiveStream, Video } from '@/lib/types';

type Format = 'all' | 'videos' | 'shorts';
type Feed = { key: string; label: string; path: string; mixed?: boolean; shelf?: boolean };

const FORMATS: { key: Format; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'videos', label: 'Videos' },
  { key: 'shorts', label: 'Shorts' },
];
const SHELF_AFTER = 8; // landscape videos above the Shorts shelf, as on the website

export default function Home() {
  const { api, user, site, siteError, refresh, server } = useSession();
  const [feed, setFeed] = useState('all');
  const [format, setFormat] = useState<Format>('all');
  const [tags, setTags] = useState<string[]>([]);
  const [live, setLive] = useState<LiveStream[]>([]);
  const [shorts, setShorts] = useState<Video[]>([]);

  // Who's live, here and on the rest of the network (OurTube 1.9; older servers have none).
  const loadLive = useCallback(() => {
    if (!server) return;
    api
      .get<LiveNow>('/live/now')
      .then((r) => setLive([...(r.live || []), ...(r.network || [])]))
      .catch(() => setLive([]));
  }, [api, server]);
  useFocusEffect(loadLive);
  const networked = !!site?.federation && (site.network_peers || []).length > 0;
  const scope = networked ? 'all' : 'local';

  useEffect(() => {
    setTags([]);
    api
      .get<{ tags: { tag: string }[] }>('/videos/tags')
      .then((r) => setTags(r.tags.slice(0, 12).map((t) => t.tag)))
      .catch(() => {});
  }, [api]);

  // The website's chips. Shorts are videos taller than they are wide; For you and Subscriptions mix every kind.
  const feeds = useMemo<Feed[]>(() => {
    const list: Feed[] = [{ key: 'all', label: 'All', path: `/videos?sort=new&scope=${scope}`, shelf: true }];
    if (networked) list.push({ key: 'local', label: 'This site', path: '/videos?sort=new&scope=local', shelf: true });
    if (user) {
      list.push({ key: 'foryou', label: 'For you', path: '/feed/for-you?hide_watched=0', mixed: true });
      list.push({ key: 'subs', label: 'Subscriptions', path: '/me/feed', mixed: true });
    }
    list.push({ key: 'trending', label: 'Trending', path: `/videos?sort=views&scope=${scope}` });
    list.push({ key: 'top', label: 'Top rated', path: `/videos?sort=top&scope=${scope}` });
    for (const t of tags) list.push({ key: `tag:${t}`, label: `#${t}`, path: `/videos?sort=new&scope=${scope}&tag=${encodeURIComponent(t)}` });
    return list;
  }, [networked, user, tags, scope]);

  const current = feeds.find((f) => f.key === feed) || feeds[0];
  // A feed that disappears (signed out, other server) falls back to All.
  useEffect(() => {
    if (!feeds.some((f) => f.key === feed)) setFeed('all');
  }, [feeds, feed]);
  useEffect(() => {
    setFeed('all');
    setFormat('all');
  }, [server]);

  const kind: Format = current.mixed ? 'all' : format;
  // Everything, newest first, keeps Shorts on a shelf of their own instead of in the list.
  const shelf = kind === 'all' && !!current.shelf;
  const shape = kind === 'shorts' ? '&shape=vertical' : kind === 'videos' || shelf ? '&shape=landscape' : '';
  const paged = usePaged<Video>(api, current.mixed ? current.path : `${current.path}${shape}`);

  const shelfScope = current.key === 'local' ? 'local' : scope;
  useEffect(() => {
    if (!shelf) {
      setShorts([]);
      return;
    }
    let dead = false;
    api
      .get<{ videos: Video[] }>(`/videos?sort=new&scope=${shelfScope}&shape=vertical&limit=12`)
      .then((r) => !dead && setShorts(r.videos || []))
      .catch(() => !dead && setShorts([]));
    return () => {
      dead = true;
    };
  }, [api, shelf, shelfScope]);

  const pickFormat = (f: Format) => {
    setFormat(f);
    // Videos or Shorts can't narrow For you or Subscriptions, so they go back to All.
    if (f !== 'all' && current.mixed) setFeed('all');
  };

  const header = (
    <View>
      <View style={s.formats}>
        <Segmented options={FORMATS} value={kind} onChange={pickFormat} />
      </View>
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
              <View style={{ flexShrink: 1, gap: 2 }}>
                <Text style={s.liveName} numberOfLines={1}>
                  {st.channel.display_name}
                </Text>
                <Text style={s.liveTitle} numberOfLines={1}>
                  {st.title}
                </Text>
                <View style={s.liveMetaRow}>
                  <LiveBadge small />
                  <Text style={s.liveMeta}>{`${compact(st.viewers)} watching`}</Text>
                </View>
                <ServerTag remote={st.remote} small />
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );

  const shelfView = shorts.length ? (
    <View style={s.shelf}>
      <View style={s.shelfHead}>
        <Icon name="smart-display" size={22} color={colors.accentText} />
        <Heading style={s.shelfTitle}>Shorts</Heading>
        <Pressable onPress={() => pickFormat('shorts')} hitSlop={8} style={{ marginLeft: 'auto' }} accessibilityRole="button">
          <Text style={s.seeAll}>See all</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingHorizontal: 12 }}>
        {shorts.map((v) => (
          <ShortCard key={v.id} v={v} style={{ width: 140 }} />
        ))}
      </ScrollView>
    </View>
  ) : null;

  const empty =
    current.key === 'subs' ? (
      <Empty icon="subscriptions" title="Nothing from your subscriptions yet">
        Subscribe to channels and their new videos show up here.
      </Empty>
    ) : current.key === 'foryou' ? (
      <Empty icon="auto-awesome" title="Nothing picked yet">
        Like a few videos and subscribe to some channels, and this fills up.
      </Empty>
    ) : shelfView ? (
      shelfView // only Shorts so far
    ) : (
      <Empty title={kind === 'shorts' ? 'No Shorts yet' : current.key.startsWith('tag:') ? `No videos tagged ${current.label}` : 'No videos yet'}>
        <View style={{ marginTop: 8 }}>{user ? <Button title="Upload a video" kind="accent" icon="file-upload" onPress={() => router.push('/upload')} /> : null}</View>
      </Empty>
    );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader />
      {!!siteError && <ErrorBox message={siteError} onRetry={refresh} />}
      <VideoList paged={paged} header={header} empty={empty} shorts={kind === 'shorts'} slot={shelf ? shelfView : null} slotAfter={SHELF_AFTER} />
    </View>
  );
}

const s = StyleSheet.create({
  formats: { paddingHorizontal: 12, paddingTop: 4 },
  chips: { gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  liveRow: { gap: 10, paddingHorizontal: 12, paddingBottom: 14 },
  liveCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: 260,
    padding: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.liveBorder,
    backgroundColor: colors.liveSoft,
  },
  liveDot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.live, borderWidth: 2, borderColor: colors.surface },
  liveName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  liveTitle: { color: colors.text2, fontSize: 12.5 },
  liveMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveMeta: { color: colors.text2, fontSize: 11.5, fontWeight: '600' },
  shelf: { paddingTop: 4, paddingBottom: 22 },
  shelfHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, marginBottom: 12 },
  shelfTitle: { fontSize: 21 },
  seeAll: { color: colors.link, fontWeight: '700', fontSize: 14 },
});
