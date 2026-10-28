import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { AdminTabs } from '@/components/AdminTabs';
import { HeldComments, Quote } from '@/components/HeldComments';
import { Badge, Field, FieldRow, Input, Notice, NumberInput, Section, Toggle, isOn, s as fs } from '@/components/Form';
import { confirm, prompt } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Button, Chip, Empty, Loading, toast } from '@/components/ui';
import { ago } from '@/lib/format';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const ACTIONS: Record<string, [string, string][]> = {
  video: [
    ['hide_video', 'Hide video'],
    ['remove_video', 'Remove video'],
    ['strike_user', 'Strike uploader'],
    ['suspend_user', 'Suspend uploader'],
  ],
  comment: [
    ['delete_comment', 'Delete comment'],
    ['suspend_user', 'Suspend author'],
    ['block_instance', 'Block their instance'],
  ],
  user: [
    ['strike_user', 'Add strike'],
    ['suspend_user', 'Suspend'],
    ['ban_user', 'Ban'],
  ],
  remote_video: [
    ['hide_remote_video', 'Hide here'],
    ['block_instance', 'Block instance'],
  ],
  remote_comment: [['block_instance', 'Block instance']],
};
const TABS = [
  ['reports', 'Reports'],
  ['held', 'Held comments'],
  ['counter', 'Appeals'],
  ['log', 'Audit log'],
  ['spam', 'Spam settings'],
] as const;
type Tab = (typeof TABS)[number][0];

