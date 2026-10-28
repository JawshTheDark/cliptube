import { useRef, type ComponentRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSession } from '@/lib/session';
import { Chip } from './ui';

/** The website's admin tabs. Moderators see Moderation and Games; admins see them all. */
const TABS = [
  { path: '/admin', label: 'Overview', admin: true },
  { path: '/admin/moderation', label: 'Moderation', admin: false },
  { path: '/admin/games', label: 'Games', admin: false },
  { path: '/admin/legal', label: 'Legal', admin: true },
  { path: '/admin/network', label: 'Network', admin: true },
  { path: '/admin/debug', label: 'Debugging', admin: true },
];

export function AdminTabs() {
  const { user } = useSession();
  const path = usePathname();
  const admin = !!user?.is_admin;
  const row = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView ref={row} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row} style={{ flexGrow: 0 }}>
      {TABS.filter((t) => admin || !t.admin).map((t) => (
        <View
          key={t.path}
          // Each tab opens a screen of its own, so bring this screen's tab into view.
          onLayout={t.path === path ? (e) => row.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - 48), animated: false }) : undefined}
        >
          <Chip label={t.label} active={path === t.path} onPress={() => path !== t.path && router.replace(t.path as any)} />
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
});
