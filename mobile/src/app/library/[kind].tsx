import { useCallback, useState } from 'react';
import { Alert, FlatList, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { PlaylistRow } from '@/components/PlaylistRow';
import { f } from '@/components/VideoForm';
import { Redirect, router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { VideoList } from '@/components/VideoList';
import { VideoRow } from '@/components/VideoCard';
import { Avatar, Button, Empty, ErrorBox, Icon, IconButton, Loading, toast } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { ago, plural } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { PlaylistSummary, SubscriptionChannel, Video } from '@/lib/types';

const TITLES: Record<string, string> = {
  mine: 'Your videos',
  history: 'History',
  liked: 'Liked videos',
  subscriptions: 'Subscriptions',
  playlists: 'Playlists',
  parties: 'Watch parties',
};

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
      {kind === 'subscriptions' ? (
        <Subscriptions />
      ) : kind === 'mine' ? (
        // Your videos moved to the Studio (1.7).
        <Redirect href={'/studio' as any} />
      ) : kind === 'playlists' ? (
        <MyPlaylists />
      ) : kind === 'parties' ? (
        <MyParties />
      ) : (
        <Videos kind={kind === 'liked' ? 'liked' : 'history'} />
      )}
    </>
  );
}

function Videos({ kind }: { kind: 'history' | 'liked' }) {
  const { api } = useSession();
  const paged = usePaged<Video>(api, `/me/${kind}`, (r) => r.videos, false);

  const clear = () =>
    Alert.alert('Clear watch history?', 'This removes every video from your history on this server.', [
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
      empty={kind === 'history' ? <Empty icon="history" title="Nothing watched yet" /> : <Empty icon="thumb-up-off-alt" title="No liked videos yet" />}
    />
  );
}

function MyPlaylists() {
  const { api } = useSession();
  const paged = usePaged<PlaylistSummary>(api, '/playlists/mine', (r) => r.playlists, false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      paged.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ playlist: { id: string } }>('/playlists', { title: name.trim(), visibility: 'public' });
      setName('');
      router.push(`/playlist/${encodeURIComponent(r.playlist.id)}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FlatList
      data={paged.items}
      keyExtractor={(p) => p.id}
      onRefresh={paged.refresh}
      refreshing={paged.refreshing}
      ListHeaderComponent={
        <View style={{ padding: 12, gap: 8 }}>
          {!!paged.error && <ErrorBox message={paged.error.includes('Not found') ? 'Playlists need OurTube 1.7 or newer on this server.' : paged.error} onRetry={paged.reload} />}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput value={name} onChangeText={setName} placeholder="New playlist name" placeholderTextColor={colors.text2} style={[f.input, { flex: 1 }]} maxLength={100} onSubmitEditing={() => name.trim() && create()} />
            <Button title="Create" icon="playlist-add" onPress={create} disabled={!name.trim()} busy={busy} />
          </View>
        </View>
      }
      ListEmptyComponent={paged.loading ? <Loading /> : undefined}
      renderItem={({ item }) => <PlaylistRow p={item} />}
    />
  );
}

type HostedParty = { id: string; title: string; members: number; last_active_at: number };

/** Watch parties you host, to get back to them. */
function MyParties() {
  const { api } = useSession();
  const paged = usePaged<HostedParty>(api, '/parties/mine', (r) => r.parties, false);
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
      keyExtractor={(p) => p.id}
      onRefresh={paged.refresh}
      refreshing={paged.refreshing}
      ListHeaderComponent={paged.error ? <ErrorBox message={paged.error.includes('Not found') ? 'Watch parties need OurTube 1.8 or newer on this server.' : paged.error} onRetry={paged.reload} /> : undefined}
      ListEmptyComponent={<Empty icon="groups" title="No watch parties">Start one with Watch together on a video or a playlist.</Empty>}
      renderItem={({ item }) => (
        <Pressable style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]} onPress={() => router.push(`/party/${encodeURIComponent(item.id)}`)}>
          <View style={s.partyIcon}>
            <Icon name="groups" size={24} color={colors.text} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={s.hint}>{`${item.members} watching now · active ${ago(item.last_active_at)}`}</Text>
          </View>
          <Icon name="chevron-right" size={22} color={colors.text2} />
        </Pressable>
      )}
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
      ListEmptyComponent={<Empty icon="subscriptions" title="No subscriptions yet">Subscribe to channels from their videos.</Empty>}
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
  partyIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
