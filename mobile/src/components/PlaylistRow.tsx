import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useScope, withServer } from '@/lib/scope';
import { ago } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { PlaylistSummary } from '@/lib/types';
import { Icon } from './ui';

/** A playlist in a list: its first video's thumbnail with the video count over it. */
export const PlaylistRow = memo(function PlaylistRow({ p, showOwner = false }: { p: PlaylistSummary; showOwner?: boolean }) {
  const { api, foreign } = useScope();
  const thumb = api.abs(p.thumbnail_url);
  const href = p.kind === 'watch_later' ? '/playlist/watch-later' : `/playlist/${encodeURIComponent(p.id)}`;
  return (
    <Pressable onPress={() => router.push(withServer(href, foreign) as any)} style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel={p.title}>
      <View style={s.thumb}>
        {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Icon name={p.kind === 'watch_later' ? 'watch-later' : 'playlist-play'} size={30} color={colors.text2} />}
        <View style={s.count}>
          <Icon name="playlist-play" size={16} color="#fff" />
          <Text style={s.countText}>{p.item_count}</Text>
        </View>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.title} numberOfLines={2}>
          {p.title}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {[showOwner && p.owner ? p.owner.display_name : null, p.visibility !== 'public' ? p.visibility : null, `updated ${ago(p.updated_at)}`].filter(Boolean).join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
});

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  thumb: { width: 160, aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: colors.surface, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  count: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 56, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', gap: 2 },
  countText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  title: { color: colors.text, fontSize: 15, fontWeight: '500', lineHeight: 20 },
  meta: { color: colors.text2, fontSize: 12.5 },
});
