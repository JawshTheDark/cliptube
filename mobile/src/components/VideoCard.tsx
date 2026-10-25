import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useScope, withServer } from '@/lib/scope';
import { videoHref } from '@/lib/api';
import { ago, compact, duration, hostOf } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';
import { Avatar, Icon } from './ui';

/** The community's top-voted title and thumbnail win over the uploader's, as on the website. */
const titleOf = (v: Video) => v.community?.title || v.title;
const thumbOf = (v: Video) => v.community?.thumbnail_url || v.thumbnail_url;

function meta(v: Video, withName: boolean) {
  const parts = [];
  if (withName) parts.push(v.uploader.display_name);
  if (v.remote) parts.push(v.remote.peer_name || hostOf(v.remote.peer_url));
  parts.push(`${compact(v.views)} views`);
  parts.push(ago(v.published_at || v.created_at));
  return parts.join(' · ');
}

function Thumb({ v, style }: { v: Video; style: any }) {
  const { api, foreign } = useScope();
  const uri = api.abs(thumbOf(v));
  const pending = v.status && v.status !== 'ready';
  return (
    <View style={[style, { backgroundColor: colors.surface, overflow: 'hidden' }]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} recyclingKey={v.id} /> : null}
      {!uri && (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name={pending ? 'hourglass-top' : 'movie'} size={32} color={colors.text2} />
        </View>
      )}
      {!!v.duration && !pending && (
        <View style={s.badge}>
          <Text style={s.badgeText}>{duration(v.duration)}</Text>
        </View>
      )}
      {!!v.position && !!v.duration && (
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${Math.min(100, (v.position / v.duration) * 100)}%` }]} />
        </View>
      )}
    </View>
  );
}

/** Full-width card for feeds: thumbnail on top, avatar and title below. */
export const VideoCard = memo(function VideoCard({ v, showChannel = true }: { v: Video; showChannel?: boolean }) {
  const { api, foreign } = useScope();
  const openChannel = () => {
    if (v.remote || !v.uploader.username) return;
    router.push(withServer(`/c/${encodeURIComponent(v.uploader.username)}`, foreign) as any);
  };
  return (
    <Pressable onPress={() => router.push(withServer(videoHref(v), foreign) as any)} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={titleOf(v)}>
      <Thumb v={v} style={s.cardThumb} />
      <View style={s.cardBody}>
        {showChannel && (
          <Pressable onPress={openChannel} hitSlop={6}>
            <Avatar uri={api.abs(v.uploader.avatar_url)} name={v.uploader.display_name} size={36} />
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={2}>
            {titleOf(v)}
          </Text>
          <Text style={s.meta} numberOfLines={1}>
            {meta(v, showChannel)}
          </Text>
          {!!v.reason && (
            <Text style={[s.meta, { color: colors.link }]} numberOfLines={1}>
              {v.reason}
            </Text>
          )}
          {!!v.game && (
            <Text style={s.game} numberOfLines={1}>
              {v.game.name}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
});

/** Compact row: small thumbnail on the left. Used for related clips, history and your own videos. */
export const VideoRow = memo(function VideoRow({ v, onPress, right, extra }: { v: Video; onPress?: () => void; right?: React.ReactNode; extra?: string }) {
  const { foreign } = useScope();
  return (
    <Pressable
      onPress={onPress || (() => router.push(withServer(videoHref(v), foreign) as any))}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={titleOf(v)}
    >
      <Thumb v={v} style={s.rowThumb} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.title, { fontSize: 14 }]} numberOfLines={2}>
          {titleOf(v)}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {v.uploader.display_name}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {extra || `${compact(v.views)} views · ${ago(v.published_at || v.created_at)}`}
        </Text>
      </View>
      {right}
    </Pressable>
  );
});

const s = StyleSheet.create({
  card: { marginBottom: 18 },
  cardThumb: { width: '100%', aspectRatio: 16 / 9 },
  cardBody: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, paddingTop: 10 },
  title: { color: colors.text, fontSize: 15, fontWeight: '500', lineHeight: 20 },
  meta: { color: colors.text2, fontSize: 12.5, marginTop: 2 },
  game: { color: colors.text2, fontSize: 12, marginTop: 4, alignSelf: 'flex-start', backgroundColor: colors.surface2, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  badge: { position: 'absolute', right: 6, bottom: 6, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  progressFill: { height: 3, backgroundColor: colors.accent },
  row: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'flex-start' },
  rowThumb: { width: 160, aspectRatio: 16 / 9, borderRadius: 8 },
});
