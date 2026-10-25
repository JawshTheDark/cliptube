import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { VideoList } from '@/components/VideoList';
import { Chip, Empty, ErrorBox } from '@/components/ui';
import { ApiScope, useLinkedApi } from '@/lib/scope';
import { usePaged } from '@/lib/usePaged';
import { plural } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Game, Video } from '@/lib/types';

const SORTS = [
  { key: 'new', label: 'Latest' },
  { key: 'views', label: 'Most viewed' },
  { key: 'top', label: 'Top rated' },
];

export default function GameScreen() {
  const { id, server } = useLocalSearchParams<{ id: string; server?: string }>();
  const scope = useLinkedApi(server);
  const { api } = scope;
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState('new');
  const paged = usePaged<Video>(api, `/videos?game=${encodeURIComponent(id)}&scope=all&sort=${sort}`);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ game: Game }>(`/games/${encodeURIComponent(id)}`)
      .then((r) => setGame(r.game))
      .catch((e) => setError(e.message));
  }, [api, id]);
  useEffect(load, [load]);

  const hero = api.abs(game?.hero_url || null);
  const logo = api.abs(game?.logo_url || null);
  const n = (game?.video_count || 0) + (game?.network_count || 0);
  const header = game ? (
    <View>
      {hero ? (
        <View style={s.hero}>
          <Image source={{ uri: hero }} style={StyleSheet.absoluteFill} contentFit="cover" />
          {logo && <Image source={{ uri: logo }} style={s.logo} contentFit="contain" />}
        </View>
      ) : null}
      <View style={s.head}>
        <Text style={s.name}>{game.name}</Text>
        <Text style={s.meta}>{plural(n, 'clip')}</Text>
      </View>
      <View style={s.sorts}>
        {SORTS.map((x) => (
          <Chip key={x.key} label={x.label} active={sort === x.key} onPress={() => setSort(x.key)} />
        ))}
      </View>
    </View>
  ) : null;

  return (
    <ApiScope value={scope}>
      <Stack.Screen options={{ title: game?.name || '' }} />
      {error ? <ErrorBox message={error} onRetry={load} /> : <VideoList paged={paged} header={header} empty={<Empty icon="sports-esports" title="No clips of this game yet" />} />}
    </ApiScope>
  );
}

const s = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 96 / 31, backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' },
  logo: { width: '60%', height: '60%' },
  head: { padding: 12, gap: 2 },
  name: { color: colors.text, fontSize: 22, fontWeight: '700' },
  meta: { color: colors.text2, fontSize: 13 },
  sorts: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
});
