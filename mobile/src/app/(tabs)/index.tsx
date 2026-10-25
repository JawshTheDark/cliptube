import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { AppHeader } from '@/components/AppHeader';
import { VideoList } from '@/components/VideoList';
import { Button, Chip, Empty, ErrorBox } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

type Feed = { key: string; label: string; path: string };

export default function Home() {
  const { api, user, site, siteError, refresh, server } = useSession();
  const [feed, setFeed] = useState('all');
  const [tags, setTags] = useState<string[]>([]);
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} style={{ backgroundColor: colors.bg }}>
      {feeds.map((f) => (
        <Chip key={f.key} label={f.label} active={f.key === current.key} onPress={() => setFeed(f.key)} />
      ))}
    </ScrollView>
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
});
