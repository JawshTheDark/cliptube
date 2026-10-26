import { memo } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { knownServers, openChannelLink } from '@/lib/profiles';
import { useScope, withServer } from '@/lib/scope';
import { useSession } from '@/lib/session';
import { videoHref } from '@/lib/api';
import { ago, duration, plural } from '@/lib/format';
import { colors, thumbRadius } from '@/lib/theme';
import type { Video } from '@/lib/types';
import { ServerTag } from './ServerTag';
import { Text } from './Text';
import { Avatar, Icon } from './ui';

/** The community's top-voted title and thumbnail win over the uploader's, as on the website. */
const titleOf = (v: Video) => v.community?.title || v.title;
const thumbOf = (v: Video) => v.community?.thumbnail_url || v.thumbnail_url;
const when = (v: Video) => ago(v.published_at || v.created_at);

function Thumb({ v, style, small }: { v: Video; style: StyleProp<ViewStyle>; small?: boolean }) {
  const { api } = useScope();
  const uri = api.abs(thumbOf(v));
  const pending = v.status && v.status !== 'ready';
  return (
    <View style={[s.thumb, style]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} recyclingKey={v.id} /> : null}
      {!uri && (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name={pending ? 'hourglass-top' : 'smart-display'} size={32} color={colors.text2} />
        </View>
      )}
      <ServerTag remote={v.remote} onThumb small={small} />
      {!!v.duration && !pending && (
        <View style={[s.badge, small && { right: 6, bottom: 6 }]}>
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

/** Opens the uploader's channel: here, or on the server a network video comes from. */
function useOpenChannel(v: Video) {
  const { foreign } = useScope();
  const { servers, site } = useSession();
  return () => {
    if (v.remote) {
      const url = v.uploader.url || v.remote.peer_url;
      if (url) openChannelLink(url, knownServers(servers, site));
      return;
    }
    if (!v.uploader.username) return;
    router.push(withServer(`/c/${encodeURIComponent(v.uploader.username)}`, foreign) as any);
  };
}

/** Feed card: a rounded thumbnail, the creator's avatar on its bottom-left corner, title and details below. */
export const VideoCard = memo(function VideoCard({ v, showChannel = true }: { v: Video; showChannel?: boolean }) {
  const { api, foreign } = useScope();
  const openChannel = useOpenChannel(v);
  const meta = [showChannel ? v.uploader.display_name : null, plural(v.views, 'view'), when(v)].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={() => router.push(withServer(videoHref(v), foreign) as any)} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={titleOf(v)}>
      <Thumb v={v} style={s.cardThumb} />
      <View style={s.cardBody}>
        {showChannel && (
          <Pressable onPress={openChannel} hitSlop={6} style={s.cardAvatar} accessibilityRole="link" accessibilityLabel={`${v.uploader.display_name}'s channel`}>
            <Avatar uri={api.abs(v.uploader.avatar_url)} name={v.uploader.display_name} size={38} />
          </Pressable>
        )}
        <View style={{ flex: 1, paddingTop: 8 }}>
          <Text style={s.title} numberOfLines={2}>
            {titleOf(v)}
          </Text>
          <Text style={s.meta} numberOfLines={1}>
            {meta}
            {v.visibility && v.visibility !== 'public' ? ` · ${v.draft ? 'draft' : v.visibility}` : ''}
          </Text>
          {!!v.reason && (
            <Text style={[s.meta, { color: colors.accentText }]} numberOfLines={1}>
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

/** A Short: a 9:16 thumbnail with the title and views under it. The width comes from the shelf or grid. */
export const ShortCard = memo(function ShortCard({ v, style }: { v: Video; style?: StyleProp<ViewStyle> }) {
  const { foreign } = useScope();
  return (
    <Pressable onPress={() => router.push(withServer(videoHref(v), foreign) as any)} style={({ pressed }) => [style, pressed && { opacity: 0.85 }]} accessibilityRole="button" accessibilityLabel={titleOf(v)}>
      <Thumb v={v} style={s.shortThumb} small />
      <Text style={s.shortTitle} numberOfLines={2}>
        {titleOf(v)}
      </Text>
      <Text style={s.shortMeta} numberOfLines={1}>
        {plural(v.views, 'view')}
      </Text>
    </Pressable>
  );
});

/** Compact row: small thumbnail on the left. Used for related videos, history and your own videos. */
export const VideoRow = memo(function VideoRow({ v, onPress, right, extra }: { v: Video; onPress?: () => void; right?: React.ReactNode; extra?: string }) {
  const { foreign } = useScope();
  return (
    <Pressable
      onPress={onPress || (() => router.push(withServer(videoHref(v), foreign) as any))}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={titleOf(v)}
    >
      <Thumb v={v} style={s.rowThumb} small />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.title, { fontSize: 14, lineHeight: 19 }]} numberOfLines={2}>
          {titleOf(v)}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {v.uploader.display_name}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {extra || `${plural(v.views, 'view')} · ${when(v)}`}
        </Text>
      </View>
      {right}
    </Pressable>
  );
});

const s = StyleSheet.create({
  thumb: { backgroundColor: colors.surface, overflow: 'hidden', borderRadius: thumbRadius },
  card: { marginBottom: 20, paddingHorizontal: 12 },
  cardThumb: { width: '100%', aspectRatio: 16 / 9 },
  cardBody: { flexDirection: 'row', gap: 10 },
  // The creator sits on the thumbnail's bottom-left corner, ringed in the page color.
  cardAvatar: { marginTop: -20, marginLeft: 10, alignSelf: 'flex-start', borderRadius: 24, borderWidth: 3, borderColor: colors.bg, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 20 },
  meta: { color: colors.text2, fontSize: 12.5, marginTop: 2 },
  game: { color: colors.text2, fontSize: 12, fontWeight: '600', marginTop: 4, alignSelf: 'flex-start', backgroundColor: colors.surface2, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  badge: { position: 'absolute', right: 8, bottom: 8, backgroundColor: colors.overlay, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  progressFill: { height: 3, backgroundColor: colors.accent },
  shortThumb: { width: '100%', aspectRatio: 9 / 16 },
  shortTitle: { color: colors.text, fontSize: 14, fontWeight: '700', lineHeight: 19, marginTop: 8 },
  shortMeta: { color: colors.text2, fontSize: 12, marginTop: 2 },
  row: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'flex-start' },
  rowThumb: { width: 160, aspectRatio: 16 / 9, borderRadius: 12 },
});
