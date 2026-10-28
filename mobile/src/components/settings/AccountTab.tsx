import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Badge, Field, FieldRow, Input, ListItem, Notice, Section, Toggle, s as fs } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Button, toast } from '@/components/ui';
import { downloadAndShare } from '@/lib/download';
import { bytes } from '@/lib/format';
import { pickFile } from '@/lib/pick';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString() : '');
const RUNNING = ['queued', 'working', 'downloading'];

/** Settings → Account: password, storage, your data, moving to another site, and deleting the account. */
export function AccountTab({ s }: { s: any }) {
  return (
    <>
      <PasswordSettings />
      <StorageCard storage={s.storage} />
      <DataSettings />
      <MoveSettings />
      <DeleteAccount initial={s.delete_requested_at} />
    </>
  );
}

function PasswordSettings() {
  const { api } = useSession();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async () => {
    setError(null);
    if (pw !== pw2) return setError('New passwords do not match');
    if (pw.length < 6) return setError('Use at least 6 characters');
    setBusy(true);
    try {
      await api.patch('/me', { current_password: current, new_password: pw });
      setCurrent('');
      setPw('');
      setPw2('');
      toast('Password changed');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Change password">
      {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
      <Field label="Current password">
        <Input value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" />
      </Field>
      <Field label="New password">
        <Input value={pw} onChangeText={setPw} secureTextEntry autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password">
        <Input value={pw2} onChangeText={setPw2} secureTextEntry autoComplete="new-password" />
      </Field>
      <Button title="Change password" onPress={change} busy={busy} disabled={!current || !pw} style={{ alignSelf: 'flex-start' }} />
    </Section>
  );
}

function StorageCard({ storage }: { storage: { used: number; quota: number } | undefined }) {
  if (!storage) return null;
  const pct = storage.quota > 0 ? Math.min(100, Math.round((storage.used / storage.quota) * 100)) : 0;
  return (
    <Section title="Storage">
      <Text style={{ color: colors.text }}>{`${bytes(storage.used)} used${storage.quota > 0 ? ` of ${bytes(storage.quota)}` : ', no limit'}`}</Text>
      {storage.quota > 0 && (
        <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: 'hidden' }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}>
          <View style={{ width: `${pct}%`, height: 8, backgroundColor: pct >= 90 ? colors.warn : colors.accent }} />
        </View>
      )}
    </Section>
  );
}

function DataSettings() {
  const { api } = useSession();
  const [state, setState] = useState<any>(null);
  const load = useCallback(() => api.get<any>('/me/exports').then(setState).catch(() => {}), [api]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!state?.preparing) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [state, load]);
  const start = async () => {
    try {
      await api.post('/me/exports');
      setState((x: any) => ({ ...(x || {}), preparing: true }));
      toast('Preparing your export');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const save = async (x: any) => {
    try {
      toast('Downloading…');
      await downloadAndShare(api, `/api/me/exports/${encodeURIComponent(x.file)}`, x.file, 'application/x-tar');
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section
      title="Your data"
      hint="Download everything you have here: your videos and their originals, thumbnails, comments, likes, subscriptions and history, in one archive. Links last 7 days."
    >
      <Button title={state?.preparing ? 'Preparing…' : 'Export my data'} icon="download" onPress={start} disabled={!state || state.preparing} style={{ alignSelf: 'flex-start' }} />
      {state?.exports?.map((x: any) => (
        <ListItem
          key={x.file}
          title={x.file}
          sub={`${bytes(x.size)} · made ${date(x.created_at)} · expires ${date(x.expires_at)}`}
          right={<Button title="Save" icon="save-alt" small onPress={() => save(x)} />}
        />
      ))}
    </Section>
  );
}

/** Taking a channel to another OurTube server: export it here, import it there, then move. */
function MoveSettings() {
  return (
    <Section
      title="Moving to another site"
      hint="Take your channel to another OurTube server: export it here, import it there, then move. Subscribers here, on other instances and on the fediverse follow you to the new channel."
    >
      <ExportPart />
      <ImportPart />
      <MovePart />
    </Section>
  );
}

function usePolled(load: () => void, busy: boolean | undefined) {
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  });
}

