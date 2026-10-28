import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Select, type Option } from '@/components/Form';
import { VideoList } from '@/components/VideoList';
import { Empty, ErrorBox, Icon, IconButton, Loading } from '@/components/ui';
import { useSession } from '@/lib/session';
import { usePaged } from '@/lib/usePaged';
import { compact } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Game, Video } from '@/lib/types';

// The website's search filters (web/src/pages/Search.jsx); '' is each one's default.
const FILTERS: [string, string, [string, string][]][] = [
  ['sort', 'Sort', [['', 'Relevance'], ['new', 'Upload date'], ['views', 'View count']]],
  ['duration', 'Length', [['', 'Any length'], ['short', 'Under a minute'], ['medium', '1 to 20 minutes'], ['long', 'Over 20 minutes']]],
  ['date', 'Uploaded', [['', 'Any time'], ['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']]],
  ['shape', 'Shape', [['', 'Any shape'], ['landscape', 'Landscape'], ['vertical', 'Vertical']]],
];

export default function Explore() {
  const insets = useSafeAreaInsets();
  const { api, site } = useSession();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [games, setGames] = useState<Game[]>([]);
  useEffect(() => {
    api
      .get<{ games: Game[] }>('/games')
      .then((r) => setGames(r.games))
      .catch(() => {});
  }, [api]);
  const peers = site?.network_peers || [];
  const networked = !!site?.federation && peers.length > 0;

  const path = useMemo(() => {
    if (!query) return null;
    const p = new URLSearchParams({ q: query });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return `/search?${p}`;
  }, [query, filters]);
  const results = usePaged<Video>(api, path);
  const set = (k: string, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const where: Option<string>[] = [
    { value: '', label: 'Everywhere' },
    { value: 'local', label: 'This site' },
    { value: 'network', label: 'Other servers' },
    ...peers.filter((x) => x.software === 'ourtube').map((x) => ({ value: `peer:${x.id}`, label: x.name, hint: 'OurTube server' })),
    ...peers.filter((x) => x.software !== 'ourtube').map((x) => ({ value: `peer:${x.id}`, label: x.name, hint: 'Fediverse' })),
  ];

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
            <View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.sorts} keyboardShouldPersistTaps="handled">
                {FILTERS.map(([k, label, opts]) => (
                  <View key={k} style={{ minWidth: 150 }} accessibilityLabel={label}>
                    <Select small value={filters[k] || ''} options={opts.map(([value, l]) => ({ value, label: l }))} onChange={(v) => set(k, v)} />
                  </View>
                ))}
                {games.length > 0 && (
                  <View style={{ minWidth: 150 }} accessibilityLabel="Game">
                    <Select small value={filters.game || ''} options={[{ value: '', label: 'Any game' }, ...games.map((g) => ({ value: g.id, label: g.name }))]} onChange={(v) => set('game', v)} />
                  </View>
                )}
                {networked && (
                  <View style={{ minWidth: 150 }} accessibilityLabel="Where">
                    <Select small value={filters.where || ''} options={where} onChange={(v) => set('where', v)} />
                  </View>
                )}
              </ScrollView>
              <Text style={s.hint}>Put words in "quotes" to match an exact phrase.</Text>
            </View>
          }
          empty={<Empty icon="search-off" title={`No results for "${query}"`}>Try different words, fewer filters, or search for a game, tag or channel name.</Empty>}
        />
      ) : (
        <Games />
      )}
    </View>
  );
}

/** The game catalog as an artwork grid, most videos first. */
function Games() {
  const { api, site } = useSession();
  const networked = !!site?.federation && (site.network_peers || []).length > 0;
  const { width } = useWindowDimensions();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cols = Math.max(2, Math.min(6, Math.floor(width / 210)));
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
      ListHeaderComponent={
        <>
          {networked && (
            <Pressable style={s.network} onPress={() => router.push('/network' as any)} accessibilityRole="button">
              <Icon name="public" size={22} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{site?.network?.name || 'Network'}</Text>
                <Text style={s.gameMeta}>Videos from the other servers in the network and the fediverse</Text>
              </View>
              <Icon name="chevron-right" size={22} color={colors.text2} />
            </Pressable>
          )}
          <Text style={s.section}>Games</Text>
        </>
      }
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
  hint: { color: colors.text2, fontSize: 12.5, paddingHorizontal: 12, paddingBottom: 6 },
  network: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  section: { color: colors.text, fontSize: 18, fontWeight: '700', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  art: { borderRadius: 10, backgroundColor: colors.surface, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  gameName: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 6 },
  gameMeta: { color: colors.text2, fontSize: 12 },
});
