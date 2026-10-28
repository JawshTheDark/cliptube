import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { AdminTabs } from '@/components/AdminTabs';
import { Badge, Field, FieldRow, Input, ListItem, Notice, NumberInput, Section, Select, Stats, Toggle, isOn, onOff, s as fs } from '@/components/Form';
import { confirm, prompt } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Avatar, Button, Empty, IconButton, Loading, toast } from '@/components/ui';
import { bytes } from '@/lib/format';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const ENCODER_LABELS: Record<string, string> = {
  libx264: 'libx264 (CPU, works everywhere)',
  h264_nvenc: 'NVIDIA NVENC (GPU)',
  h264_qsv: 'Intel Quick Sync (GPU)',
  h264_amf: 'AMD AMF (GPU)',
};
const REGISTRATION = [
  { value: 'open', label: 'Open', hint: 'Anyone can create an account.' },
  { value: 'approval', label: 'Needs approval', hint: 'Anyone can sign up, but an admin approves each account before it can sign in. Invite links skip approval.' },
  { value: 'invite', label: 'Invite only', hint: 'Only people with an invite link can sign up.' },
  { value: 'closed', label: 'Closed', hint: 'Nobody can sign up.' },
];
const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString() : '');

type Settings = Record<string, any>;
type AdminUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: number;
  video_count: number;
  bytes: number;
  quota_mb: number | null;
  strikes: number;
  role: 'user' | 'moderator' | 'admin';
  status: 'active' | 'pending' | 'suspended' | 'banned';
  status_reason?: string | null;
  delete_requested_at?: number | null;
};

