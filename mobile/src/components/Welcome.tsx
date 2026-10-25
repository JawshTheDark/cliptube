import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Api, hostLabel, normalizeServerUrl } from '@/lib/api';
import { NETWORK_DIRECTORY, useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Site } from '@/lib/types';
import { Button, Icon } from './ui';
import { f } from './VideoForm';

type Suggestion = { url: string; name: string };

/**
 * First launch: the user picks their main server (the one they have an account on, or want to browse). The
 * ClipTube network's servers are offered as suggestions, but nothing is picked for them.
 */
export function Welcome() {
  const { setMain } = useSession();
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    new Api(NETWORK_DIRECTORY)
      .get<Site>('/site')
      .then((s) => {
        const list: Suggestion[] = [{ url: NETWORK_DIRECTORY, name: s.site_name }];
        for (const p of s.network_peers || []) {
          try {
            list.push({ url: normalizeServerUrl(p.url), name: p.name });
          } catch {
            /* skip */
          }
        }
        setSuggestions(list);
      })
      .catch(() => setSuggestions([]));
  }, []);

  const choose = async (url: string) => {
    setBusy(url);
    setError(null);
    try {
      await setMain(url);
      // Back to Home, if this came up after removing the last server from inside the Servers screen.
      if (router.canDismiss()) router.dismissAll();
    } catch (e: any) {
      setError(e.message);
      setBusy(null);
    }
  };

  return (
    <KeyboardAwareScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[s.page, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View style={s.logo}>
        <Icon name="play-arrow" size={44} color="#fff" />
      </View>
      <Text style={s.title}>Welcome to ClipTube</Text>
      <Text style={s.text}>
        ClipTube is a network of servers run by friends. Pick your main server: the one you have an account on, or the one
        you want to browse. The app opens on it, and you can add more servers later.
      </Text>

      <Text style={s.section}>Your server’s address</Text>
      <TextInput
        value={input}
        onChangeText={setInput}
        placeholder="clips.example.com"
        placeholderTextColor={colors.text2}
        style={f.input}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onSubmitEditing={() => input.trim() && choose(input)}
      />
      <Button title="Continue" kind="primary" onPress={() => choose(input)} disabled={!input.trim() || !!busy} busy={busy === input} />
      {!!error && <Text style={{ color: colors.err }}>{error}</Text>}

      {suggestions.length > 0 && (
        <>
          <Text style={s.section}>Or pick one in the ClipTube network</Text>
          {suggestions.map((x) => (
            <Pressable key={x.url} onPress={() => choose(x.url)} disabled={!!busy} style={({ pressed }) => [s.card, pressed && { backgroundColor: colors.surface2 }]}>
              <Icon name="dns" size={22} color={colors.text2} />
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{x.name}</Text>
                <Text style={s.hint}>{hostLabel(x.url)}</Text>
              </View>
              {busy === x.url ? <Text style={s.hint}>…</Text> : <Icon name="chevron-right" size={22} color={colors.text2} />}
            </Pressable>
          ))}
        </>
      )}
      <Text style={[s.hint, { textAlign: 'center', marginTop: 8 }]}>You can change your main server any time under You → App settings.</Text>
    </KeyboardAwareScrollView>
  );
}

const s = StyleSheet.create({
  page: { paddingHorizontal: 20, gap: 12 },
  logo: { alignSelf: 'center', width: 84, height: 62, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  text: { color: colors.text2, fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 8 },
  section: { color: colors.text2, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, backgroundColor: colors.surface },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.text2, fontSize: 13 },
});
