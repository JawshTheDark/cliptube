import { useCallback } from 'react';
import { Alert, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { VideoList } from '@/components/VideoList';
import { VideoRow } from '@/components/VideoCard';
import { Avatar, Button, Empty, ErrorBox, Icon, IconButton, Loading, toast } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { ago, compact } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { SubscriptionChannel, Video } from '@/lib/types';

const TITLES: Record<string, string> = { mine: 'Your clips', history: 'History', liked: 'Liked clips', subscriptions: 'Subscriptions' };

export default function Library() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const { user } = useSession();
  if (!user) {
    return (
      <Empty icon="lock-outline" title="Sign in first">
        <View style={{ marginTop: 8 }}>
          <Button title="Sign in" kind="primary" onPress={() => router.push('/login')} />
        </View>
      </Empty>
    );
  }
  return (
    <>
      <Stack.Screen options={{ title: TITLES[kind] || '' }} />
      {kind === 'subscriptions' ? <Subscriptions /> : kind === 'mine' ? <Mine /> : <Clips kind={kind === 'liked' ? 'liked' : 'history'} />}
    </>
  );
}

function Clips({ kind }: { kind: 'history' | 'liked' }) {
  const { api } = useSession();
  const paged = usePaged<Video>(api, `/me/${kind}`, (r) => r.videos, false);

  const clear = () =>
    Alert.alert('Clear watch history?', 'This removes every clip from your history on this server.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () =>
          api
            .del('/me/history')
            .then(() => paged.reload())
            .catch((e) => toast(e.message)),
      },
    ]);

  return (
    <VideoList
      paged={paged}
      rows
      header={kind === 'history' && paged.items.length > 0 ? <Button title="Clear history" icon="delete-sweep" small kind="ghost" onPress={clear} style={{ alignSelf: 'flex-end', margin: 12 }} /> : null}
      empty={kind === 'history' ? <Empty icon="history" title="Nothing watched yet" /> : <Empty icon="thumb-up-off-alt" title="No liked clips yet" />}
    />
  );
}

const STATUS: Record<string, string> = { queued: 'Waiting to process', processing: 'Processing', failed: 'Processing failed' };

/** Your uploads, including drafts and private ones, with their state and an edit button. */
function Mine() {
  const { api } = useSession();
  const paged = usePaged<Video>(api, '/me/videos', (r) => r.videos, false);
  // Come back from editing to fresh data.
  useFocusEffect(
    useCallback(() => {
      paged.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  if (paged.loading && !paged.items.length) return <Loading />;
  return (
    <FlatList
      data={paged.items}
      keyExtractor={(v) => v.id}
      ListHeaderComponent={paged.error ? <ErrorBox message={paged.error} onRetry={paged.reload} /> : undefined}
      ListEmptyComponent={
        <Empty icon="video-library" title="No clips yet">
          <View style={{ marginTop: 8 }}>
            <Button title="Upload a clip" kind="accent" icon="file-upload" onPress={() => router.push('/upload')} />
          </View>
        </Empty>
      }
      onRefresh={paged.refresh}
      refreshing={paged.refreshing}
      renderItem={({ item: v }) => {
        const state = STATUS[v.status] || (v.draft ? 'Draft, not published' : v.moderation_status ? `${v.moderation_status} by a moderator` : null);
        const extra = [v.visibility, state || `${compact(v.views)} views`, ago(v.created_at)].filter(Boolean).join(' · ');
        return <VideoRow v={v} extra={extra} right={<IconButton name="edit" label={`Edit ${v.title}`} onPress={() => router.push(`/edit/${encodeURIComponent(v.id)}`)} />} />;
      }}
    />
  );
}

function Subscriptions() {
  const { api } = useSession();
  const paged = usePaged<SubscriptionChannel>(api, '/me/subscriptions', (r) => r.channels, false);
  if (paged.loading) return <Loading />;
  return (
    <FlatList
      data={paged.items}
      keyExtractor={(c) => c.id}
      onRefresh={paged.refresh}
      refreshing={paged.refreshing}
      ListHeaderComponent={paged.error ? <ErrorBox message={paged.error} onRetry={paged.reload} /> : undefined}
      ListEmptyComponent={<Empty icon="subscriptions" title="No subscriptions yet">Subscribe to channels from their clips.</Empty>}
      renderItem={({ item: c }) => (
        <Pressable
          style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}
          onPress={() => (c.remote ? c.remote.profile_url && Linking.openURL(c.remote.profile_url) : router.push(`/c/${encodeURIComponent(c.username)}`))}
        >
          <Avatar uri={api.abs(c.avatar_url)} name={c.display_name} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>
              {c.display_name}
            </Text>
            <Text style={s.hint} numberOfLines={1}>
              {c.remote ? `@${c.username} · ${c.remote.peer_name}` : `@${c.username}`}
            </Text>
          </View>
          {c.remote && <Icon name="open-in-new" size={18} color={colors.text2} />}
        </Pressable>
      )}
    />
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.text2, fontSize: 13 },
});
