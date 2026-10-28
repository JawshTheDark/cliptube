import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Field, Input, Notice, Section, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Button, Loading } from '@/components/ui';
import { readable } from '@/lib/layout';
import { useLinkedApi } from '@/lib/scope';
import { colors } from '@/lib/theme';

/**
 * The website's three email pages in one screen: "Forgot your password?" (asks for a reset link), and, from the
 * links in those emails, choosing a new password (?token=…&mode=reset) and confirming an email address (mode=verify).
 */
export default function EmailPages() {
  const params = useLocalSearchParams<{ token?: string; mode?: string; server?: string }>();
  const mode = params.token ? (params.mode === 'verify' ? 'verify' : 'reset') : 'forgot';
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 20, gap: 16 }, readable]} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: mode === 'forgot' ? 'Forgot your password?' : mode === 'reset' ? 'Choose a new password' : 'Confirm email' }} />
      {mode === 'forgot' ? <Forgot server={params.server} /> : mode === 'reset' ? <Reset token={params.token!} server={params.server} /> : <Verify token={params.token!} server={params.server} />}
    </ScrollView>
  );
}

function Forgot({ server }: { server?: string }) {
  const { api } = useLinkedApi(server);
  const [login, setLogin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setMsg((await api.post<{ message: string }>('/auth/forgot-password', { login })).message);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section hint={`We'll email a reset link to the confirmed address on your account at ${api.base.replace(/^https?:\/\//, '')}.`}>
      {msg ? (
        <Notice icon="mark-email-read">{msg}</Notice>
      ) : (
        <>
          {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
          <Field label="Username or email">
            <Input value={login} onChangeText={setLogin} autoCapitalize="none" autoFocus onSubmitEditing={submit} />
          </Field>
          <Button title="Send reset link" kind="accent" busy={busy} disabled={!login.trim()} onPress={submit} style={{ alignSelf: 'flex-start' }} />
        </>
      )}
      <Text style={{ color: colors.link }} onPress={() => router.replace('/login')}>
        Back to sign in
      </Text>
    </Section>
  );
}

function Reset({ token, server }: { token: string; server?: string }) {
  const { api } = useLinkedApi(server);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pw !== pw2) return setError('Passwords do not match');
    if (pw.length < 6) return setError('Use at least 6 characters');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password: pw });
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <Section>
        <Notice icon="check-circle" tone="ok">
          Password changed. Sign in with the new one.
        </Notice>
        <Button title="Sign in" kind="accent" onPress={() => router.replace('/login')} style={{ alignSelf: 'flex-start' }} />
      </Section>
    );
  }
  return (
    <Section>
      {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
      <Field label="New password">
        <Input value={pw} onChangeText={setPw} secureTextEntry autoComplete="new-password" autoFocus />
      </Field>
      <Field label="Confirm new password">
        <Input value={pw2} onChangeText={setPw2} secureTextEntry autoComplete="new-password" onSubmitEditing={submit} />
      </Field>
      <Button title="Change password" kind="accent" busy={busy} disabled={!pw} onPress={submit} style={{ alignSelf: 'flex-start' }} />
    </Section>
  );
}

function Verify({ token, server }: { token: string; server?: string }) {
  const { api } = useLinkedApi(server);
  const [state, setState] = useState<'checking' | 'ok' | 'failed'>('checking');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .post('/auth/verify-email', { token })
      .then(() => setState('ok'))
      .catch((e) => {
        setError(e.message);
        setState('failed');
      });
  }, [api, token]);
  return (
    <Section>
      {state === 'checking' && <Loading />}
      {state === 'ok' && <Notice icon="check-circle" tone="ok">Your email address is confirmed. Choose which notifications reach it in Settings.</Notice>}
      {state === 'failed' && <Text style={{ color: colors.err }}>{error}</Text>}
      <Text style={fs.hint}>
        <Text style={{ color: colors.link }} onPress={() => router.replace('/account?tab=notifications' as any)}>
          Notification settings
        </Text>
      </Text>
    </Section>
  );
}
