import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Field, Input, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Button, Icon, toast } from '@/components/ui';
import { readable } from '@/lib/layout';
import { useLinkedApi } from '@/lib/scope';
import type { ReportTarget } from '@/lib/report';
import { colors } from '@/lib/theme';

const REASONS: [string, string, string][] = [
  ['copyright', 'Copyright', "It uses someone's work without permission"],
  ['spam', 'Spam or scam', 'Misleading, repetitive or a scam'],
  ['harassment', 'Harassment or hate', 'Targets a person or group'],
  ['illegal', 'Illegal content', 'Breaks the law'],
  ['other', 'Something else', ''],
];

export default function Report() {
  const p = useLocalSearchParams<{ type: ReportTarget['type']; id: string; label?: string; extra?: string; server?: string }>();
  const { api } = useLinkedApi(p.server);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = String(p.type).startsWith('remote_');
  const what = p.type === 'user' ? 'channel' : String(p.type).replace('remote_', '');

  const submit = async () => {
    if (!reason) return setError('Pick a reason');
    setBusy(true);
    setError(null);
    try {
      let extra = {};
      try {
        extra = p.extra ? JSON.parse(p.extra) : {};
      } catch {
        /* none */
      }
      await api.post('/reports', { target_type: p.type, target_id: p.id, reason, details, ...extra });
      toast('Thanks. The moderators will take a look.');
      router.back();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 16, gap: 14 }, readable]} keyboardShouldPersistTaps="handled" bottomOffset={24}>
      <Stack.Screen options={{ title: `Report ${what}` }} />
      {!!p.label && (
        <Text style={fs.hint} numberOfLines={3}>
          {p.label}
        </Text>
      )}
      <View style={{ gap: 8 }}>
        {REASONS.map(([value, label, hint]) => {
          const on = reason === value;
          return (
            <Pressable key={value} onPress={() => setReason(value)} style={[s.reason, on && s.reasonOn]} accessibilityRole="radio" accessibilityState={{ checked: on }}>
              <Icon name={on ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={on ? colors.accent : colors.text2} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700' }}>{label}</Text>
                {!!hint && <Text style={fs.hint}>{hint}</Text>}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Field label="Details (optional)">
        <Input value={details} onChangeText={setDetails} multiline maxLength={2000} placeholder="Anything that helps the moderators" />
      </Field>
      {reason === 'copyright' && (
        <Text style={fs.hint}>
          If you own the work, a formal notice is handled fastest through the contact details on the{' '}
          <Text style={{ color: colors.link }} onPress={() => Linking.openURL(`${api.base}/legal`)}>
            legal page
          </Text>
          .
        </Text>
      )}
      {remote && <Text style={fs.hint}>This report goes to the moderators here and to the server that hosts it.</Text>}
      {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
      <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
        <Button title="Cancel" kind="ghost" onPress={() => router.back()} />
        <Button title="Report" kind="accent" busy={busy} disabled={!reason} onPress={submit} />
      </View>
    </KeyboardAwareScrollView>
  );
}

const s = StyleSheet.create({
  reason: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  reasonOn: { borderColor: colors.accent },
});
