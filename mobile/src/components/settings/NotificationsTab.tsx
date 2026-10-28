import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { router } from 'expo-router';
import { FieldRow, Input, Section, Select, Toggle, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Button, Loading, toast } from '@/components/ui';
import { DENSITIES, useDensity } from '@/lib/density';
import { usePrefs } from '@/lib/prefs';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

/** Settings → Notifications: what reaches you by push and by email, and the email address. */
export function NotificationsTab() {
  const { api } = useSession();
  const [n, setN] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<any>('/notifications/settings')
      .then((r) => {
        setN(r);
        setEmail(r.email || '');
      })
      .catch((e) => toast(e.message));
  }, [api]);
  if (!n) return <Loading />;
  const toggle = async (channel: 'push' | 'email', kind: string, on: boolean) => {
    const list = on ? [...new Set([...n.prefs[channel], kind])] : n.prefs[channel].filter((k: string) => k !== kind);
    try {
      const r = await api.patch<any>('/notifications/settings', { [channel]: list });
      setN((x: any) => ({ ...x, prefs: r.prefs }));
    } catch (e: any) {
      toast(e.message);
    }
  };
  const saveEmail = async () => {
    setBusy(true);
    try {
      const r = await api.put<any>('/notifications/email', { email });
      setN((x: any) => ({ ...x, email: r.email, email_verified: r.email_verified }));
      toast(r.sent ? 'Check your inbox for a confirmation link' : 'Email address removed');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Notifications" hint="Everything shows up in the Inbox tab. Pick what else reaches you as a push notification or an email.">
      <View style={{ flexDirection: 'row', paddingBottom: 4 }}>
        <View style={{ flex: 1 }} />
        <Text style={[fs.label, { width: 64, textAlign: 'center' }]}>Push</Text>
        <Text style={[fs.label, { width: 64, textAlign: 'center' }]}>Email</Text>
      </View>
      {Object.entries(n.kinds as Record<string, string>).map(([k, label]) => (
        <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2, borderTopWidth: 1, borderTopColor: colors.hairline }}>
          <Text style={{ flex: 1, color: colors.text }}>{label}</Text>
          <View style={{ width: 64, alignItems: 'center' }}>
            <Switch value={n.prefs.push.includes(k)} onValueChange={(v) => toggle('push', k, v)} trackColor={{ true: colors.accent, false: colors.surface3 }} thumbColor="#fff" accessibilityLabel={`${label} by push`} />
          </View>
          <View style={{ width: 64, alignItems: 'center', opacity: n.email_available ? 1 : 0.35 }}>
            <Switch
              value={n.prefs.email.includes(k)}
              disabled={!n.email_available}
              onValueChange={(v) => toggle('email', k, v)}
              trackColor={{ true: colors.accent, false: colors.surface3 }}
              thumbColor="#fff"
              accessibilityLabel={`${label} by email`}
            />
          </View>
        </View>
      ))}
      <Text style={fs.hint}>
        Push goes to the browsers where you turned it on in the website's Settings. The app doesn't receive push yet: it checks the Inbox every minute
        while it's open.
      </Text>
      <Text style={fs.label}>Email</Text>
      {n.email_available ? (
        <>
          <FieldRow>
            <Input value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" style={{ flex: 1, minWidth: 200 }} />
            <Button title={email ? 'Save' : 'Remove'} disabled={busy || email === (n.email || '')} onPress={saveEmail} />
          </FieldRow>
          <Text style={fs.hint}>
            {n.email ? (n.email_verified ? 'Confirmed. Also used for password resets.' : 'Not confirmed yet: open the link we emailed you.') : 'Optional. Used for the emails you pick above and for password resets.'}
          </Text>
        </>
      ) : (
        <Text style={fs.hint}>This site has no email set up, so notifications stay in the app and push.</Text>
      )}
    </Section>
  );
}

/** Settings → Watching: density and the website's watching preferences (kept on this phone), and privacy. */
export function WatchingTab({ s, patch }: { s: any; patch: (body: Record<string, unknown>, message?: string) => Promise<void> }) {
  const { prefs, setPref } = usePrefs();
  const { density, setDensity } = useDensity();
  return (
    <>
      <Section title="Watching" hint="Saved on this phone.">
        <Text style={fs.label}>Layout density</Text>
        <Select value={density} options={DENSITIES.map((d) => ({ value: d.key, label: d.label, hint: d.hint }))} onChange={setDensity} />
        <Text style={fs.hint}>Changes the size of the video cards on Home, channels, search and the rest.</Text>
        <Text style={fs.label}>Sponsor reads, intros and other marked parts</Text>
        <Select
          value={prefs.skip}
          options={[
            { value: 'auto', label: 'Skip them automatically' },
            { value: 'ask', label: 'Show a Skip button' },
            { value: 'off', label: "Don't skip" },
          ]}
          onChange={(v) => setPref('skip', v)}
        />
        <Toggle
          label="Community titles and thumbnails"
          hint="Show the plainer titles and honest thumbnails viewers voted for, instead of the uploader's."
          value={prefs.community === 'on'}
          onChange={(v) => setPref('community', v ? 'on' : 'off')}
        />
        <Toggle label="Turn captions on when a video has them" value={prefs.captions === 'on'} onChange={(v) => setPref('captions', v ? 'on' : 'off')} />
        <Toggle label="Keep Shorts off the home page" hint="No Shorts shelf on Home; they stay under Shorts." value={prefs.hide_vertical === 'on'} onChange={(v) => setPref('hide_vertical', v ? 'on' : 'off')} />
      </Section>
      <Section title="Privacy">
        <Toggle
          label="Pause watch history"
          hint="Videos you watch aren't added to your history or used for resume points."
          value={!!s.history_paused}
          onChange={(v) => patch({ history_paused: v }, v ? 'History paused' : 'History on')}
        />
        <Toggle
          label="Anonymous mode on this phone"
          hint="Watching from this phone doesn't touch your history, and views count as a signed-out viewer."
          value={prefs.anonymous === 'on'}
          onChange={(v) => setPref('anonymous', v ? 'on' : 'off')}
        />
        <Text style={{ color: colors.link }} onPress={() => router.push('/library/history' as any)}>
          Manage your history
        </Text>
      </Section>
    </>
  );
}
