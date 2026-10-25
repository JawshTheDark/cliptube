import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { Button, Icon, IconButton, toast } from '@/components/ui';
import { f } from '@/components/VideoForm';
import { hostLabel, normalizeServerUrl } from '@/lib/api';
import { DEFAULT_SERVER, useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

/**
 * Each ClipTube server is its own site with its own accounts. The app keeps a sign-in per server and
 * shows one at a time; clips from the rest of the network still appear in that server's feeds.
 */
export default function Servers() {
  const { server, servers, site, addServer, switchServer, removeServer } = useSession();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saved = new Set(servers.map((x) => x.url));
  // Suggestions: the active server's network peers and the hub, if not saved yet.
  const suggestions = [...(site?.network_peers || []).map((p) => ({ url: safeUrl(p.url), name: p.name })), { url: DEFAULT_SERVER, name: 'ClipTube hub' }].filter(
    (p, i, all) => p.url && !saved.has(p.url) && all.findIndex((x) => x.url === p.url) === i,
  );

  const use = async (url: string) => {
    setBusy(url);
    setError(null);
    try {
      if (!saved.has(url)) await addServer(url);
      await switchServer(url);
      toast(`Using ${hostLabel(url)}`);
      router.dismissTo('/');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    setBusy('new');
    setError(null);
    try {
      const entry = await addServer(input);
      setInput('');
      await switchServer(entry.url);
      toast(`Using ${entry.name}`);
      router.dismissTo('/');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = (url: string) =>
    Alert.alert('Remove server?', `${hostLabel(url)} is removed from the app and you’re signed out of it.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeServer(url) },
    ]);

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <Text style={s.section}>Your servers</Text>
        {servers.map((x) => (
          <Pressable key={x.url} onPress={() => x.url !== server && use(x.url)} style={[s.card, x.url === server && s.cardOn]} accessibilityRole="radio" accessibilityState={{ checked: x.url === server }}>
            <Icon name={x.url === server ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={x.url === server ? colors.accent : colors.text2} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{x.name}</Text>
              <Text style={s.hint}>{hostLabel(x.url)}</Text>
            </View>
            {busy === x.url ? <Text style={s.hint}>…</Text> : <IconButton name="delete-outline" label={`Remove ${x.name}`} color={colors.text2} onPress={() => remove(x.url)} />}
          </Pressable>
        ))}

        {suggestions.length > 0 && (
          <>
            <Text style={s.section}>In the network</Text>
            {suggestions.map((p) => (
              <Pressable key={p.url} onPress={() => use(p.url)} style={s.card}>
                <Icon name="add-circle-outline" size={22} color={colors.text2} />
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{p.name}</Text>
                  <Text style={s.hint}>{hostLabel(p.url)}</Text>
                </View>
                {busy === p.url && <Text style={s.hint}>…</Text>}
              </Pressable>
            ))}
          </>
        )}

        <Text style={s.section}>Add a server</Text>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="clips.example.com"
          placeholderTextColor={colors.text2}
          style={f.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={add}
        />
        <Button title="Add and switch" kind="primary" onPress={add} busy={busy === 'new'} disabled={!input.trim()} />
        {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
        <Text style={s.hint}>Accounts belong to one server. Sign in on each server you use; the app remembers each sign-in.</Text>
    </KeyboardAwareScrollView>
  );
}

function safeUrl(u: string) {
  try {
    return normalizeServerUrl(u);
  } catch {
    return '';
  }
}

const s = StyleSheet.create({
  section: { color: colors.text2, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'transparent' },
  cardOn: { borderColor: colors.accent },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.text2, fontSize: 13 },
});
