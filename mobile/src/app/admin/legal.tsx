import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { AdminTabs } from '@/components/AdminTabs';
import { Badge, Field, FieldRow, Input, ListItem, NumberInput, Section, Select, Toggle, isOn, onOff, s as fs } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Button, Empty, Loading, toast } from '@/components/ui';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const EMPTY_NOTICE = { video: '', claimant: '', claimant_contact: '', work: '', url: '', received_at: '', action: 'removed', notes: '' };

/** Admin → Legal, the website's /admin/legal: the legal page, repeat-infringer rules, and takedown notices. */
export default function AdminLegal() {
  const { api, user, refresh } = useSession();
  const [state, setState] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [notice, setNotice] = useState(EMPTY_NOTICE);
  const [busy, setBusy] = useState(false);
  const apply = (s: any) => {
    setState(s);
    setForm(s.settings);
  };
  useEffect(() => {
    api.get('/admin/legal').then(apply).catch((e) => toast(e.message));
  }, [api]);
  if (!user?.is_admin) return <Empty icon="lock" title="Admins only">Legal settings are for this server's admins.</Empty>;
  if (!state || !form) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AdminTabs />
        <Loading />
      </View>
    );
  }
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(state.settings);
  const save = async () => {
    setBusy(true);
    try {
      apply(await api.patch('/admin/legal', form));
      refresh();
      toast('Saved');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const record = async () => {
    if (!notice.claimant.trim() || !notice.work.trim()) return toast('Fill in the claimant and the copyrighted work');
    if (notice.action === 'removed' && !(await confirm('Record this notice and remove the video now?', undefined, { confirmLabel: 'Remove', destructive: true }))) return;
    setBusy(true);
    try {
      apply(await api.post('/admin/legal/takedowns', notice));
      setNotice(EMPTY_NOTICE);
      toast(notice.action === 'removed' ? 'Notice recorded and video removed' : 'Notice recorded');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminTabs />
      <ScrollView contentContainerStyle={[{ padding: 16, gap: 14, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled">
        <Text style={fs.hint}>
          Background, not legal advice: in the US, the DMCA safe harbors expect a registered DMCA agent, quick action on valid notices and a
          repeat-infringer policy. The README has more. Talk to a lawyer before opening an instance to strangers.
        </Text>
        <Section title="Legal page" hint="Shown at /legal, linked from the sidebar, watch pages and sign-up.">
          <Field label="Contact email for abuse and copyright">
            <Input value={form.legal_contact_email} keyboardType="email-address" autoCapitalize="none" onChangeText={(t) => set({ legal_contact_email: t })} />
          </Field>
          <Field label="DMCA agent">
            <Input multiline value={form.legal_dmca_agent} onChangeText={(t) => set({ legal_dmca_agent: t })} placeholder="Name, address, phone and email as registered with the US Copyright Office" />
          </Field>
          <Field label="Rules">
            <Input multiline value={form.legal_rules} onChangeText={(t) => set({ legal_rules: t })} placeholder="What's allowed here" style={{ minHeight: 140 }} />
          </Field>
          <Field label="Terms people accept at sign-up">
            <Input multiline value={form.legal_terms} onChangeText={(t) => set({ legal_terms: t })} placeholder="Leave empty to skip the checkbox at sign-up" />
          </Field>
          <Toggle
            label="Publish a transparency report"
            hint="Counts of notices, removals and restored videos at /transparency."
            value={isOn(form.legal_transparency_public)}
            onChange={(b) => set({ legal_transparency_public: onOff(b) })}
          />
          <Text style={fs.label}>Repeat infringers</Text>
          <Toggle label="Strike the uploader when a notice removes a video" value={isOn(form.strike_on_takedown)} onChange={(b) => set({ strike_on_takedown: onOff(b) })} />
          <FieldRow>
            <Field label="Strikes that suspend an account" hint="0 turns automatic suspension off" style={{ flex: 1, minWidth: 160 }}>
              <NumberInput value={form.strike_threshold} onChangeText={(t) => set({ strike_threshold: t })} />
            </Field>
            <Field label="Strikes expire after (days)" style={{ flex: 1, minWidth: 160 }}>
              <NumberInput value={form.strike_expiry_days} onChangeText={(t) => set({ strike_expiry_days: t })} />
            </Field>
          </FieldRow>
          <Field label="Keep removed videos' files for (days)" hint="Long enough for a counter-notice; the files are deleted afterwards.">
            <NumberInput value={form.removed_retention_days} onChangeText={(t) => set({ removed_retention_days: t })} />
          </Field>
          <Button title="Save" kind="accent" disabled={!dirty || busy} onPress={save} style={{ alignSelf: 'flex-start' }} />
        </Section>

        <Section title="Record a takedown notice">
          <Field label="Video link or id">
            <Input value={notice.video} onChangeText={(t) => setNotice({ ...notice, video: t })} placeholder="https://.../watch/abc123" autoCapitalize="none" />
          </Field>
          <FieldRow>
            <Field label="Claimant" style={{ flex: 1, minWidth: 160 }}>
              <Input value={notice.claimant} onChangeText={(t) => setNotice({ ...notice, claimant: t })} />
            </Field>
            <Field label="Claimant contact" style={{ flex: 1, minWidth: 160 }}>
              <Input value={notice.claimant_contact} onChangeText={(t) => setNotice({ ...notice, claimant_contact: t })} autoCapitalize="none" />
            </Field>
          </FieldRow>
          <Field label="Copyrighted work">
            <Input multiline value={notice.work} onChangeText={(t) => setNotice({ ...notice, work: t })} />
          </Field>
          <FieldRow>
            <Field label="Received" hint="YYYY-MM-DD" style={{ flex: 1, minWidth: 140 }}>
              <Input value={notice.received_at} onChangeText={(t) => setNotice({ ...notice, received_at: t })} placeholder={new Date().toISOString().slice(0, 10)} keyboardType="numbers-and-punctuation" />
            </Field>
            <Field label="Action" style={{ flex: 1, minWidth: 180 }}>
              <Select
                value={notice.action}
                options={[
                  { value: 'removed', label: 'Remove the video' },
                  { value: 'none', label: 'Record only' },
                  { value: 'rejected', label: 'Reject (invalid notice)' },
                ]}
                onChange={(v) => setNotice({ ...notice, action: v })}
              />
            </Field>
          </FieldRow>
          <Field label="Notes">
            <Input multiline value={notice.notes} onChangeText={(t) => setNotice({ ...notice, notes: t })} />
          </Field>
          <Button title="Record notice" kind="accent" disabled={busy} onPress={record} style={{ alignSelf: 'flex-start' }} />

          <Text style={[fs.label, { marginTop: 6 }]}>{`Takedown log (${state.notices.length})`}</Text>
          {state.notices.length === 0 ? (
            <Text style={fs.hint}>No notices yet.</Text>
          ) : (
            state.notices.map((n: any) => (
              <ListItem
                key={n.id}
                onPress={n.video_id ? () => router.push(`/watch/${encodeURIComponent(n.video_id)}` as any) : undefined}
                title={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={[fs.itemTitle, n.video_id && { color: colors.link }]}>{n.video_id ? n.video_title || n.video_id : n.url || 'No video'}</Text>
                    <Badge text={n.action} tone={n.action === 'removed' ? 'err' : 'neutral'} />
                    {n.status !== 'closed' && <Badge text={n.status} tone="warn" />}
                  </View>
                }
                sub={`${n.claimant} · ${n.received_at ? new Date(n.received_at).toLocaleDateString() : ''} · ${n.work}`}
              />
            ))
          )}
        </Section>
      </ScrollView>
    </View>
  );
}