/** Admin → Overview, the website's /admin: how the server is doing, its settings, its people, invites and email. */
export default function AdminOverview() {
  const { api, user, refresh, server } = useSession();
  const [stats, setStats] = useState<any>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [encoders, setEncoders] = useState<string[]>([]);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [update, setUpdate] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const loadStats = useCallback(() => api.get('/admin/stats').then(setStats).catch(() => {}), [api]);
  const loadUsers = useCallback(() => api.get<{ users: AdminUser[] }>('/admin/users').then((r) => setUsers(r.users)).catch((e) => toast(e.message)), [api]);
  useEffect(() => {
    api
      .get<{ settings: Settings; encoders: string[] }>('/admin/settings')
      .then((r) => {
        setForm(r.settings);
        setEncoders(r.encoders || []);
      })
      .catch((e) => toast(e.message));
    loadStats();
    loadUsers();
    api.get('/admin/diagnostics/update').then(setUpdate).catch(() => {});
    const t = setInterval(loadStats, 5000);
    return () => clearInterval(t);
  }, [api, loadStats, loadUsers]);

  if (!user?.is_admin) {
    return <Empty icon="lock" title="Admins only">The overview and site settings are for this server's admins.</Empty>;
  }

  const set = (patch: Settings) => setForm((f) => ({ ...(f || {}), ...patch }));
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const r = await api.patch<{ settings: Settings }>('/admin/settings', form);
      setForm(r.settings);
      refresh();
      toast('Settings saved');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateUser = async (u: AdminUser, body: Record<string, unknown>, message?: string) => {
    try {
      const r = await api.patch<{ user: Partial<AdminUser> }>(`/admin/users/${u.id}`, body);
      setUsers((list) => (list || []).map((x) => (x.id === u.id ? { ...x, ...r.user, status_reason: (body.reason as string) ?? x.status_reason } : x)));
      if (message) toast(message);
    } catch (e: any) {
      toast(e.message);
    }
  };
  const changeStatus = async (u: AdminUser, status: AdminUser['status']) => {
    if (status === 'active') return updateUser(u, { status }, u.status === 'pending' ? `@${u.username} is approved` : `@${u.username} is active again`);
    const reason = await prompt({
      title: `${status === 'banned' ? 'Ban' : 'Suspend'} @${u.username}?`,
      message: 'They are signed out and can’t sign in. The reason is shown to them.',
      placeholder: 'Reason',
      confirmLabel: status === 'banned' ? 'Ban' : 'Suspend',
    });
    if (reason !== null) updateUser(u, { status, reason }, `@${u.username} is ${status}`);
  };
  const setQuota = async (u: AdminUser) => {
    const v = await prompt({
      title: `Storage quota for @${u.username}`,
      message: 'In MB. Leave empty for the site default, 0 for unlimited.',
      defaultValue: u.quota_mb === null || u.quota_mb === undefined ? '' : String(u.quota_mb),
      numeric: true,
    });
    if (v === null) return;
    updateUser(u, { quota_mb: v.trim() === '' ? null : v.trim() }, 'Quota updated');
  };
  const deleteUser = async (u: AdminUser, pending = false) => {
    const ok = pending
      ? await confirm(`Reject @${u.username}?`, 'Their sign-up is deleted.', { confirmLabel: 'Reject', destructive: true })
      : await confirm(`Delete @${u.username}?`, `This deletes them and ALL of their videos (${u.video_count}). It cannot be undone.`, { confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    try {
      await api.del(`/admin/users/${u.id}`);
      setUsers((list) => (list || []).filter((x) => x.id !== u.id));
      toast('User deleted');
      loadStats();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const quotaLabel = (u: AdminUser) => (u.quota_mb === null || u.quota_mb === undefined ? 'site default' : u.quota_mb === 0 ? 'unlimited' : bytes(u.quota_mb * 1048576));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminTabs />
      <ScrollView contentContainerStyle={[{ padding: 16, gap: 14, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled">
        {update?.available && (
          <Notice icon="system-update" tone="ok">
            <Text style={{ color: colors.text, lineHeight: 20 }}>
              <Text style={{ fontWeight: '800' }}>{`OurTube ${update.latest} is out. `}</Text>
              {`This server runs ${update.current}. `}
              {!!update.changes && (
                <Text style={{ color: colors.link }} onPress={() => Linking.openURL(update.changes)}>
                  What changed
                </Text>
              )}
              {' · '}
              {!!update.repo && (
                <Text style={{ color: colors.link }} onPress={() => Linking.openURL(`${update.repo}/blob/main/docs/wiki/Upgrading-and-Backups.md`)}>
                  How to update
                </Text>
              )}
            </Text>
          </Notice>
        )}

        {stats ? (
          <Stats
            items={[
              { n: stats.users, l: 'Users' },
              { n: stats.ready, l: `Videos ready${stats.failed ? ` · ${stats.failed} failed` : ''}` },
              { n: (stats.views || 0).toLocaleString(), l: 'Total views' },
              { n: stats.comments, l: 'Comments' },
              { n: bytes(stats.disk?.videos), l: 'Video storage' },
              { n: bytes(stats.disk?.originals), l: 'Kept originals' },
              {
                n: bytes(stats.storage?.used),
                l: stats.storage?.limit
                  ? `Used of ${bytes(stats.storage.limit)} allowed`
                  : `Used in all${stats.storage?.disk_free !== null && stats.storage?.disk_free !== undefined ? ` · ${bytes(stats.storage.disk_free)} free on disk` : ''}`,
              },
              {
                n: stats.queue?.current ? stats.queue.waiting + 1 : stats.queue?.waiting ?? 0,
                l: `${stats.queue?.current ? 'Processing now' : 'Processing queue'}${stats.rendering ? ` · ${stats.rendering} edit render(s)` : ''}`,
              },
            ]}
          />
        ) : (
          <Loading />
        )}

        <Section title="Site settings">
          {form ? (
            <>
              <Field label="Site name">
                <Input value={form.site_name} maxLength={40} onChangeText={(t) => set({ site_name: t })} />
              </Field>
              <Field label="Public URL (optional)" hint="Used for link previews when sharing to Discord etc. Leave empty to use whatever address viewers connect with.">
                <Input value={form.public_url} placeholder="https://clips.example.com" autoCapitalize="none" keyboardType="url" onChangeText={(t) => set({ public_url: t })} />
              </Field>
              <Field label="Sign-up" hint={REGISTRATION.find((r) => r.value === form.registration_mode)?.hint}>
                <Select value={form.registration_mode} options={REGISTRATION} onChange={(v) => set({ registration_mode: v })} />
              </Field>
              <FieldRow>
                <Field label="Max upload size (MB)" style={{ flex: 1, minWidth: 140 }}>
                  <NumberInput value={form.max_upload_mb} onChangeText={(t) => set({ max_upload_mb: t })} />
                </Field>
                <Field label="Storage per person (MB)" hint="0 = unlimited. Override per person below." style={{ flex: 1, minWidth: 140 }}>
                  <NumberInput value={form.default_quota_mb} onChangeText={(t) => set({ default_quota_mb: t })} />
                </Field>
              </FieldRow>
              <Field
                label="Storage for the whole server (GB)"
                hint="0 = no limit. Counts everything OurTube keeps (videos, adaptive streaming, thumbnails, backups). Uploads and imports stop when they would go over it, and whenever the disk would have less than 1 GB free."
              >
                <NumberInput value={form.storage_limit_gb} onChangeText={(t) => set({ storage_limit_gb: t })} />
              </Field>
              <Field label="Max resolution" hint="Taller videos are scaled down when processed. Smaller files mean smoother playback over Wi-Fi.">
                <Select
                  value={String(form.max_height)}
                  options={[
                    { value: '480', label: '480p' },
                    { value: '720', label: '720p' },
                    { value: '1080', label: '1080p' },
                    { value: '1440', label: '1440p' },
                    { value: '2160', label: '2160p (4K)' },
                  ]}
                  onChange={(v) => set({ max_height: v })}
                />
              </Field>
              <Field
                label="Video encoder"
                hint="Used only when a video needs re-encoding (anything that is not already H.264 MP4). GPU encoders are much faster; if one fails it falls back to libx264 automatically."
              >
                <Select value={form.encoder} options={encoders.map((e) => ({ value: e, label: ENCODER_LABELS[e] || e }))} onChange={(v) => set({ encoder: v })} />
              </Field>
              <Toggle label="Delete the original file after re-encoding" hint="Saves disk, loses the lossless source." value={isOn(form.delete_originals)} onChange={(b) => set({ delete_originals: onOff(b) })} />
              <Field
                label="Adaptive streaming (HLS)"
                hint="Viewers on slow connections get a smaller stream and can pick a quality; source quality is always offered. Uses roughly 50 to 100% more disk per video, and each video is re-encoded once in the background. Changing this rebuilds every video."
              >
                <Select
                  value={form.hls_ladder}
                  options={[
                    { value: 'off', label: 'Off: play the MP4 only' },
                    { value: '720', label: '720p plus source quality' },
                    { value: 'full', label: '1080p, 720p and 480p plus source quality' },
                  ]}
                  onChange={(v) => set({ hls_ladder: v })}
                />
              </Field>
              <Toggle
                label="Keep a 720p copy of large videos for other platforms"
                hint="Mastodon and others only cache small videos."
                value={isOn(form.federation_rendition)}
                onChange={(b) => set({ federation_rendition: onOff(b) })}
              />
              <Toggle label="Show dislike counts" hint="Uploaders always see their own." value={isOn(form.show_dislikes)} onChange={(b) => set({ show_dislikes: onOff(b) })} />
              <Button title="Save settings" kind="accent" onPress={save} busy={busy} style={{ alignSelf: 'flex-start' }} />
            </>
          ) : (
            <Loading />
          )}
        </Section>

        <Section title="Users">
          {users === null ? (
            <Loading />
          ) : (
            users.map((u) => {
              const self = u.id === user.id;
              return (
                <View key={u.id} style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.hairline }}>
                  <Pressable style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} onPress={() => router.push(`/c/${encodeURIComponent(u.username)}` as any)}>
                    <Avatar uri={api.abs(u.avatar_url)} name={u.display_name} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={fs.itemTitle} numberOfLines={1}>
                        {u.display_name}
                      </Text>
                      <Text style={fs.hint}>{`@${u.username} · joined ${date(u.created_at)} · ${u.video_count} video${u.video_count === 1 ? '' : 's'}`}</Text>
                    </View>
                    {!!u.delete_requested_at && <Badge text="deleting" tone="warn" />}
                  </Pressable>
                  <Text style={fs.hint}>
                    {'Storage: '}
                    <Text style={{ color: colors.link }} onPress={() => setQuota(u)}>{`${bytes(u.bytes)} / ${quotaLabel(u)}`}</Text>
                    {'   Strikes: '}
                    {u.strikes > 0 ? (
                      <Text
                        style={{ color: colors.warn, fontWeight: '700' }}
                        onPress={async () => (await confirm(`Clear @${u.username}'s strikes?`)) && updateUser(u, { clear_strikes: true }, 'Strikes cleared')}
                      >
                        {`${u.strikes} (clear)`}
                      </Text>
                    ) : (
                      '0'
                    )}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <View style={{ width: 150 }}>
                      <Select
                        small
                        value={u.role}
                        disabled={self}
                        options={[
                          { value: 'user', label: 'Member' },
                          { value: 'moderator', label: 'Moderator' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                        onChange={(v) => updateUser(u, { role: v }, `@${u.username} is now ${v}`)}
                      />
                    </View>
                    {self ? (
                      <Badge text="Active" tone="ok" />
                    ) : u.status === 'pending' ? (
                      <>
                        <Button title="Approve" small kind="accent" onPress={() => changeStatus(u, 'active')} />
                        <Button title="Reject" small onPress={() => deleteUser(u, true)} />
                      </>
                    ) : (
                      <View style={{ width: 150 }}>
                        <Select
                          small
                          value={u.status}
                          options={[
                            { value: 'active', label: 'Active' },
                            { value: 'suspended', label: 'Suspended' },
                            { value: 'banned', label: 'Banned' },
                          ]}
                          onChange={(v) => changeStatus(u, v as AdminUser['status'])}
                        />
                      </View>
                    )}
                    {!self && u.status !== 'pending' && <IconButton name="delete-outline" label={`Delete @${u.username} and their videos`} onPress={() => deleteUser(u)} color={colors.text2} />}
                  </View>
                  {!!u.status_reason && u.status !== 'active' && <Text style={fs.hint}>{`Reason: ${u.status_reason}`}</Text>}
                </View>
              );
            })
          )}
        </Section>

        <Invites base={server} />
        <EmailSettings />
      </ScrollView>
    </View>
  );
}

function Invites({ base }: { base: string }) {
  const { api } = useSession();
  const [invites, setInvites] = useState<any[] | null>(null);
  const [draft, setDraft] = useState({ note: '', max_uses: '1', expires_days: '14' });
  const load = useCallback(() => api.get<{ invites: any[] }>('/admin/invites').then((r) => setInvites(r.invites)).catch((e) => toast(e.message)), [api]);
  useEffect(() => {
    load();
  }, [load]);
  const link = (code: string) => `${base}/register?invite=${code}`;
  const create = async () => {
    try {
      const r = await api.post<{ invite: { code: string } }>('/admin/invites', draft);
      await Clipboard.setStringAsync(link(r.invite.code));
      toast('Invite created and its link copied');
      setDraft({ ...draft, note: '' });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const remove = async (code: string) => {
    try {
      await api.del(`/admin/invites/${code}`);
      setInvites((list) => (list || []).filter((i) => i.code !== code));
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Invites" hint="Invite links let people join when sign-up is invite-only, and skip approval when it needs approval.">
      <Field label="Note">
        <Input value={draft.note} maxLength={200} placeholder="Who it's for" onChangeText={(t) => setDraft({ ...draft, note: t })} />
      </Field>
      <FieldRow>
        <Field label="Uses" hint="0 = unlimited" style={{ flex: 1, minWidth: 110 }}>
          <NumberInput value={draft.max_uses} onChangeText={(t) => setDraft({ ...draft, max_uses: t })} />
        </Field>
        <Field label="Days" hint="0 = never expires" style={{ flex: 1, minWidth: 110 }}>
          <NumberInput value={draft.expires_days} onChangeText={(t) => setDraft({ ...draft, expires_days: t })} />
        </Field>
      </FieldRow>
      <Button title="Create invite" kind="accent" icon="person-add" onPress={create} style={{ alignSelf: 'flex-start' }} />
      {invites === null ? (
        <Loading />
      ) : invites.length === 0 ? (
        <Text style={fs.hint}>No invites yet.</Text>
      ) : (
        invites.map((i) => {
          const expired = i.expires_at && i.expires_at < Date.now();
          const used = i.max_uses > 0 && i.uses >= i.max_uses;
          return (
            <ListItem
              key={i.code}
              title={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={[fs.itemTitle, { fontFamily: 'monospace' }]}>{i.code}</Text>
                  {!!i.note && <Text style={{ color: colors.text }}>{i.note}</Text>}
                  {(expired || used) && <Badge text={expired ? 'expired' : 'used up'} tone="warn" />}
                </View>
              }
              sub={`Used ${i.uses}${i.max_uses > 0 ? ` of ${i.max_uses}` : ''} · ${i.expires_at ? `expires ${date(i.expires_at)}` : 'never expires'}${i.created_by_name ? ` · by @${i.created_by_name}` : ''}`}
              right={
                <View style={{ flexDirection: 'row' }}>
                  <IconButton name="link" label="Copy link" onPress={async () => (await Clipboard.setStringAsync(link(i.code)), toast('Link copied'))} color={colors.text2} />
                  <IconButton name="delete-outline" label="Delete invite" onPress={() => remove(i.code)} color={colors.text2} />
                </View>
              }
            />
          );
        })
      )}
    </Section>
  );
}

function EmailSettings() {
  const { api } = useSession();
  const pick = (s: Settings) => ({ smtp_host: s.smtp_host, smtp_port: s.smtp_port, smtp_secure: s.smtp_secure, smtp_user: s.smtp_user, smtp_from: s.smtp_from, smtp_password_set: s.smtp_password_set });
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [password, setPassword] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    api
      .get<{ settings: Settings }>('/admin/settings')
      .then((r) => {
        setForm(pick(r.settings));
        setSaved(pick(r.settings));
      })
      .catch(() => {});
  }, [api]);
  if (!form || !saved) return null;
  const set = (patch: Settings) => setForm((f) => ({ ...(f || {}), ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || !!password;
  const save = async () => {
    try {
      const { smtp_password_set: _set, ...rest } = form;
      const r = await api.patch<{ settings: Settings }>('/admin/settings', { ...rest, ...(password ? { smtp_password: password } : {}) });
      setForm(pick(r.settings));
      setSaved(pick(r.settings));
      setPassword('');
      toast('Email settings saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const test = async () => {
    try {
      await api.post('/admin/mail/test', { to });
      toast(`Sent a test email to ${to}`);
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section
      title="Email (optional)"
      hint="With an SMTP server, people can confirm an email address, get the notifications they pick by email, and reset forgotten passwords. Everything works without it."
    >
      <FieldRow>
        <Field label="SMTP server" style={{ flex: 2, minWidth: 180 }}>
          <Input value={form.smtp_host} placeholder="smtp.example.com" autoCapitalize="none" onChangeText={(t) => set({ smtp_host: t })} />
        </Field>
        <Field label="Port" style={{ flex: 1, minWidth: 90 }}>
          <NumberInput value={form.smtp_port} onChangeText={(t) => set({ smtp_port: t })} />
        </Field>
      </FieldRow>
      <Field label="Encryption">
        <Select
          value={form.smtp_secure}
          options={[
            { value: 'starttls', label: 'STARTTLS (port 587)' },
            { value: 'tls', label: 'TLS (port 465)' },
            { value: 'none', label: 'None (local relay only)' },
          ]}
          onChange={(v) => set({ smtp_secure: v })}
        />
      </Field>
      <Field label="From">
        <Input value={form.smtp_from} placeholder="OurTube <clips@example.com>" autoCapitalize="none" onChangeText={(t) => set({ smtp_from: t })} />
      </Field>
      <FieldRow>
        <Field label="Username" style={{ flex: 1, minWidth: 150 }}>
          <Input value={form.smtp_user} autoCapitalize="none" autoComplete="off" onChangeText={(t) => set({ smtp_user: t })} />
        </Field>
        <Field label="Password" style={{ flex: 1, minWidth: 150 }}>
          <Input value={password} secureTextEntry placeholder={form.smtp_password_set ? 'Saved (type to change)' : ''} autoComplete="off" onChangeText={setPassword} />
        </Field>
      </FieldRow>
      <Button title="Save" kind="accent" onPress={save} disabled={!dirty} style={{ alignSelf: 'flex-start' }} />
      {!!saved.smtp_host && (
        <FieldRow>
          <Input value={to} onChangeText={setTo} placeholder="Send a test to…" keyboardType="email-address" autoCapitalize="none" style={{ flex: 1, minWidth: 180 }} />
          <Button title="Send test" onPress={test} disabled={!to} />
        </FieldRow>
      )}
    </Section>
  );
}
