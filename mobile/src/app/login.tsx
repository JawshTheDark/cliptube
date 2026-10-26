import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, View } from 'react-native';
import { Text, TextInput } from '@/components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { Button, Icon } from '@/components/ui';
import { Field, f } from '@/components/VideoForm';
import { hostLabel, isInsecure } from '@/lib/api';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

export default function Login() {
  const { server, site, signIn, register } = useSession();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [invite, setInvite] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canRegister = !!site?.allow_registration;
  const insecure = isInsecure(server);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'in') {
        await signIn(username, password);
        router.back();
      } else {
        const r = await register({ username, password, display_name: displayName.trim() || undefined, invite: invite.trim() || undefined, accept_terms: terms });
        if (r.pending) {
          setNotice(r.message || 'An admin needs to approve your account before you can sign in.');
          setMode('in');
        } else router.back();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <View style={s.server}>
          <Icon name="dns" size={20} color={colors.text2} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{site?.site_name || 'OurTube'}</Text>
            <Text style={s.hint}>{hostLabel(server)}</Text>
          </View>
          <Button title="Change" small onPress={() => router.push('/servers')} />
        </View>
        {insecure && (
          <Text style={[s.hint, { color: colors.warn }]}>This server doesn’t use HTTPS, so your password travels unencrypted.</Text>
        )}

        <View style={s.tabs}>
          <Pressable style={[s.tab, mode === 'in' && s.tabOn]} onPress={() => setMode('in')}>
            <Text style={[s.tabText, mode === 'in' && { color: colors.bg }]}>Sign in</Text>
          </Pressable>
          {canRegister && (
            <Pressable style={[s.tab, mode === 'up' && s.tabOn]} onPress={() => setMode('up')}>
              <Text style={[s.tabText, mode === 'up' && { color: colors.bg }]}>Create account</Text>
            </Pressable>
          )}
        </View>

        <Field label="Username">
          <TextInput value={username} onChangeText={setUsername} style={f.input} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" />
        </Field>
        {mode === 'up' && (
          <Field label="Display name">
            <TextInput value={displayName} onChangeText={setDisplayName} style={f.input} placeholder="Optional" placeholderTextColor={colors.text2} maxLength={50} />
          </Field>
        )}
        <Field label="Password">
          <TextInput
            value={password}
            onChangeText={setPassword}
            style={f.input}
            secureTextEntry
            autoCapitalize="none"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            textContentType={mode === 'in' ? 'password' : 'newPassword'}
            onSubmitEditing={submit}
          />
        </Field>
        {mode === 'up' && (site?.registration_mode === 'invite' || site?.registration_mode === 'approval') && (
          <Field label={site.registration_mode === 'invite' ? 'Invite code' : 'Invite code (skips approval)'}>
            <TextInput value={invite} onChangeText={setInvite} style={f.input} autoCapitalize="none" autoCorrect={false} />
          </Field>
        )}
        {mode === 'up' && site?.has_terms && (
          <View style={s.terms}>
            <Switch value={terms} onValueChange={setTerms} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" />
            <Text style={[s.hint, { flex: 1 }]}>
              I accept the{' '}
              <Text style={{ color: colors.link }} onPress={() => Linking.openURL(`${server}/legal`)}>
                site’s rules
              </Text>
            </Text>
          </View>
        )}
        {mode === 'up' && site?.registration_mode === 'approval' && <Text style={s.hint}>New accounts here wait for an admin to approve them.</Text>}

        {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
        {!!notice && <Text style={{ color: colors.ok }}>{notice}</Text>}
        <Button title={mode === 'in' ? 'Sign in' : 'Create account'} kind="primary" onPress={submit} busy={busy} disabled={!username || !password} />
        {mode === 'in' && (
          <Pressable onPress={() => Linking.openURL(`${server}/forgot-password`)}>
            <Text style={[s.hint, { textAlign: 'center' }]}>Forgot your password? Reset it on the website.</Text>
          </Pressable>
        )}
    </KeyboardAwareScrollView>
  );
}

const s = StyleSheet.create({
  server: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  hint: { color: colors.text2, fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, backgroundColor: colors.surface2 },
  tabOn: { backgroundColor: colors.text },
  tabText: { color: colors.text, fontWeight: '600' },
  terms: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
