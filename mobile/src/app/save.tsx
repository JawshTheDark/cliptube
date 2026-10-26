import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, Empty, ErrorBox, Icon, Loading, toast } from '@/components/ui';
import { f } from '@/components/VideoForm';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import { readable } from '@/lib/layout';
import type { PlaylistSummary, Visibility } from '@/lib/types';

/** Save a video to Watch later or a playlist: tick the lists it should be in, or make a new one. */
export default function SaveSheet() {
  const { ref, title } = useLocalSearchParams<{ ref: string; title?: string }>();
  const { api, user } = useSession();
  const [lists, setLists] = useState<PlaylistSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [vis, setVis] = useState<Visibility>('public');

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ playlists: PlaylistSummary[] }>(`/playlists/mine?has=${encodeURIComponent(ref)}`)
      .then((r) => setLists(r.playlists))
      .catch((e) => setError(e.status === 404 ? 'Playlists need OurTube 1.7 or newer on this server.' : e.message));
  }, [api, ref]);
  useEffect(() => {
    if (user) load();
  }, [load, user]);

  if (!user) {
    return (
      <Empty icon="playlist-add" title="Sign in to save videos">
        <View style={{ marginTop: 8 }}>
          <Button title="Sign in" kind="primary" onPress={() => router.replace('/login')} />
        </View>
      </Empty>
    );
  }
  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!lists) return <Loading />;

  const toggle = async (p: PlaylistSummary) => {
    setBusy(p.id);
    try {
      if (p.contains) {
        const r = await api.del<{ item_count: number }>(`/playlists/${encodeURIComponent(p.id)}/items/${p.contains}`);
        setLists(lists.map((x) => (x.id === p.id ? { ...x, contains: null, item_count: r.item_count } : x)));
        toast(`Removed from ${p.title}`);
      } else {
        const r = await api.post<{ item: { id: number }; item_count: number }>(`/playlists/${encodeURIComponent(p.id)}/items`, { ref });
        setLists(lists.map((x) => (x.id === p.id ? { ...x, contains: r.item.id, item_count: r.item_count } : x)));
        toast(`Saved to ${p.title}`);
      }
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy('new');
    try {
      await api.post('/playlists', { title: name.trim(), visibility: vis, ref });
      toast(`Saved to ${name.trim()}`);
      router.back();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 16, gap: 10 }, readable]} keyboardShouldPersistTaps="handled" bottomOffset={24}>
      {!!title && (
        <Text style={s.hint} numberOfLines={2}>
          {title}
        </Text>
      )}
      {lists.map((p) => (
        <Pressable key={p.id} onPress={() => toggle(p)} disabled={!!busy} style={s.row} accessibilityRole="checkbox" accessibilityState={{ checked: !!p.contains }}>
          <Icon name={p.contains ? 'check-box' : 'check-box-outline-blank'} size={24} color={p.contains ? colors.accent : colors.text2} />
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{p.title}</Text>
            <Text style={s.hint}>{[`${p.item_count} video${p.item_count === 1 ? '' : 's'}`, p.visibility].join(' · ')}</Text>
          </View>
          {p.kind === 'watch_later' && <Icon name="watch-later" size={20} color={colors.text2} />}
        </Pressable>
      ))}

      <Text style={s.section}>New playlist</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.text2} style={f.input} maxLength={100} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['public', 'unlisted', 'private'] as Visibility[]).map((v) => (
          <Pressable key={v} onPress={() => setVis(v)} style={[s.vis, vis === v && s.visOn]}>
            <Text style={{ color: vis === v ? colors.bg : colors.text, fontWeight: '600' }}>{v[0].toUpperCase() + v.slice(1)}</Text>
          </Pressable>
        ))}
      </View>
      <Button title="Create and save" kind="primary" icon="playlist-add" onPress={create} disabled={!name.trim()} busy={busy === 'new'} />
    </KeyboardAwareScrollView>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.text2, fontSize: 13 },
  section: { color: colors.text2, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12 },
  vis: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.surface2 },
  visOn: { backgroundColor: colors.text },
});
