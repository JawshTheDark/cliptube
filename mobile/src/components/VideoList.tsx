import { useMemo, type ReactElement } from 'react';
import { FlatList, RefreshControl, View, useWindowDimensions } from 'react-native';
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

type Item = { kind: 'video'; v: Video } | { kind: 'slot' };

/**
 * A pull-to-refresh, endlessly scrolling list of videos: full cards, compact rows, or Shorts two to a row.
 * `slot` (the Shorts shelf on the home page) goes after the first `slotAfter` cards.
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
  // Two Shorts to a row, 12 on each side and 10 between.
  const shortWidth = (useWindowDimensions().width - 34) / 2;
  const data = useMemo<Item[]>(() => {
    const list: Item[] = paged.items.map((v) => ({ kind: 'video', v }));
    if (slot && !shorts && list.length) list.splice(Math.min(slotAfter, list.length), 0, { kind: 'slot' });
    return list;
  }, [paged.items, slot, shorts, slotAfter]);

  return (
    <FlatList
      // FlatList can't change its column count in place.
      key={shorts ? 'shorts' : 'cards'}
      data={data}
      numColumns={shorts ? 2 : 1}
      columnWrapperStyle={shorts ? { gap: 10, paddingHorizontal: 12 } : undefined}
      keyExtractor={(x) => (x.kind === 'video' ? x.v.id : 'slot')}
      renderItem={({ item }) =>
        item.kind === 'slot' ? (
          slot
        ) : shorts ? (
          <ShortCard v={item.v} scope={shortsScope} style={{ width: shortWidth, marginBottom: 18 }} />
        ) : rows ? (
          <VideoRow v={item.v} />
        ) : (
          <VideoCard v={item.v} showChannel={showChannel} />
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
