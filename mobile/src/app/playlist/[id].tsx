import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Button, Empty, ErrorBox, Icon, IconButton, Loading, toast } from '@/components/ui';
import { f } from '@/components/VideoForm';
import { ApiScope, useLinkedApi, withServer } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { duration, hostOf, plural } from '@/lib/format';
import { colors } from '@/lib/theme';
import { itemHref } from '@/lib/refs';
import type { Playlist, PlaylistItem, PlaylistSummary, Visibility } from '@/lib/types';

const VIS: Visibility[] = ['public', 'unlisted', 'private'];

export default function PlaylistScreen() {
  const { id, server } = useLocalSearchParams<{ id: string; server?: string }>();
  const scope = useLinkedApi(server);
  const { api, foreign } = scope;
  const { user, server: active } = useSession();
  const [p, setP] = useState<Playlist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', visibility: 'public' as Visibility });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      let realId = id;
      // "watch-later" stands for your own Watch later list, whatever its id.
      if (id === 'watch-later') {
        const mine = await api.get<{ playlists: PlaylistSummary[] }>('/playlists/mine');
        realId = mine.playlists.find((x) => x.kind === 'watch_later')?.id || '';
      }
      const r = await api.get<{ playlist: Playlist }>(`/playlists/${encodeURIComponent(realId)}`);
      setP(r.playlist);
    } catch (e: any) {
      setError(e.status === 404 ? 'This playlist is private or gone.' : e.status === 401 ? 'Sign in to see your Watch later list.' : e.message);
    }
  }, [api, id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!p) return <Loading />;

  const own = p.is_owner && !foreign;
  const playable = p.items.filter((it) => it.available);
  const open = (it: PlaylistItem, shuffle = false) => router.push(withServer(itemHref(it, p.id, shuffle), foreign) as any);

  const watchTogether = async () => {
    if (foreign) return toast(`Switch to ${hostOf(foreign)} to start a watch party`);
    if (!user) return router.push('/login');
    try {
      const r = await api.post<{ party: { id: string } }>('/parties', { playlist_id: p.id });
      router.push(`/party/${r.party.id}`);
    } catch (e: any) {
      toast(e.message);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= p.items.length) return;
    const ids = p.items.map((it) => it.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    // Show the new order at once; the server's answer replaces it.
    const items = [...p.items];
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    setP({ ...p, items });
    run(() => api.put(`/playlists/${encodeURIComponent(p.id)}/order`, { item_ids: ids }));
  };

  const remove = (it: PlaylistItem) => run(() => api.del(`/playlists/${encodeURIComponent(p.id)}/items/${it.id}`));

  const startEdit = () => {
    setDraft({ title: p.title, description: p.description || '', visibility: p.visibility });
    setEditing(true);
  };
  const saveEdit = () =>
    run(async () => {
      await api.patch(`/playlists/${encodeURIComponent(p.id)}`, p.kind === 'watch_later' ? { description: draft.description } : draft);
      setEditing(false);
    });
  const del = () =>
    Alert.alert('Delete this playlist?', `"${p.title}" is deleted. The clips in it stay where they are.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.del(`/playlists/${encodeURIComponent(p.id)}`);
            toast('Playlist deleted');
            router.back();
          } catch (e: any) {
            toast(e.message);
          }
        },
      },
    ]);

  const header = (
    <View style={{ padding: 12, gap: 10 }}>
      <Text style={s.title}>{p.title}</Text>
      <Text style={s.meta}>
        {[p.owner?.display_name, plural(p.item_count, 'clip'), p.visibility !== 'public' ? p.visibility : null].filter(Boolean).join(' · ')}
      </Text>
      {!!p.description && <Text style={s.desc}>{p.description}</Text>}
      {playable.length > 0 && (
        <View style={s.actions}>
          <Button title="Play all" kind="primary" icon="play-arrow" onPress={() => open(playable[0])} />
          <Button title="Shuffle" icon="shuffle" onPress={() => open(playable[Math.floor(Math.random() * playable.length)], true)} />
          {p.kind !== 'watch_later' || own ? <Button title="Watch together" icon="groups" onPress={watchTogether} /> : null}
        </View>
      )}
      <View style={s.actions}>
        {p.visibility !== 'private' && (
          <Button title="Share" icon="share" small onPress={() => Share.share({ message: `${foreign || active}/playlist/${p.id}` }).catch(() => {})} />
        )}
        {own && !editing && <Button title="Edit" icon="edit" small onPress={startEdit} />}
        {own && p.kind === 'user' && <Button title="Delete" icon="delete-outline" small kind="danger" onPress={del} />}
      </View>
      {editing && (
        <View style={s.editBox}>
          {p.kind === 'user' && (
            <>
              <TextInput value={draft.title} onChangeText={(t) => setDraft({ ...draft, title: t })} style={f.input} placeholder="Name" placeholderTextColor={colors.text2} maxLength={100} />
              <View style={s.actions}>
                {VIS.map((v) => (
                  <Pressable key={v} onPress={() => setDraft({ ...draft, visibility: v })} style={[s.vis, draft.visibility === v && s.visOn]}>
                    <Text style={{ color: draft.visibility === v ? colors.bg : colors.text, fontWeight: '600' }}>{v[0].toUpperCase() + v.slice(1)}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          <TextInput
            value={draft.description}
            onChangeText={(t) => setDraft({ ...draft, description: t })}
            style={[f.input, { minHeight: 70, textAlignVertical: 'top' }]}
            placeholder="Description"
            placeholderTextColor={colors.text2}
            multiline
            maxLength={2000}
          />
          <View style={s.actions}>
            <Button title="Save" kind="primary" small onPress={saveEdit} busy={busy} />
            <Button title="Cancel" small onPress={() => setEditing(false)} />
          </View>
        </View>
      )}
    </View>
  );

  return (
    <ApiScope value={scope}>
      <Stack.Screen options={{ title: p.kind === 'watch_later' ? 'Watch later' : 'Playlist' }} />
      <FlatList
        data={p.items}
        keyExtractor={(it) => String(it.id)}
        ListHeaderComponent={header}
        ListEmptyComponent={<Empty icon="playlist-add" title="No clips yet">{own ? 'Save clips here from their Save button.' : ''}</Empty>}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item, index }) => {
          const v = item.video;
          const thumb = api.abs(v?.community?.thumbnail_url || v?.thumbnail_url || item.thumbnail_url);
          return (
            <Pressable onPress={() => item.available && open(item)} style={({ pressed }) => [s.row, pressed && item.available && { backgroundColor: colors.surface }, !item.available && { opacity: 0.5 }]}>
              <Text style={s.index}>{index + 1}</Text>
              <View style={s.thumb}>
                {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Icon name="movie" size={24} color={colors.text2} />}
                {!!v?.duration && (
                  <View style={s.badge}>
                    <Text style={s.badgeText}>{duration(v.duration)}</Text>
                  </View>
                )}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.itemTitle} numberOfLines={2}>
                  {v?.community?.title || item.title}
                </Text>
                <Text style={s.meta} numberOfLines={1}>
                  {item.available ? [v?.uploader.display_name, v?.remote ? v.remote.peer_name || hostOf(v.remote.peer_url) : null].filter(Boolean).join(' · ') : 'No longer available'}
                </Text>
              </View>
              {own && (
                <View style={s.ownActions}>
                  <IconButton name="keyboard-arrow-up" size={20} label="Move up" onPress={() => move(index, index - 1)} color={index === 0 ? colors.surface3 : colors.text2} />
                  <IconButton name="keyboard-arrow-down" size={20} label="Move down" onPress={() => move(index, index + 1)} color={index === p.items.length - 1 ? colors.surface3 : colors.text2} />
                  <IconButton name="close" size={20} label="Remove from playlist" onPress={() => remove(item)} color={colors.text2} />
                </View>
              )}
            </Pressable>
          );
        }}
      />
    </ApiScope>
  );
}

const s = StyleSheet.create({
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  meta: { color: colors.text2, fontSize: 12.5 },
  desc: { color: colors.text, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editBox: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  vis: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.surface2 },
  visOn: { backgroundColor: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4, paddingRight: 4, paddingVertical: 6 },
  index: { color: colors.text2, width: 26, textAlign: 'center', fontSize: 12 },
  thumb: { width: 120, aspectRatio: 16 / 9, borderRadius: 6, backgroundColor: colors.surface, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: 4, bottom: 4, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 3, paddingHorizontal: 3 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  itemTitle: { color: colors.text, fontSize: 14, fontWeight: '500' },
  ownActions: { flexDirection: 'column' },
});
