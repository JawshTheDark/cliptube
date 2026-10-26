import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VideoList } from '@/components/VideoList';
import { Chip, Empty, ErrorBox, Icon, IconButton, Loading } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { compact } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Game, Video } from '@/lib/types';

const SORTS = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'new', label: 'Newest' },
  { key: 'views', label: 'Most viewed' },
];

export default function Explore() {
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('relevance');

  const path = query ? `/search?q=${encodeURIComponent(query)}&where=all&sort=${sort}` : null;
  const results = usePaged<Video>(api, path);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[s.searchBar, { paddingTop: insets.top + 8 }]}>
        <View style={s.inputWrap}>
          <Icon name="search" size={20} color={colors.text2} />
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => setQuery(text.trim())}
            placeholder="Search videos, channels, games"
            placeholderTextColor={colors.text2}
            returnKeyType="search"
            style={s.input}
            autoCorrect={false}
          />
          {!!text && (
            <IconButton
              name="close"
              size={18}
              label="Clear search"
              onPress={() => {
                setText('');
                setQuery('');
              }}
            />
          )}
        </View>
      </View>
      {query ? (
        <VideoList
          paged={results}
          rows
          header={
            <View style={s.sorts}>
              {SORTS.map((x) => (
                <Chip key={x.key} label={x.label} active={sort === x.key} onPress={() => setSort(x.key)} />
              ))}
            </View>
          }
          empty={<Empty icon="search-off" title={`No results for "${query}"`}>Try other words, or fewer of them.</Empty>}
        />
      ) : (
        <Games />
      )}
    </View>
  );
}

/** The game catalog as an artwork grid, most videos first. */
function Games() {
  const { api } = useSession();
  const { width } = useWindowDimensions();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cols = width > 700 ? 4 : 2;
  const tile = (width - 12 * (cols + 1)) / cols;

  const load = () => {
    setError(null);
    api
      .get<{ games: Game[] }>('/games')
      .then((r) => setGames(r.games))
      .catch((e) => setError(e.message));
  };
  useEffect(load, [api]);

  const sorted = useMemo(
    () => (games || []).filter((g) => (g.video_count || 0) + (g.network_count || 0) > 0).sort((a, b) => (b.video_count || 0) + (b.network_count || 0) - ((a.video_count || 0) + (a.network_count || 0))),
    [games],
  );

  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!games) return <Loading />;
  return (
    <FlatList
      key={cols}
      data={sorted}
      numColumns={cols}
      keyExtractor={(g) => g.id}
      columnWrapperStyle={{ gap: 12, paddingHorizontal: 12 }}
      contentContainerStyle={{ gap: 14, paddingBottom: 24 }}
      ListHeaderComponent={<Text style={s.section}>Games</Text>}
      ListEmptyComponent={<Empty icon="sports-esports" title="No games yet">Videos filed under a game show up here.</Empty>}
      renderItem={({ item }) => {
        const art = api.abs(item.artwork_url);
        const n = (item.video_count || 0) + (item.network_count || 0);
        return (
          <Pressable style={{ width: tile }} onPress={() => router.push(`/g/${encodeURIComponent(item.id)}`)} accessibilityRole="button" accessibilityLabel={item.name}>
            <View style={[s.art, { height: tile * 1.5 }]}>
              {art ? <Image source={{ uri: art }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : <Icon name="sports-esports" size={40} color={colors.text2} />}
            </View>
            <Text style={s.gameName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={s.gameMeta}>{`${compact(n)} video${n === 1 ? '' : 's'}`}</Text>
          </Pressable>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  searchBar: { paddingHorizontal: 12, paddingBottom: 8, backgroundColor: colors.bg },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: 22, paddingLeft: 14, paddingRight: 4, minHeight: 44, gap: 8 },
  input: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 8 },
  sorts: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  section: { color: colors.text, fontSize: 18, fontWeight: '700', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  art: { borderRadius: 10, backgroundColor: colors.surface, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  gameName: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 6 },
  gameMeta: { color: colors.text2, fontSize: 12 },
});
