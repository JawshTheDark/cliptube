import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { AppHeader } from '@/components/AppHeader';
import { Avatar, Button, Icon, type IconName } from '@/components/ui';
import { useSession } from '@/lib/session';
import { hostLabel } from '@/lib/api';
import { colors } from '@/lib/theme';
import { readable } from '@/lib/layout';

function Row({ icon, label, onPress, hint }: { icon: IconName; label: string; onPress: () => void; hint?: string }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]} accessibilityRole="button">
      <Icon name={icon} size={24} color={colors.text} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowText}>{label}</Text>
        {!!hint && <Text style={s.hint}>{hint}</Text>}
      </View>
      <Icon name="chevron-right" size={22} color={colors.text2} />
    </Pressable>
  );
}

export default function You() {
  const { user, api, server, site, main, signOut } = useSession();

  const confirmSignOut = () =>
    Alert.alert('Sign out?', `You’ll be signed out of ${hostLabel(server)} on this phone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader title="You" right={<View />} />
      <ScrollView contentContainerStyle={[{ paddingBottom: 32 }, readable]}>
        {user ? (
          <Pressable style={s.profile} onPress={() => router.push(`/c/${encodeURIComponent(user.username)}`)}>
            <Avatar uri={api.abs(user.avatar_url)} name={user.display_name} size={64} />
            <View style={{ flex: 1 }}>
              <Text style={s.name} numberOfLines={1}>
                {user.display_name}
              </Text>
              <Text style={s.hint} numberOfLines={1}>
                @{user.username} · {hostLabel(server)}
              </Text>
              <Text style={[s.hint, { color: colors.link, marginTop: 2 }]}>View channel</Text>
            </View>
          </Pressable>
        ) : (
          <View style={s.signedOut}>
            <Text style={s.name}>Sign in to {site?.site_name || hostLabel(server)}</Text>
            <Text style={s.hint}>Like, comment, subscribe and upload from your phone.</Text>
            <Button title="Sign in" kind="primary" onPress={() => router.push('/login')} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
          </View>
        )}

        {user && (
          <View style={s.group}>
            <Row icon="video-library" label="Your videos" onPress={() => router.push('/library/mine')} />
            <Row icon="history" label="History" onPress={() => router.push('/library/history')} />
            <Row icon="watch-later" label="Watch later" onPress={() => router.push('/playlist/watch-later')} />
            <Row icon="playlist-play" label="Playlists" onPress={() => router.push('/library/playlists')} />
            <Row icon="groups" label="Watch parties" hint="Parties you host" onPress={() => router.push('/library/parties')} />
            <Row icon="thumb-up-off-alt" label="Liked videos" onPress={() => router.push('/library/liked')} />
            <Row icon="subscriptions" label="Subscriptions" onPress={() => router.push('/library/subscriptions')} />
            <Row icon="link" label="Linked accounts" hint="Your accounts on other servers, shown as one person" onPress={() => router.push('/links')} />
            {user.is_admin && <Row icon="admin-panel-settings" label="Admin" hint="Site settings, people, network, moderation" onPress={() => router.push('/admin')} />}
            {!user.is_admin && user.is_moderator && <Row icon="shield" label="Moderation" hint="Reports, held comments, spam controls, games" onPress={() => router.push('/admin/moderation')} />}
          </View>
        )}

        <View style={s.group}>
          <Row icon="tune" label="App settings" hint={main ? `Main server: ${hostLabel(main)}` : undefined} onPress={() => router.push('/settings')} />
          <Row icon="dns" label="Servers" hint={`Using ${hostLabel(server)}`} onPress={() => router.push('/servers')} />
          <Row icon="settings" label="Account settings on the website" onPress={() => Linking.openURL(`${server}/settings`)} />
          {user && <Row icon="logout" label="Sign out" onPress={confirmSignOut} />}
        </View>

        <Text style={s.version}>OurTube for Android {Constants.expoConfig?.version || ''}</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  signedOut: { padding: 16, gap: 4 },
  name: { color: colors.text, fontSize: 20, fontWeight: '700' },
  hint: { color: colors.text2, fontSize: 13 },
  group: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 14 },
  rowText: { color: colors.text, fontSize: 15 },
  version: { color: colors.text2, fontSize: 12, textAlign: 'center', marginTop: 24 },
});