const watch = (id: string) => router.push(`/watch/${encodeURIComponent(id)}` as any);
/** Moderation, the website's /admin/moderation: reports, held comments, appeals, the audit log and spam controls. */
export default function AdminModeration() {
  const { api, user } = useSession();
  const [tab, setTab] = useState<Tab>('reports');
  const [summary, setSummary] = useState<any>(null);
  useEffect(() => {
    api.get('/mod/summary').then(setSummary).catch(() => {});
  }, [api, tab]);
  if (!user?.is_moderator && !user?.is_admin) return <Empty icon="lock" title="Moderators only">Moderation is for this server's moderators and admins.</Empty>;
  const count: Record<string, number | undefined> = { reports: summary?.open_reports, held: summary?.held_comments, counter: summary?.pending_counter_notices };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminTabs />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }} style={{ flexGrow: 0 }}>
        {TABS.map(([k, label]) => (
          <Chip key={k} label={count[k] ? `${label} · ${count[k]}` : label} active={tab === k} onPress={() => setTab(k)} />
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={[{ padding: 16, paddingTop: 6, gap: 12, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled">
        {summary?.pending_accounts > 0 && user.is_admin && (
          <Notice icon="person-add">
            <Text style={{ color: colors.text }}>
              {`${summary.pending_accounts} new account${summary.pending_accounts === 1 ? ' is' : 's are'} waiting for approval under `}
              <Text style={{ color: colors.link }} onPress={() => router.replace('/admin' as any)}>
                Overview → Users
              </Text>
              .
            </Text>
          </Notice>
        )}
        {tab === 'reports' && <Reports />}
        {tab === 'held' && <HeldComments />}
        {tab === 'counter' && <CounterNotices />}
        {tab === 'log' && <Log />}
        {tab === 'spam' && <SpamSettings />}
      </ScrollView>
    </View>
  );
}

function TargetSummary({ r }: { r: any }) {
  const { api } = useSession();
  const t = r.target;
  if (!t.exists) return <Text style={fs.hint}>The reported item no longer exists.</Text>;
  switch (r.target_type) {
    case 'video':
      return (
        <Pressable style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }} onPress={() => watch(t.video_id)}>
          {!!t.thumbnail_url && <Image source={{ uri: api.abs(t.thumbnail_url)! }} style={{ width: 96, aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: colors.surface2 }} />}
          <View style={{ flex: 1 }}>
            <Text style={[fs.itemTitle, { color: colors.link }]}>{t.title}</Text>
            <Text style={fs.hint}>{`by @${t.owner}${t.moderation_status ? ` · currently ${t.moderation_status}` : ''}`}</Text>
          </View>
        </Pressable>
      );
    case 'comment':
      return (
        <View style={{ gap: 6 }}>
          <Quote text={t.body} />
          <Text style={fs.hint}>
            {`@${t.author} on `}
            <Text style={{ color: colors.link }} onPress={() => watch(t.video_id)}>
              {t.video_title}
            </Text>
            {t.status === 'held' ? ' · held' : ''}
          </Text>
        </View>
      );
    case 'user':
      return (
        <View>
          <Text style={fs.itemTitle}>
            <Text style={{ color: colors.link }} onPress={() => router.push(`/c/${encodeURIComponent(t.username)}` as any)}>
              {t.display_name}
            </Text>
            <Text style={fs.hint}>{`  @${t.username}`}</Text>
          </Text>
          <Text style={fs.hint}>{`${t.status !== 'active' ? `${t.status} · ` : ''}${t.strikes} active strike${t.strikes === 1 ? '' : 's'}`}</Text>
        </View>
      );
    default:
      return (
        <View>
          <Text style={[fs.itemTitle, r.target_url && { color: colors.link }]} onPress={r.target_url ? () => router.push(r.target_url) : undefined}>
            {t.title}
          </Text>
          <Text style={fs.hint}>{`on ${t.instance_name}${t.hidden ? ' · hidden here' : ''}${t.instance_blocked ? ' · instance blocked' : ''}`}</Text>
        </View>
      );
  }
}

function ReportCard({ r, onChanged }: { r: any; onChanged: () => void }) {
  const { api } = useSession();
  const [notes, setNotes] = useState(r.notes || '');
  const [busy, setBusy] = useState(false);
  const act = async (action: string, label: string) => {
    const reason =
      action === 'dismiss' || action === 'resolve'
        ? ''
        : await prompt({ title: label, message: 'Reason (shown to the person affected where it applies).', defaultValue: r.reason_label, confirmLabel: label });
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await api.post<{ message: string }>(`/mod/reports/${r.id}/action`, { action, reason });
      toast(res.message);
      onChanged();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const saveNotes = async () => {
    try {
      await api.patch(`/mod/reports/${r.id}`, { notes });
      toast('Notes saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Badge text={r.reason_label} tone={r.reason === 'illegal' || r.reason === 'copyright' ? 'err' : 'warn'} />
        <Text style={fs.hint}>{`${String(r.target_type).replace('_', ' ')} · reported by ${r.reporter || 'someone'}${r.from_instance ? ` (via ${r.from_instance})` : ''} · ${ago(r.created_at)}`}</Text>
        {r.status !== 'open' && <Badge text={`${r.status}: ${r.resolution || ''}${r.handled_by ? ` by @${r.handled_by}` : ''}`} />}
      </View>
      <TargetSummary r={r} />
      {!!r.details && <Text style={{ color: colors.text, fontStyle: 'italic' }}>{`“${r.details}”`}</Text>}
      {r.status === 'open' && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(ACTIONS[r.target_type] || []).map(([a, label]) => (
            <Button key={a} title={label} small disabled={busy || !r.target.exists} onPress={() => act(a, label)} />
          ))}
          <Button title="Mark handled" small kind="ghost" disabled={busy} onPress={() => act('resolve', 'Resolve')} />
          <Button title="Dismiss" small kind="ghost" disabled={busy} onPress={() => act('dismiss', 'Dismiss')} />
        </View>
      )}
      <FieldRow>
        <Input value={notes} onChangeText={setNotes} placeholder="Private moderator notes" style={{ flex: 1, minWidth: 180 }} />
        {notes !== (r.notes || '') && <Button title="Save" small onPress={saveNotes} />}
      </FieldRow>
    </Section>
  );
}

function Reports() {
  const { api } = useSession();
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState<any[] | null>(null);
  const load = useCallback(
    () =>
      api
        .get<{ reports: any[] }>(`/mod/reports?status=${status}`)
        .then((r) => setReports(r.reports))
        .catch(() => setReports([])),
    [api, status],
  );
  useEffect(() => {
    setReports(null);
    load();
  }, [load]);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {['open', 'resolved', 'dismissed', 'all'].map((s) => (
          <Chip key={s} label={s[0].toUpperCase() + s.slice(1)} active={status === s} onPress={() => setStatus(s)} />
        ))}
      </View>
      {reports === null ? <Loading /> : reports.length === 0 ? <Text style={fs.hint}>Nothing here.</Text> : reports.map((r) => <ReportCard key={r.id} r={r} onChanged={load} />)}
    </>
  );
}

function CounterNotices() {
  const { api } = useSession();
  const [list, setList] = useState<any[] | null>(null);
  const load = useCallback(
    () =>
      api
        .get<{ counter_notices: any[] }>('/mod/counter-notices')
        .then((r) => setList(r.counter_notices))
        .catch(() => setList([])),
    [api],
  );
  useEffect(() => {
    load();
  }, [load]);
  const decide = async (cn: any, decision: 'accept' | 'reject') => {
    if (!(await confirm(decision === 'accept' ? 'Restore the video?' : 'Keep the video removed?', undefined, { confirmLabel: decision === 'accept' ? 'Restore' : 'Keep removed' }))) return;
    try {
      await api.post(`/mod/counter-notices/${cn.id}`, { decision });
      toast(decision === 'accept' ? 'Video restored' : 'Counter-notice rejected');
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  if (list === null) return <Loading />;
  if (!list.length) return <Text style={fs.hint}>No counter-notices or appeals yet.</Text>;
  return (
    <>
      {list.map((cn) => (
        <Section key={cn.id}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Badge text={cn.status} tone={cn.status === 'pending' ? 'warn' : cn.status === 'accepted' ? 'ok' : 'neutral'} />
            <Text style={fs.hint}>
              {`@${cn.username} about `}
              <Text style={{ color: colors.link }} onPress={() => watch(cn.video_id)}>
                {cn.video_title || cn.video_id}
              </Text>
              {` · ${ago(cn.created_at)}`}
            </Text>
          </View>
          {!!cn.claimant && <Text style={fs.hint}>{`Original notice from ${cn.claimant}: ${cn.work}`}</Text>}
          <Quote text={cn.statement} />
          {!!cn.contact && <Text style={fs.hint}>{`Contact: ${cn.contact}`}</Text>}
          {cn.status === 'pending' && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button title="Accept and restore" small kind="accent" onPress={() => decide(cn, 'accept')} />
              <Button title="Reject" small onPress={() => decide(cn, 'reject')} />
            </View>
          )}
        </Section>
      ))}
    </>
  );
}

function Log() {
  const { api } = useSession();
  const [actions, setActions] = useState<any[] | null>(null);
  useEffect(() => {
    api
      .get<{ actions: any[] }>('/mod/log?limit=200')
      .then((r) => setActions(r.actions))
      .catch(() => setActions([]));
  }, [api]);
  if (actions === null) return <Loading />;
  if (!actions.length) return <Text style={fs.hint}>No moderation actions yet.</Text>;
  return (
    <Section>
      {actions.map((a) => (
        <View key={a.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.hairline, gap: 2 }}>
          <Text style={{ color: colors.text }}>
            <Text style={{ fontWeight: '700' }}>{a.actor_label}</Text>
            {`  ${a.action}  `}
            <Text style={{ color: colors.text2 }}>{a.target_label || a.target_id || ''}</Text>
          </Text>
          <Text style={fs.hint}>{`${ago(a.created_at)}${a.details ? ` · ${a.details}` : ''}`}</Text>
        </View>
      ))}
    </Section>
  );
}

function SpamSettings() {
  const { api } = useSession();
  const [s, setS] = useState<any>(null);
  const [nums, setNums] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .get<{ settings: any }>('/mod/settings')
      .then((r) => {
        setS(r.settings);
        setNums({ spam_new_account_hours: String(r.settings.spam_new_account_hours ?? ''), spam_rate_per_10min: String(r.settings.spam_rate_per_10min ?? ''), spam_rate_new_per_10min: String(r.settings.spam_rate_new_per_10min ?? '') });
      })
      .catch(() => {});
  }, [api]);
  if (!s) return <Loading />;
  const save = async (patch: Record<string, unknown>) => {
    try {
      const r = await api.patch<{ settings: any }>('/mod/settings', patch);
      setS(r.settings);
      toast('Saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const num = (key: string, label: string) => (
    <Field label={label} style={{ flex: 1, minWidth: 150 }}>
      <NumberInput value={nums[key]} onChangeText={(t) => setNums((n) => ({ ...n, [key]: t }))} onEndEditing={() => nums[key] !== String(s[key]) && save({ [key]: nums[key] })} />
    </Field>
  );
  return (
    <Section title="Comment spam controls" hint="These apply to everyone, including people commenting from other instances. Uploaders and moderators are never held.">
      <Toggle
        label="Hold a person's first comment"
        hint="Their first comment waits for the uploader or a moderator; after that they post freely."
        value={isOn(s.spam_hold_first_comments)}
        onChange={(v) => save({ spam_hold_first_comments: v })}
      />
      <Toggle label="Hold links from new accounts" value={isOn(s.spam_hold_links_new_accounts)} onChange={(v) => save({ spam_hold_links_new_accounts: v })} />
      <Toggle
        label="Hold names that imitate the uploader"
        hint={'Catches lookalike names such as "Jawsh" vs "Jawsh_" or "J4wsh".'}
        value={isOn(s.spam_check_impersonation)}
        onChange={(v) => save({ spam_check_impersonation: v })}
      />
      <FieldRow>
        {num('spam_new_account_hours', 'New account period (hours)')}
        {num('spam_rate_per_10min', 'Comments per 10 minutes')}
        {num('spam_rate_new_per_10min', '…for new accounts')}
      </FieldRow>
    </Section>
  );
}
