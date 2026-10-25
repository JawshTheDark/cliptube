import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '@/lib/session';
import { hostLabel } from '@/lib/api';
import { colors } from '@/lib/theme';
import { Icon, IconButton } from './ui';

/** Top bar for the tab screens: the logo with the active server, and actions on the right. */
export function AppHeader({ title, right }: { title?: string; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { site, server } = useSession();
  return (
    <View style={[s.bar, { paddingTop: insets.top + 6 }]}>
      {title ? (
        <Text style={s.title}>{title}</Text>
      ) : (
        <Pressable style={s.brand} onPress={() => router.push('/servers')} accessibilityRole="button" accessibilityLabel="Change server">
          <View style={s.logo}>
            <Icon name="play-arrow" size={20} color="#fff" />
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text style={s.name} numberOfLines={1}>
              {site?.site_name || 'ClipTube'}
            </Text>
            <Text style={s.host} numberOfLines={1}>
              {hostLabel(server)}
            </Text>
          </View>
          <Icon name="arrow-drop-down" size={20} color={colors.text2} />
        </Pressable>
      )}
      <View style={s.actions}>{right ?? <IconButton name="search" label="Search" onPress={() => router.push('/explore')} />}</View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 6, backgroundColor: colors.bg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  logo: { width: 30, height: 22, borderRadius: 6, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  name: { color: colors.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  host: { color: colors.text2, fontSize: 11 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center' },
});
