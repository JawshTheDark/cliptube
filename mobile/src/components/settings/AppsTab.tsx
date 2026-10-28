import { useCallback, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Badge, Field, FieldRow, Input, ListItem, Notice, Section, Select, Toggle, s as fs } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Button, IconButton, Loading, toast } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const VISIBILITY: Record<string, string> = { unlisted: 'Unlisted', public: 'Public', private: 'Private' };
const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString() : '');

/** Settings → Apps: API keys for uploading from ShareX or scripts, and webhooks. */
export function AppsTab() {
  return (
    <>
      <ApiKeys />
      <Webhooks />
    </>
  );
}

/** A ShareX custom uploader (.sxcu) that sends recordings here with this key and copies the watch link. */
function shareXConfig(key: string, uploadUrl: string, siteName: string) {
  return JSON.stringify(
    {
      Version: '16.1.0',
      Name: siteName,
      DestinationType: 'FileUploader',
      RequestMethod: 'POST',
      RequestURL: uploadUrl,
      Headers: { Authorization: `Bearer ${key}` },
      Body: 'MultipartFormData',
      FileFormName: 'file',
      URL: '{json:url}',
      ErrorMessage: '{json:error}',
    },
    null,
    2,
  );
}

function ApiKeys() {
  const { api, site, server } = useSession();
  const [data, setData] = useState<any>(null);
  const [draft, setDraft] = useState({ name: '', visibility: 'unlisted', publish: true });
  const [fresh, setFresh] = useState<string | null>(null); // shown this once
  const load = useCallback(() => api.get<any>('/me/api-keys').then(setData).catch((e) => toast(e.message)), [api]);
  useEffect(() => {
    load();
  }, [load]);
  const create = async () => {
    try {
      const r = await api.post<{ key: string }>('/me/api-keys', { ...draft, name: draft.name || 'ShareX' });
      setFresh(r.key);
      setDraft({ ...draft, name: '' });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const remove = async (k: any) => {
    if (!(await confirm(`Delete the key "${k.name}"?`, 'Anything using it stops uploading.', { confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await api.del(`/me/api-keys/${k.id}`);
      toast('Key deleted');
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const uploadUrl = data?.upload_url || `${server}/api/videos`;
  return (
    <Section
      title="API keys"
      hint="Upload from ShareX, a script or any tool that can send a file with a header. A key can only upload videos, as you, and the answer has the video's link. Each key sets what its uploads are when the upload doesn't say."
    >
      <FieldRow>
        <Field label="Name" style={{ flex: 2, minWidth: 160 }}>
          <Input value={draft.name} maxLength={60} placeholder="ShareX" onChangeText={(t) => setDraft({ ...draft, name: t })} />
        </Field>
        <Field label="Uploads are" style={{ flex: 1, minWidth: 140 }}>
          <Select value={draft.visibility} options={Object.entries(VISIBILITY).map(([value, label]) => ({ value, label }))} onChange={(v) => setDraft({ ...draft, visibility: v })} />
        </Field>
      </FieldRow>
      <Toggle label="Publish right away" hint="Off: they wait as drafts until you save their details." value={draft.publish} onChange={(v) => setDraft({ ...draft, publish: v })} />
      <Button title="Make a key" kind="accent" icon="vpn-key" onPress={create} style={{ alignSelf: 'flex-start' }} />
      {!!fresh && (
        <Notice icon="vpn-key">
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.text }}>
              <Text style={{ fontWeight: '800' }}>Your new key. </Text>
              It is shown only now: copy it or share the ShareX config before you leave this screen.
            </Text>
            <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 12.5 }} selectable>
              {fresh}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button title="Copy" small onPress={async () => (await Clipboard.setStringAsync(fresh), toast('Copied'))} />
              <Button title="ShareX config" icon="share" small kind="accent" onPress={() => Share.share({ message: shareXConfig(fresh, uploadUrl, site?.site_name || 'OurTube') }).catch(() => {})} />
            </View>
            <Text style={fs.hint}>Anything else can send a POST with the file as file (plus title, description, visibility or tags if you like):</Text>
            <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 11.5 }} selectable>{`curl -H "Authorization: Bearer ${fresh}" -F "file=@video.mp4" ${uploadUrl}`}</Text>
          </View>
        </Notice>
      )}
      {data === null ? (
        <Loading />
      ) : data.keys.length === 0 ? (
        <Text style={fs.hint}>No keys yet.</Text>
      ) : (
        data.keys.map((k: any) => (
          <ListItem
            key={k.id}
            title={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={fs.itemTitle}>{k.name}</Text>
                <Text style={{ color: colors.text2, fontFamily: 'monospace' }}>{`${k.prefix}…`}</Text>
                <Badge text={VISIBILITY[k.visibility] || k.visibility} />
                {!k.publish && <Badge text="drafts" />}
              </View>
            }
            sub={`Made ${date(k.created_at)} · ${k.last_used_at ? `last used ${date(k.last_used_at)}` : 'not used yet'}`}
            right={<IconButton name="delete-outline" label="Delete key" onPress={() => remove(k)} color={colors.text2} />}
          />
        ))
      )}
    </Section>
  );
}

/** Your webhooks: your new videos and live streams (an admin's can cover the whole server), sent to bots, bridges or chat. */
function Webhooks() {
  const { api } = useSession();
  const [data, setData] = useState<any>(null);
  const [draft, setDraft] = useState({ url: '', format: 'json', secret: '', events: ['video.published', 'live.started'], scope: 'mine', include_network: false });
  const siteWide = !!data?.scopes?.site;
  const load = useCallback(() => api.get<any>('/me/webhooks').then(setData).catch((e) => toast(e.message)), [api]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (fn: () => Promise<any>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const create = () =>
    act(async () => {
      await api.post('/me/webhooks', draft);
      setDraft({ ...draft, url: '', secret: '' });
    }, 'Webhook added');
  const test = (h: any) =>
    act(async () => {
      const r = await api.post<any>(`/me/webhooks/${h.id}/test`);
      toast(r.ok ? `Test sent: the other end answered ${r.status}` : `Test failed: ${r.error}`);
    });
  const toggleEvent = (ev: string) => setDraft((d) => ({ ...d, events: d.events.includes(ev) ? d.events.filter((x) => x !== ev) : [...d.events, ev] }));
  return (
    <Section
      title="Webhooks"
      hint={`Tell a bot, a bridge or a chat channel when you publish a video or go live. JSON sends the whole event; Discord and Slack send a message with the link. With a secret, each delivery is signed in X-OurTube-Signature (also sent as X-ClipTube-Signature).${siteWide ? ' As an admin, you can also send everything published on this server, and new videos from the rest of the network.' : ''}`}
    >
      <Field label="Address">
        <Input value={draft.url} placeholder="https://bot.example.com/ourtube" autoCapitalize="none" keyboardType="url" onChangeText={(t) => setDraft({ ...draft, url: t })} />
      </Field>
      <FieldRow>
        <Field label="Format" style={{ flex: 1, minWidth: 140 }}>
          <Select
            value={draft.format}
            options={Object.entries((data?.formats || { json: 'JSON' }) as Record<string, string>).map(([value, label]) => ({ value, label: label.split(':')[0] }))}
            onChange={(v) => setDraft({ ...draft, format: v })}
          />
        </Field>
        <Field label="Secret (optional)" style={{ flex: 1, minWidth: 140 }}>
          <Input value={draft.secret} maxLength={200} autoComplete="off" autoCapitalize="none" onChangeText={(t) => setDraft({ ...draft, secret: t })} />
        </Field>
      </FieldRow>
      {siteWide && (
        <>
          <Field label="Sends">
            <Select value={draft.scope} options={Object.entries(data.scopes as Record<string, string>).map(([value, label]) => ({ value, label }))} onChange={(v) => setDraft({ ...draft, scope: v })} />
          </Field>
          {draft.scope === 'site' && (
            <Toggle label="Also new videos from other servers in the network" value={draft.include_network} onChange={(v) => setDraft({ ...draft, include_network: v })} />
          )}
        </>
      )}
      {Object.entries((data?.events || {}) as Record<string, string>).map(([ev, label]) => (
        <Toggle key={ev} label={label} value={draft.events.includes(ev)} onChange={() => toggleEvent(ev)} />
      ))}
      <Button title="Add" kind="accent" disabled={!draft.events.length || !draft.url.trim()} onPress={create} style={{ alignSelf: 'flex-start' }} />
      {data === null ? (
        <Loading />
      ) : data.webhooks.length === 0 ? (
        <Text style={fs.hint}>No webhooks yet.</Text>
      ) : (
        data.webhooks.map((h: any) => (
          <View key={h.id} style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.hairline }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 12.5, flexShrink: 1 }}>{h.url}</Text>
              <Badge text={h.format} />
              {!h.enabled && <Badge text="off" />}
              {h.has_secret && <Badge text="signed" />}
              {h.scope === 'site' && <Badge text={h.include_network ? 'whole server + network' : 'whole server'} />}
            </View>
            <Text style={fs.hint}>
              {`${h.events.join(', ')}${h.last_attempt_at ? (h.last_error ? ` · failed ${date(h.last_attempt_at)}: ${h.last_error}` : ` · delivered ${date(h.last_attempt_at)}`) : ' · nothing sent yet'}`}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button title="Test" small onPress={() => test(h)} />
              <Button title={h.enabled ? 'Turn off' : 'Turn on'} small onPress={() => act(() => api.patch(`/me/webhooks/${h.id}`, { enabled: !h.enabled }))} />
              <Button
                title="Delete"
                small
                kind="ghost"
                onPress={async () => (await confirm(`Delete the webhook to ${h.url}?`, undefined, { confirmLabel: 'Delete', destructive: true })) && act(() => api.del(`/me/webhooks/${h.id}`), 'Webhook deleted')}
              />
            </View>
          </View>
        ))
      )}
    </Section>
  );
}
