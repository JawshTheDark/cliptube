import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Badge, Input, ListItem, Section, s as fs } from './Form';
import { confirm } from './Prompt';
import { Text } from './Text';
import { Avatar, Button, IconButton, toast } from './ui';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Actor = { id: string; handle: string; name: string; icon_url: string | null; url?: string; type?: string; status?: 'pending' | 'accepted' | 'rejected' | null };

const STATUS: Record<string, ['warn' | 'ok' | 'err', string]> = {
  pending: ['warn', 'Waiting for them to accept'],
  accepted: ['ok', 'Following'],
  rejected: ['err', 'They declined'],
};

/**
 * Follow from the fediverse (the website's panel under Subscriptions): PeerTube channels and Mastodon accounts by
 * handle or link. Their new videos join your subscriptions. Hidden when the server has ActivityPub off.
 */
export function FediverseFollow() {
  const { api, site } = useSession();
  const on = !!(site as any)?.activitypub;
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState<Actor | null>(null);
  const [follows, setFollows] = useState<Actor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api
        .get<{ follows: Actor[] }>('/fediverse/follows')
        .then((r) => setFollows(r.follows))
        .catch(() => setFollows([])),
    [api],
  );
  useEffect(() => {
    if (on) load();
  }, [on, load]);
  if (!on) return null;

  const find = async () => {
    setBusy(true);
    setPreview(null);
    try {
      setPreview((await api.get<{ actor: Actor }>(`/fediverse/lookup?q=${encodeURIComponent(q.trim())}`)).actor);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const follow = async (handle: string) => {
    setBusy(true);
    try {
      await api.post('/fediverse/follow', { handle });
      toast('Follow request sent');
      setPreview(null);
      setQ('');
      load();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const unfollow = async (a: Actor) => {
    if (!(await confirm(`Stop following ${a.handle}?`, undefined, { confirmLabel: 'Unfollow', destructive: true }))) return;
    try {
      await api.del('/fediverse/follow', { actor: a.id });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };

  return (
    <Section title="Follow from the fediverse" hint="PeerTube channels and Mastodon accounts: their new videos show up in your subscriptions, and you can like and comment on them here.">
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Input value={q} onChangeText={setQ} placeholder="@channel@peertube.example or a link" autoCapitalize="none" autoCorrect={false} onSubmitEditing={find} style={{ flex: 1 }} accessibilityLabel="Handle or link" />
        <Button title="Look up" busy={busy} disabled={!q.trim()} onPress={find} />
      </View>
      {preview && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar uri={preview.icon_url} name={preview.name} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={fs.itemTitle}>{preview.name}</Text>
            <Text style={fs.hint}>{`${preview.handle} · ${preview.type === 'Group' ? 'Channel' : preview.type === 'Person' ? 'Account' : preview.type || ''}`}</Text>
          </View>
          {preview.status ? <Badge text={STATUS[preview.status]?.[1] || preview.status} tone={STATUS[preview.status]?.[0]} /> : <Button title="Follow" kind="accent" disabled={busy} onPress={() => follow(preview.id)} />}
        </View>
      )}
      {follows?.map((a) => (
        <ListItem
          key={a.id}
          left={<Avatar uri={a.icon_url} name={a.name} size={32} />}
          title={
            <Pressable onPress={() => a.url && Linking.openURL(a.url)} disabled={!a.url}>
              <Text style={[fs.itemTitle, { color: a.url ? colors.link : colors.text }]} numberOfLines={1}>
                {a.name}
              </Text>
            </Pressable>
          }
          sub={
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <Text style={fs.hint}>{a.handle}</Text>
              {!!a.status && <Badge text={STATUS[a.status]?.[1] || a.status} tone={STATUS[a.status]?.[0]} />}
            </View>
          }
          right={<IconButton name="close" label={`Unfollow ${a.handle}`} onPress={() => unfollow(a)} />}
        />
      ))}
    </Section>
  );
}
