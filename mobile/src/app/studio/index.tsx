import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { MoreMenu } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { isBusy, StatusBadge, VisibilityBadge } from '@/components/StudioBadges';
import { Text } from '@/components/Text';
import { Thumb } from '@/components/VideoCard';
import { Button, Empty, ErrorBox, Loading, toast } from '@/components/ui';
import { ago, compact, plural } from '@/lib/format';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

const edit = (v: Video) => router.push(`/studio/edit/${encodeURIComponent(v.id)}` as any);

/** Your videos, the website's Studio: every upload with its state, and editing, analytics, retrying and deleting. */
export default function Studio() {
  const { api, user } = useSession();
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<{ videos: Video[] }>('/me/videos')
        .then((r) => {
          setVideos(r.videos);
          setError(null);
        })
        .catch((e) => setError(e.message)),
    [api],
  );
  // Fresh each time it comes back on top (after editing, uploading or clipping).
  useFocusEffect(
    useCallback(() => {
      load();
      api
        .get<{ comments: unknown[] }>('/me/comments/held')
        .then((r) => setHeld(r.comments.length))
        .catch(() => {});
    }, [api, load]),
  );
  const busy = videos?.some(isBusy);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const del = async (v: Video) => {
    if (!(await confirm(`Delete "${v.title}"?`, 'This permanently removes the video and its comments.', { confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await api.del(`/videos/${encodeURIComponent(v.id)}`);
      setVideos((list) => (list || []).filter((x) => x.id !== v.id));
      toast('Video deleted');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const retry = async (v: Video) => {
    try {
      const r = await api.post<{ video: Video }>(`/videos/${encodeURIComponent(v.id)}/retry`);
      setVideos((list) => (list || []).map((x) => (x.id === v.id ? { ...x, ...r.video } : x)));
      toast('Processing restarted');
    } catch (e: any) {
      toast(e.message);
    }
  };

  if (!user) {
    return (
      <Empty icon="lock-outline" title="Sign in first">
        <View style={{ marginTop: 8 }}>
          <Button title="Sign in" kind="primary" onPress={() => router.push('/login')} />
        </View>
      </Empty>
    );
  }
  if (!videos && !error) return <Loading />;
  const header = (
    <View style={{ gap: 10, paddingBottom: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Button title="Upload" kind="accent" icon="file-upload" small onPress={() => router.push('/upload')} />
        <Button title="Analytics" icon="insights" small onPress={() => router.push('/studio/analytics' as any)} />
        <Button title={held ? `Comments to review · ${held}` : 'Comments to review'} icon="hourglass-top" small onPress={() => router.push('/studio/comments' as any)} />
      </ScrollView>
      {!!error && <ErrorBox message={error} onRetry={load} />}
    </View>
  );
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[{ padding: 12, paddingBottom: 32 }, readable]}
      data={videos || []}
      keyExtractor={(v) => v.id}
      ListHeaderComponent={header}
      ListEmptyComponent={
        videos ? (
          <Empty icon="video-library" title="No videos yet">
            <View style={{ marginTop: 8 }}>
              <Button title="Upload your first clip" kind="accent" icon="file-upload" onPress={() => router.push('/upload')} />
            </View>
          </Empty>
        ) : undefined
      }
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
      renderItem={({ item: v }) => <Row v={v} onDelete={() => del(v)} onRetry={() => retry(v)} />}
    />
  );
}

function Row({ v, onDelete, onRetry }: { v: Video; onDelete: () => void; onRetry: () => void }) {
  const failed = v.status === 'failed' || v.render_status === 'failed';
  return (
    <View style={s.row}>
      <Pressable onPress={() => (v.status === 'ready' ? router.push(`/watch/${encodeURIComponent(v.id)}`) : edit(v))} accessibilityRole="button" accessibilityLabel={`Watch ${v.title}`}>
        <Thumb v={v} style={s.thumb} small />
      </Pressable>
      <Pressable style={{ flex: 1, gap: 4 }} onPress={() => edit(v)} accessibilityRole="button" accessibilityLabel={`Edit ${v.title}`}>
        <Text style={s.title} numberOfLines={2}>
          {v.title}
        </Text>
        <View style={s.badges}>
          <VisibilityBadge video={v} />
          <StatusBadge video={v} />
        </View>
        <Text style={s.meta} numberOfLines={2}>
          {`${ago(v.created_at)} · ${plural(v.views, 'view')} · ${compact(v.likes || 0)} likes · ${compact(v.comment_count || 0)} comments`}
        </Text>
        {!!(v.error || v.render_error) && failed && (
          <Text style={[s.meta, { color: colors.err }]} numberOfLines={2}>
            {v.render_error || v.error}
          </Text>
        )}
      </Pressable>
      <MoreMenu
        label={`More for ${v.title}`}
        title={v.title}
        items={[
          { label: 'Edit details', icon: 'edit', onPress: () => edit(v) },
          { label: 'Analytics', icon: 'insights', onPress: () => router.push({ pathname: '/studio/analytics' as any, params: { video: v.id } }) },
          ...(v.status === 'ready' ? [{ label: 'Watch', icon: 'play-arrow' as const, onPress: () => router.push(`/watch/${encodeURIComponent(v.id)}`) }] : []),
          ...(failed ? [{ label: 'Retry processing', icon: 'refresh' as const, onPress: onRetry }] : []),
          { label: 'Delete', icon: 'delete-outline', destructive: true, onPress: onDelete },
        ]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, paddingVertical: 8, alignItems: 'flex-start', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  thumb: { width: 150, aspectRatio: 16 / 9, borderRadius: 10 },
  title: { color: colors.text, fontSize: 14.5, fontWeight: '700', lineHeight: 19 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  meta: { color: colors.text2, fontSize: 12.5 },
});
