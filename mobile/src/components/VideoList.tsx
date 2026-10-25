import { type ReactElement } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';
import { VideoCard, VideoRow } from './VideoCard';
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

/** A pull-to-refresh, endlessly scrolling list of clips. */
export function VideoList({
  paged,
  header,
  empty,
  rows = false,
  showChannel = true,
}: {
  paged: Paged;
  header?: ReactElement | null;
  empty?: ReactElement | null;
  rows?: boolean;
  showChannel?: boolean;
}) {
  return (
    <FlatList
      data={paged.items}
      keyExtractor={(v) => v.id}
      renderItem={({ item }) => (rows ? <VideoRow v={item} /> : <VideoCard v={item} showChannel={showChannel} />)}
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
