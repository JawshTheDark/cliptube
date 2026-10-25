import { useCallback, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/components/AppHeader';
import { Button, Empty, ErrorBox, Icon, Loading, type IconName } from '@/components/ui';
import { useSession } from '@/lib/session';
import { ago } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Notification } from '@/lib/types';

const KIND_ICON: Record<string, IconName> = {
  comment: 'chat-bubble-outline',
  reply: 'reply',
  upload: 'video-library',
  subscriber: 'person-add-alt',
  like: 'thumb-up-off-alt',
  moderation: 'gavel',
  move: 'drive-file-move-outline',
};

/** Website paths the app has screens for; anything else opens in the browser. */
function openSitePath(url: string | null, base: string) {
  if (!url) return;
  if (/^\/(watch|n|c|g)\/[^?#]+/.test(url)) router.push(url.replace(/[?#].*$/, '') as any);
  else Linking.openURL(/^https?:/.test(url) ? url : `${base}${url}`);
}

export default function Inbox() {
  const { api, user, server, setUnread } = useSession();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (!user) return;
      setError(null);
      if (refresh) setRefreshing(true);
      try {
        const r = await api.get<{ notifications: Notification[]; unread: number }>('/notifications');
        setItems(r.notifications);
        // Seeing the list counts as reading it; the dots stay until the next visit.
        if (r.unread) api.post<{ unread: number }>('/notifications/read', {}).then((x) => setUnread(x.unread)).catch(() => {});
      } catch (e: any) {
        setError(e.message);
      } finally {
        setRefreshing(false);
      }
    },
    [api, user, setUnread],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!user) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AppHeader title="Inbox" />
        <Empty icon="notifications-none" title="Sign in to get notifications">
          <View style={{ marginTop: 8 }}>
            <Button title="Sign in" kind="primary" onPress={() => router.push('/login')} />
          </View>
        </Empty>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader title="Inbox" right={<View />} />
      {!!error && <ErrorBox message={error} onRetry={() => load()} />}
      {!items && !error ? (
        <Loading />
      ) : (
        <FlatList
          data={items || []}
          keyExtractor={(n) => n.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
          ListEmptyComponent={<Empty icon="notifications-none" title="Nothing here yet">Comments, replies and new uploads from your subscriptions show up here.</Empty>}
          renderItem={({ item: n }) => (
            <Pressable onPress={() => openSitePath(n.url, server)} style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}>
              <View style={[s.dot, n.read && { backgroundColor: 'transparent' }]} />
              <View style={s.icon}>
                <Icon name={KIND_ICON[n.kind] || 'notifications-none'} size={20} color={colors.text} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.title} numberOfLines={3}>
                  {n.title}
                </Text>
                {!!n.body && (
                  <Text style={s.body} numberOfLines={2}>
                    {n.body}
                  </Text>
                )}
                <Text style={s.when}>{ago(n.created_at)}</Text>
              </View>
              {!!n.image_url && <Image source={{ uri: api.abs(n.image_url)! }} style={s.thumb} contentFit="cover" />}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.link, marginTop: 16 },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 14, lineHeight: 19 },
  body: { color: colors.text2, fontSize: 13 },
  when: { color: colors.text2, fontSize: 12 },
  thumb: { width: 88, aspectRatio: 16 / 9, borderRadius: 6, backgroundColor: colors.surface },
});
