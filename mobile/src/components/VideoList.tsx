import { useMemo, type ReactElement } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useLayout } from '@/lib/layout';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';
import { ShortCard, VideoCard, VideoRow } from './VideoCard';
import { ErrorBox, Loading } from './ui';

type Paged = {
  items: Video[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => void;
  reload: () => void;
  loadMore: () => void;
};

type Item = { kind: 'row'; key: string; videos: Video[] } | { kind: 'slot' };

/**
 * A pull-to-refresh, endlessly scrolling list of videos: full cards, compact rows, or Shorts. As many fit across as
 * the screen allows (one card on a phone held upright, up to four on a tablet on its side). `slot` (the Shorts shelf
 * on the home page) goes across the whole width after about `slotAfter` cards.
 */
export function VideoList({
  paged,
  header,
  empty,
  rows = false,
  shorts = false,
  shortsScope,
  showChannel = true,
  slot = null,
  slotAfter = 8,
}: {
  paged: Paged;
  header?: ReactElement | null;
  empty?: ReactElement | null;
  rows?: boolean;
  shorts?: boolean;
  shortsScope?: 'all' | 'local';
  showChannel?: boolean;
  slot?: ReactElement | null;
  slotAfter?: number;
}) {
  const layout = useLayout();
  const cols = shorts ? layout.shortColumns : rows ? (layout.width >= 900 ? 2 : 1) : layout.columns;
  // Shorts sit 12 from the edges and 10 apart; cards carry their own padding.
  const gap = shorts ? 10 : 0;
  const cellWidth = shorts ? (layout.width - 24 - gap * (cols - 1)) / cols : (layout.width - (cols > 1 ? 8 : 0)) / cols;

  const data = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (let i = 0; i < paged.items.length; i += cols) {
      const videos = paged.items.slice(i, i + cols);
      out.push({ kind: 'row', key: videos.map((v) => v.id).join(' '), videos });
    }
    if (slot && !shorts && out.length) out.splice(Math.min(Math.max(1, Math.round(slotAfter / cols)), out.length), 0, { kind: 'slot' });
    return out;
  }, [paged.items, slot, shorts, slotAfter, cols]);

  return (
    <FlatList
      data={data}
      keyExtractor={(x) => (x.kind === 'row' ? `${cols}:${x.key}` : 'slot')}
      renderItem={({ item }) =>
        item.kind === 'slot' ? (
          slot
        ) : (
          <View style={[{ flexDirection: 'row' }, shorts ? { gap, paddingHorizontal: 12 } : cols > 1 ? { paddingHorizontal: 4 } : null]}>
            {item.videos.map((v) =>
              shorts ? (
                <ShortCard key={v.id} v={v} scope={shortsScope} style={{ width: cellWidth, marginBottom: 18 }} />
              ) : rows ? (
                <View key={v.id} style={{ width: cellWidth }}>
                  <VideoRow v={v} />
                </View>
              ) : (
                <VideoCard key={v.id} v={v} showChannel={showChannel} width={cols > 1 ? cellWidth : undefined} />
              ),
            )}
          </View>
        )
      }
      ListHeaderComponent={
        <>
          {header}
          {!!paged.error && <ErrorBox message={paged.error} onRetry={paged.reload} />}
        </>
      }
      ListEmptyComponent={paged.loading ? <Loading /> : paged.error ? undefined : empty || undefined}
      ListFooterComponent={paged.hasMore && paged.items.length > 0 ? <Loading style={{ paddingVertical: 20 }} /> : <View style={{ height: 24 }} />}
      onEndReached={paged.loadMore}
      onEndReachedThreshold={0.6}
      refreshControl={<RefreshControl refreshing={paged.refreshing} onRefresh={paged.refresh} colors={[colors.accent]} progressBackgroundColor={colors.surface} tintColor={colors.text2} />}
      removeClippedSubviews
      windowSize={9}
      style={{ backgroundColor: colors.bg }}
    />
  );
}
