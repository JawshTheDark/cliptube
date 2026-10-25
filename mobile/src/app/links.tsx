import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { Avatar, Button, Empty, ErrorBox, Icon, IconButton, Loading, toast } from '@/components/ui';
import { f } from '@/components/VideoForm';
import { ago } from '@/lib/format';
import { knownServers, openProfile } from '@/lib/profiles';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { LinksState, OwnLink } from '@/lib/types';

/**
 * Linked accounts (ClipTube 1.6): the same person's accounts on other ClipTube servers or Mastodon. A link
 * counts once both accounts list each other; then every server shows them as one person.
 */
export default function LinkedAccounts() {
  const { api, user, servers, site } = useSession();
  const [s, setS] = useState<LinksState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const known = knownServers(servers, site);

  const load = useCallback(() => {
    setError(null);
    api
      .get<LinksState>('/me/links')
      .then(setS)
      .catch((e) => setError(e.status === 404 ? 'Linked accounts need ClipTube 1.6 or newer on this server.' : e.message));
  }, [api]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<LinksState>, done?: string | ((r: LinksState) => string)) => {
    setBusy(true);
    try {
      const r = await fn();
      setS(r);
      if (done) toast(typeof done === 'function' ? done(r) : done);
      return true;
    } catch (e: any) {
      toast(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const link = (h: string) =>
    run(
      () => api.post<LinksState>('/me/links', { handle: h }),
      (r) => (r.added?.verified ? `Linked with ${r.added.handle}` : `Added ${r.added?.handle}. Now link this account from there too.`),
    );

  const unlink = (l: OwnLink) =>
    Alert.alert('Unlink this account?', `${l.handle} will no longer show as you here.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlink', style: 'destructive', onPress: () => run(() => api.del<LinksState>(`/me/links/${l.id}`), 'Unlinked') },
    ]);

  if (!user) {
    return (
      <Empty icon="lock-outline" title="Sign in first">
        <View style={{ marginTop: 8 }}>
          <Button title="Sign in" kind="primary" onPress={() => router.push('/login')} />
        </View>
      </Empty>
    );
  }
  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!s) return <Loading />;

  const full = s.links.length >= s.max;
  const off = !s.enabled;

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled" bottomOffset={24}>
      <Text style={s_.hint}>
        Have accounts on other ClipTube servers, or on Mastodon? Link them and every server shows them as one person: Also on
        on your channel, your comments from any of them marked as the uploader’s, and one button to subscribe to all of them.
        A link counts once both accounts list each other.
      </Text>
      {off && <Text style={[s_.hint, { color: colors.warn }]}>Linking needs ActivityPub and this server’s Public URL. Ask an admin to turn them on.</Text>}

      {s.suggestions.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={s_.section}>These accounts say they’re you</Text>
          {s.suggestions.map((x) => (
            <View key={x.actor} style={s_.card}>
              <View style={{ flex: 1 }}>
                <Text style={s_.name} numberOfLines={1}>
                  {x.name || x.handle}
                </Text>
                <Text style={s_.hint} numberOfLines={1}>
                  {x.handle}
                </Text>
              </View>
              <Button title="Link back" icon="link" small onPress={() => link(x.actor)} disabled={busy || full || off} />
            </View>
          ))}
        </View>
      )}

      <Text style={s_.section}>Link another account</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={handle}
          onChangeText={setHandle}
          placeholder="@you@other-site.example"
          placeholderTextColor={colors.text2}
          style={[f.input, { flex: 1 }]}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!off && !full}
          onSubmitEditing={() => handle.trim() && link(handle.trim()).then((ok) => ok && setHandle(''))}
        />
        <Button title="Link" kind="primary" onPress={() => link(handle.trim()).then((ok) => ok && setHandle(''))} disabled={busy || off || full || !handle.trim()} />
      </View>
      <View style={s_.card}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s_.hint}>Then, on the other site, link this account:</Text>
          <Text style={s_.name} selectable>
            {s.handle}
          </Text>
        </View>
        <Button title="Copy" icon="content-copy" small onPress={() => Clipboard.setStringAsync(s.handle).then(() => toast('Copied'))} />
      </View>
      <Text style={s_.hint}>
        On Mastodon, add it under Preferences, Account, Moving from a different account, as an account alias. It moves nothing.
        {full ? ` An account can be linked to up to ${s.max} others.` : ''}
      </Text>

      {s.links.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={s_.section}>Your linked accounts</Text>
          {s.links.map((l) => (
            <View key={l.id} style={s_.card}>
              <Avatar uri={l.avatar_url} name={l.name || l.handle} size={40} />
              <Pressable style={{ flex: 1, gap: 2 }} onPress={() => openProfile(l.url, known)}>
                <Text style={s_.name} numberOfLines={1}>
                  {l.name || l.handle}
                </Text>
                <Text style={s_.hint} numberOfLines={1}>
                  {l.handle}
                  {l.channel ? ' · has a channel' : ''}
                </Text>
                {l.verified ? (
                  <Text style={[s_.badge, { color: colors.ok }]}>
                    <Icon name="check" size={13} color={colors.ok} /> Linked both ways{l.checked_at ? ` · checked ${ago(l.checked_at)}` : ''}
                  </Text>
                ) : (
                  <Text style={[s_.badge, { color: colors.warn }]}>
                    <Icon name="hourglass-top" size={13} color={colors.warn} /> Waiting for it to link back
                  </Text>
                )}
                {!!l.error && <Text style={[s_.badge, { color: colors.err }]}>{l.error}</Text>}
              </Pressable>
              <IconButton name="link-off" label={`Unlink ${l.handle}`} color={colors.text2} onPress={() => unlink(l)} />
            </View>
          ))}
          {s.links.some((l) => !l.verified) && (
            <Button title="Check again" icon="refresh" onPress={() => run(() => api.post<LinksState>('/me/links/check'), 'Checked again')} busy={busy} disabled={off} style={{ alignSelf: 'flex-start' }} />
          )}
        </View>
      )}
    </KeyboardAwareScrollView>
  );
}

const s_ = StyleSheet.create({
  section: { color: colors.text2, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 6 },
  hint: { color: colors.text2, fontSize: 13, lineHeight: 18 },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  badge: { fontSize: 12.5, marginTop: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
});
