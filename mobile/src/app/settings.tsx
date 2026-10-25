import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Button, Icon, toast } from '@/components/ui';
import { hostLabel } from '@/lib/api';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

/** App settings: the main server (the one the app opens on), and what this app is. */
export default function AppSettings() {
  const { servers, main, server, setMain } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

  const pick = async (url: string) => {
    if (url === main) return;
    setBusy(url);
    try {
      await setMain(url);
      toast(`${hostLabel(url)} is your main server`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={s.section}>Main server</Text>
      <Text style={s.hint}>
        The app opens on your main server. You can still switch to another one from the server name on Home; the next time
        you open the app, it’s back on your main server.
      </Text>
      {servers.map((x) => {
        const isMain = x.url === main;
        return (
          <Pressable key={x.url} onPress={() => pick(x.url)} disabled={!!busy} style={[s.card, isMain && s.cardOn]} accessibilityRole="radio" accessibilityState={{ checked: isMain }}>
            <Icon name={isMain ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={isMain ? colors.accent : colors.text2} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{x.name}</Text>
              <Text style={s.hint}>
                {hostLabel(x.url)}
                {x.url === server && !isMain ? ' · open now' : ''}
              </Text>
            </View>
            {busy === x.url && <Text style={s.hint}>…</Text>}
          </Pressable>
        );
      })}
      <Button title="Add or remove servers" icon="dns" onPress={() => router.push('/servers')} style={{ alignSelf: 'flex-start' }} />

      <Text style={[s.section, { marginTop: 18 }]}>About</Text>
      <Text style={s.hint}>ClipTube for Android {Constants.expoConfig?.version || ''}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  section: { color: colors.text2, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  hint: { color: colors.text2, fontSize: 13, lineHeight: 18 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'transparent' },
  cardOn: { borderColor: colors.accent },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
});
