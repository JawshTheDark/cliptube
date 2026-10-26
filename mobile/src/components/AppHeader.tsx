import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '@/lib/session';
import { hostLabel } from '@/lib/api';
import { colors, fonts } from '@/lib/theme';
import { LogoMark, Wordmark } from './Logo';
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
          <LogoMark size={30} />
          <View style={{ flexShrink: 1 }}>
            <Wordmark name={site?.site_name || 'OurTube'} size={22} />
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
  host: { color: colors.text2, fontSize: 11, marginTop: -1 },
  title: { color: colors.text, fontSize: 22, fontFamily: fonts.display, fontWeight: '800', letterSpacing: -0.5, flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center' },
});
