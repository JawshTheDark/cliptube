import { useEffect, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { Badge, Field, FieldRow, Input, Notice, Section, Select, Toggle, s as fs } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Avatar, Button, Chip, LiveBadge, toast } from '@/components/ui';
import { GameField } from '@/components/VideoForm';
import { pickFile } from '@/lib/pick';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Patch = (body: Record<string, unknown>, message?: string) => Promise<void>;

/** Settings → Channel: picture, name and description, support links, live streaming, comments, linked accounts. */
export function ChannelTab({ s, patch, setS }: { s: any; patch: Patch; setS: (f: (x: any) => any) => void }) {
  return (
    <>
      <ProfileSettings />
      <SupportLinks initial={s.support_links || []} />
      <LiveSettings />
      <CommentSettings s={s} patch={patch} setS={setS} />
      <Section title="Linked accounts" hint="Your accounts on other OurTube servers or Mastodon, shown as one person on every server.">
        <Button title="Manage linked accounts" icon="link" onPress={() => router.push('/links')} style={{ alignSelf: 'flex-start' }} />
      </Section>
    </>
  );
}

function ProfileSettings() {
  const { api, user, refresh } = useSession();
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [bio, setBio] = useState((user as any)?.bio || '');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const save = async () => {
    if (!displayName.trim()) return toast('Give your channel a name');
    setBusy(true);
    try {
      await api.patch('/me', { display_name: displayName, bio });
      await refresh();
      toast('Profile saved');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const changePicture = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    setBusy(true);
    try {
      await api.sendFile('/me/avatar', 'avatar', file);
      await refresh();
      toast('Profile picture updated');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const removePicture = async () => {
    try {
      await api.del('/me/avatar');
      await refresh();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Channel">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar uri={api.abs(user.avatar_url)} name={user.display_name} size={80} />
        <View style={{ gap: 8 }}>
          <Button title="Change picture" small onPress={changePicture} disabled={busy} />
          {!!user.avatar_url && <Button title="Remove" small kind="ghost" onPress={removePicture} />}
        </View>
      </View>
      <Field label="Display name">
        <Input value={displayName} maxLength={50} onChangeText={setDisplayName} />
      </Field>
      <Field
        label="Username"
        hint={
          <Text style={fs.hint}>
            {'Your channel lives at '}
            <Text style={{ color: colors.link }} onPress={() => router.push(`/c/${encodeURIComponent(user.username)}` as any)}>{`/c/${user.username}`}</Text>
          </Text>
        }
      >
        <Input value={`@${user.username}`} editable={false} style={{ opacity: 0.6 }} />
      </Field>
      <Field label="Channel description">
        <Input multiline value={bio} maxLength={1000} onChangeText={setBio} placeholder="What do you post?" />
      </Field>
      <Button title="Save" kind="accent" onPress={save} busy={busy} style={{ alignSelf: 'flex-start' }} />
    </Section>
  );
}

function SupportLinks({ initial }: { initial: { label: string; url: string }[] }) {
  const { api } = useSession();
  const blank = { label: '', url: '' };
  const [links, setLinks] = useState(() => [...initial, ...(initial.length < 5 ? [blank] : [])]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<typeof blank>) => setLinks((list) => list.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const save = async () => {
    setBusy(true);
    try {
      await api.patch('/me', { support_links: links.filter((l) => l.url.trim()) });
      toast('Support links saved');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Support links" hint="Tip jars, memberships or merch. They show on your channel and under your videos. Up to five https:// links.">
      {links.map((l, i) => (
        <FieldRow key={i}>
          <Input value={l.label} maxLength={40} placeholder="Label, like Ko-fi" onChangeText={(t) => set(i, { label: t })} style={{ flex: 1, minWidth: 120 }} />
          <Input value={l.url} placeholder="https://" autoCapitalize="none" keyboardType="url" onChangeText={(t) => set(i, { url: t })} style={{ flex: 2, minWidth: 180 }} />
        </FieldRow>
      ))}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {links.length < 5 && <Button title="Add another" kind="ghost" onPress={() => setLinks((x) => [...x, blank])} />}
        <Button title="Save" kind="accent" onPress={save} busy={busy} />
      </View>
    </Section>
  );
}

/** The stream key and server for OBS, and the stream's title, game and who can watch. */
function LiveSettings() {
  const { api, user } = useSession();
  const [s, setS] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [showKey, setShowKey] = useState(false);
  const load = () =>
    api
      .get<any>('/live/me')
      .then((r) => {
        setS(r);
        setForm(r.settings);
      })
      .catch(() => setS(null));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  if (!s || !user) return null;
  const copy = async (text: string, what: string) => {
    await Clipboard.setStringAsync(text);
    toast(`${what} copied`);
  };
  const save = async () => {
    try {
      await api.patch('/live/me', form);
      toast('Saved');
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const newKey = async () => {
    if (!(await confirm('Make a new stream key?', 'The old one stops working, so update OBS afterwards.', { confirmLabel: 'New key' }))) return;
    try {
      await api.post('/live/me/key');
      toast('New stream key made');
      setShowKey(true);
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Live streaming">
      {!s.enabled ? (
        <Text style={fs.hint}>Live streaming isn't set up on this server. An admin can turn it on (see the wiki's Live Streaming page).</Text>
      ) : (
        <>
          {s.stream?.status === 'live' ? (
            <Notice icon="sensors">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <LiveBadge />
                <Text style={{ color: colors.text }}>
                  {"You're live: "}
                  <Text style={{ color: colors.link }} onPress={() => router.push(`/live/${encodeURIComponent(user.username)}` as any)}>
                    {s.stream.title}
                  </Text>
                </Text>
              </View>
            </Notice>
          ) : (
            <Text style={fs.hint}>
              {"Stream from OBS (or any app that streams over RTMP): in OBS, Settings, Stream, pick Custom and paste these two. Your stream shows at "}
              <Text style={{ color: colors.link }} onPress={() => router.push(`/live/${encodeURIComponent(user.username)}` as any)}>{`/live/${user.username}`}</Text>
              , and your subscribers hear about it.
            </Text>
          )}
          <Field label="Server">
            <FieldRow>
              <Text style={[fs.input, { flex: 1, minWidth: 180, fontFamily: 'monospace', fontSize: 13 }]} selectable>
                {s.server_url}
              </Text>
              <Button title="Copy" small onPress={() => copy(s.server_url, 'Server')} />
            </FieldRow>
          </Field>
          <Field label="Stream key" hint="Anyone with the key can stream as you. Keep it secret, and make a new one if it gets out.">
            <Text style={[fs.input, { fontFamily: 'monospace', fontSize: 13 }]} selectable={showKey}>
              {showKey ? s.stream_key : '•'.repeat(24)}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button title={showKey ? 'Hide' : 'Show'} small onPress={() => setShowKey((x) => !x)} />
              <Button title="Copy" small onPress={() => copy(s.stream_key, 'Stream key')} />
              <Button title="New key" small onPress={newKey} />
            </View>
          </Field>
          {!!s.srt_url && (
            <Field label="SRT (optional)">
              <FieldRow>
                <Text style={[fs.input, { flex: 1, minWidth: 180, fontFamily: 'monospace', fontSize: 13 }]}>{showKey ? s.srt_url : 'srt://…'}</Text>
                <Button title="Copy" small onPress={() => copy(s.srt_url, 'SRT address')} />
              </FieldRow>
            </Field>
          )}
          <Field label="Title">
            <Input value={form.title} onChangeText={(t) => setForm({ ...form, title: t })} placeholder={`${user.display_name} is live`} maxLength={120} />
          </Field>
          <Field label="Description">
            <Input multiline value={form.description} onChangeText={(t) => setForm({ ...form, description: t })} />
          </Field>
          <Field label="Game">
            <GameField value={form.game || ''} onChange={(game) => setForm({ ...form, game })} />
          </Field>
          <Field label="Who can watch">
            <Select
              value={form.visibility}
              options={[
                { value: 'public', label: 'Public', hint: 'On Home and the network, and subscribers are told' },
                { value: 'unlisted', label: 'Unlisted', hint: 'Only people with the link' },
              ]}
              onChange={(v) => setForm({ ...form, visibility: v })}
            />
          </Field>
          <Toggle label="Keep each stream as a draft video when it ends" value={!!form.save_recording} onChange={(v) => setForm({ ...form, save_recording: v })} />
          <Button title="Save" kind="accent" onPress={save} style={{ alignSelf: 'flex-start' }} />
          <Text style={fs.hint}>Changes here reach a stream that is on right now too.</Text>
        </>
      )}
    </Section>
  );
}

function CommentSettings({ s, patch, setS }: { s: any; patch: Patch; setS: (f: (x: any) => any) => void }) {
  const { api } = useSession();
  const [word, setWord] = useState('');
  const [action, setAction] = useState<'hold' | 'reject'>('hold');
  const filters: { word: string; action: string }[] = s.comment_filters || [];
  const saveFilters = async (list: { word: string; action: string }[]) => {
    try {
      const r = await api.put<{ comment_filters: any[] }>('/me/comment-filters', { filters: list });
      setS((x) => ({ ...x, comment_filters: r.comment_filters }));
    } catch (e: any) {
      toast(e.message);
    }
  };
  const add = () => {
    const w = word.trim().toLowerCase();
    if (!w) return;
    saveFilters([...filters.filter((f) => f.word !== w), { word: w, action }]);
    setWord('');
  };
  return (
    <Section title="Comments on your videos">
      <Field
        label="New comments"
        hint={
          <Text style={fs.hint}>
            {'Each video can override this when you edit it. Held comments wait in '}
            <Text style={{ color: colors.link }} onPress={() => router.push('/studio/comments' as any)}>
              Studio, Comments
            </Text>
            .
          </Text>
        }
      >
        <Select
          value={s.comment_mode}
          options={[
            { value: 'open', label: 'Publish right away', hint: 'Spam checks still apply' },
            { value: 'hold_all', label: 'Hold every comment for my review' },
          ]}
          onChange={(v) => patch({ comment_mode: v }, 'Saved')}
        />
      </Field>
      <Text style={fs.label}>Blocked words</Text>
      <Text style={fs.hint}>Comments containing these words or phrases are held for review or rejected outright.</Text>
      <FieldRow>
        <Input value={word} maxLength={60} placeholder="Word or phrase" onChangeText={setWord} onSubmitEditing={add} style={{ flex: 2, minWidth: 160 }} />
        <View style={{ flex: 1, minWidth: 150 }}>
          <Select
            value={action}
            options={[
              { value: 'hold', label: 'Hold for review' },
              { value: 'reject', label: 'Reject' },
            ]}
            onChange={setAction}
          />
        </View>
        <Button title="Add" onPress={add} />
      </FieldRow>
      {filters.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {filters.map((f) => (
            <View key={f.word} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Chip label={`${f.word}  ×`} onPress={() => saveFilters(filters.filter((x) => x.word !== f.word))} />
              {f.action === 'reject' && <Badge text="rejected" tone="err" />}
            </View>
          ))}
        </View>
      )}
    </Section>
  );
}