function ExportPart() {
  const { api } = useSession();
  const [list, setList] = useState<any[] | null>(null);
  const load = useCallback(
    () =>
      api
        .get<{ exports: any[] }>('/me/channel-exports')
        .then((r) => setList(r.exports))
        .catch(() => setList([])),
    [api],
  );
  useEffect(() => {
    load();
  }, [load]);
  const running = list?.some((x) => RUNNING.includes(x.status));
  usePolled(load, running);
  const start = async () => {
    try {
      await api.post('/me/channel-exports');
      toast('Preparing the export');
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const remove = async (x: any) => {
    try {
      await api.del(`/me/channel-exports/${x.id}`);
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <>
      <Text style={fs.label}>1. Export this channel</Text>
      <Text style={fs.hint}>One archive with your videos, thumbnails, captions, comments and subscriber list. It is kept for 7 days.</Text>
      <Button title={running ? 'Preparing…' : 'Export channel'} icon="download" onPress={start} disabled={!list || running} style={{ alignSelf: 'flex-start' }} />
      {list?.map((x) => (
        <View key={x.id} style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={fs.itemTitle}>Channel archive</Text>
            <Badge text={x.status} tone={x.status === 'ready' ? 'ok' : x.status === 'failed' ? 'err' : 'warn'} />
          </View>
          <Text style={fs.hint}>{`${x.size_bytes ? `${bytes(x.size_bytes)} · ` : ''}made ${date(x.created_at)}${x.expires_at ? ` · expires ${date(x.expires_at)}` : ''}${x.error ? ` · ${x.error}` : ''}`}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {x.status === 'ready' && !!x.download_url && <Button title="Save" icon="save-alt" small onPress={() => downloadAndShare(api, x.download_url, 'channel.tar', 'application/x-tar').catch((e) => toast(e.message))} />}
            {!!x.link && <Button title="Copy link" icon="link" small onPress={async () => (await Clipboard.setStringAsync(x.link), toast('Private link copied'))} />}
            <Button title="Delete" small kind="ghost" onPress={() => remove(x)} />
          </View>
        </View>
      ))}
      {list?.some((x) => x.link) && <Text style={fs.hint}>Anyone with the private link can download the archive until it expires, so only paste it on your new site.</Text>}
    </>
  );
}

function ImportPart() {
  const { api } = useSession();
  const [list, setList] = useState<any[] | null>(null);
  const [url, setUrl] = useState('');
  const [profile, setProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<number | null>(null);
  const load = useCallback(
    () =>
      api
        .get<{ imports: any[] }>('/me/channel-imports')
        .then((r) => setList(r.imports))
        .catch(() => setList([])),
    [api],
  );
  useEffect(() => {
    load();
  }, [load]);
  const running = list?.some((x) => RUNNING.includes(x.status));
  usePolled(load, running);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post('/me/channel-imports', body);
      toast('Import started');
      setUrl('');
      load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  // In pieces, like video uploads, so a big archive gets through proxies that cap a request's size.
  const upload = async () => {
    const file = await pickFile(['application/x-tar', 'application/octet-stream', '*/*']);
    if (!file) return;
    setBusy(true);
    try {
      const uploadId = await api.uploadPieces(file, 'archive', (sent, total) => setSending(Math.floor((sent / Math.max(1, total)) * 100))).promise;
      setSending(null);
      await run({ upload_id: uploadId, apply_profile: profile });
    } catch (e: any) {
      toast(e.message);
    } finally {
      setSending(null);
      setBusy(false);
    }
  };
  return (
    <>
      <Text style={[fs.label, { marginTop: 8 }]}>2. Import a channel here</Text>
      <Text style={fs.hint}>Paste the private link from the old site (the fastest way), or upload the archive. Your videos are processed again here.</Text>
      <FieldRow>
        <Input value={url} onChangeText={setUrl} placeholder="https://old.example/api/channel-exports/…" autoCapitalize="none" keyboardType="url" style={{ flex: 1, minWidth: 200 }} />
        <Button title="Import" disabled={busy || running || !url.trim()} onPress={() => run({ url: url.trim(), apply_profile: profile })} />
      </FieldRow>
      <Button title={sending === null ? 'Upload archive (.tar)' : `Uploading the archive ${sending}%…`} icon="file-upload" kind="ghost" disabled={busy || running} onPress={upload} style={{ alignSelf: 'flex-start' }} />
      <Toggle label="Also bring over the name, description, picture and links" value={profile} onChange={setProfile} />
      {list?.map((x) => (
        <ListItem
          key={x.id}
          title={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={fs.itemTitle}>{x.stats?.source?.handle || x.source_url || 'Uploaded archive'}</Text>
              <Badge text={`${x.status}${RUNNING.includes(x.status) && x.progress ? ` ${x.progress}%` : ''}`} tone={x.status === 'done' ? 'ok' : x.status === 'failed' ? 'err' : 'warn'} />
            </View>
          }
          sub={
            x.status === 'done' && x.stats
              ? `${x.stats.videos} videos, ${x.stats.comments} comments${x.stats.already_here ? `, ${x.stats.already_here} already here` : ''}${x.stats.skipped ? `, ${x.stats.skipped} missing from the archive` : ''}. ${x.stats.subscribers} subscribers on the old channel: they come along when you move it (step 3).`
              : x.error || date(x.created_at)
          }
        />
      ))}
    </>
  );
}

function MovePart() {
  const { api } = useSession();
  const [s, setS] = useState<any>(null);
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/me/move').then(setS).catch(() => {});
  }, [api]);
  if (!s) return null;
  const run = async (fn: () => Promise<any>, message?: string) => {
    setBusy(true);
    try {
      setS(await fn());
      if (message) toast(message);
      return true;
    } catch (e: any) {
      toast(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const total = s.followers.fediverse + s.followers.here + s.followers.network;
  return (
    <>
      <Text style={[fs.label, { marginTop: 8 }]}>3. Move</Text>
      {!s.enabled && <Notice tone="warn" icon="warning-amber">Moving needs ActivityPub and this site's Public URL. Ask an admin to turn them on.</Notice>}
      <Text style={[fs.itemTitle, { marginTop: 4 }]}>Moving here</Text>
      <Text style={fs.hint}>{`On the new site, add the old account first. That proves both are yours: the old site checks for it before it moves anyone. This account is ${s.handles.account}.`}</Text>
      <FieldRow>
        <Input value={alias} onChangeText={setAlias} placeholder="@you@old-site.example" autoCapitalize="none" editable={s.enabled} style={{ flex: 1, minWidth: 200 }} />
        <Button
          title="Add"
          disabled={busy || !alias.trim() || !s.enabled}
          onPress={() => run(() => api.post('/me/aliases', { handle: alias.trim() }), 'Old account added').then((ok) => ok && setAlias(''))}
        />
      </FieldRow>
      {s.aliases.map((a: any) => (
        <ListItem
          key={a.id}
          title={a.name || a.handle}
          sub={`${a.handle} · ${a.type === 'Group' ? 'channel' : 'account'}`}
          right={<Button title="Remove" small kind="ghost" disabled={busy} onPress={() => run(() => api.del('/me/aliases', { id: a.id }))} />}
        />
      ))}
      <Text style={[fs.itemTitle, { marginTop: 8 }]}>Moving away</Text>
      {s.moved ? (
        <>
          <Text style={{ color: colors.text }}>{`This channel moved to ${s.moved.handle} on ${date(s.moved.at)}. Its page points there, and new subscribers are sent there.`}</Text>
          <Button
            title="Undo the move"
            disabled={busy}
            onPress={async () =>
              (await confirm('Undo the move?', 'Stop pointing this channel at the new one. People who already moved stay with the new channel.', { confirmLabel: 'Undo' })) &&
              run(() => api.del('/me/move'), 'Move undone')
            }
            style={{ alignSelf: 'flex-start' }}
          />
        </>
      ) : (
        <>
          <Text style={fs.hint}>
            {`Sends your ${s.followers.here} subscribers here, ${s.followers.network} on other instances and ${s.followers.fediverse} on the fediverse to the new channel. Your videos here stay until you delete them.`}
          </Text>
          <Field label="New account">
            <Input value={target} onChangeText={setTarget} placeholder="@you@new-site.example" autoCapitalize="none" editable={s.enabled} />
          </Field>
          <Field label="Password">
            <Input value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" />
          </Field>
          <Button
            title="Move channel"
            kind="accent"
            disabled={busy || !s.enabled || !target.trim() || !password}
            onPress={async () => {
              if (!(await confirm(`Move this channel to ${target.trim()}?`, `Its ${total} subscribers and followers are sent to the new channel.`, { confirmLabel: 'Move', destructive: true }))) return;
              run(() => api.post('/me/move', { handle: target.trim(), password }), 'Moved. Subscribers are on their way.').then((ok) => ok && setPassword(''));
            }}
            style={{ alignSelf: 'flex-start' }}
          />
        </>
      )}
    </>
  );
}

function DeleteAccount({ initial }: { initial: number | null }) {
  const { api } = useSession();
  const [requested, setRequested] = useState<number | null>(initial);
  const [deletesAt, setDeletesAt] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<any>('/me/deletion')
      .then((r) => {
        setRequested(r.requested_at);
        setDeletesAt(r.deletes_at);
      })
      .catch(() => {});
  }, [api]);
  const request = async () => {
    if (!(await confirm('Delete your account?', 'This deletes your account and everything on it. You have 7 days to change your mind.', { confirmLabel: 'Delete', destructive: true }))) return;
    setBusy(true);
    try {
      const r = await api.post<any>('/me/deletion', { password });
      setRequested(r.requested_at);
      setDeletesAt(r.deletes_at);
      setPassword('');
      toast('Your account will be deleted');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      await api.del('/me/deletion');
      setRequested(null);
      setDeletesAt(null);
      toast('Deletion cancelled');
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Delete account" style={{ borderColor: 'rgba(255,107,107,0.35)' }}>
      {requested ? (
        <>
          <Text style={{ color: colors.text, lineHeight: 20 }}>
            {'Your account and all of your videos will be deleted on '}
            <Text style={{ fontWeight: '800' }}>{date(deletesAt || requested + 7 * 86400000)}</Text>
            . Other instances in the network are told to remove your comments and likes too.
          </Text>
          <Button title="Keep my account" onPress={cancel} style={{ alignSelf: 'flex-start' }} />
        </>
      ) : (
        <>
          <Text style={fs.hint}>Deletes your channel, videos, comments, likes and history after a 7-day grace period. Export your data first if you want a copy.</Text>
          <Field label="Password">
            <Input value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" />
          </Field>
          <Button title="Delete my account" kind="danger" disabled={busy || !password} onPress={request} style={{ alignSelf: 'flex-start' }} />
        </>
      )}
    </Section>
  );
}
