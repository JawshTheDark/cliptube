import { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { Image } from 'expo-image';
import { Field, FieldRow, Input, ListItem, Section, Select, s as fs, Badge } from './Form';
import { confirm } from './Prompt';
import { Text } from './Text';
import { TimeField } from './TimeField';
import { Button, toast } from './ui';
import type { Api } from '@/lib/api';
import { pickFile } from '@/lib/pick';
import { seekCurrent } from '@/lib/playback';
import { precise } from '@/lib/time';
import { colors } from '@/lib/theme';
import type { Caption, Segment, Video } from '@/lib/types';

export const SEGMENT_KINDS: [string, string][] = [
  ['sponsor', 'Sponsor'],
  ['intro', 'Intro'],
  ['outro', 'Outro'],
  ['recap', 'Recap'],
  ['selfpromo', 'Self-promotion'],
];

/** A caption file from the phone: WebVTT or SubRip (phones rarely know their types, so any file is offered). */
export async function pickCaptionFile() {
  const f = await pickFile(['text/vtt', 'application/x-subrip', 'text/plain', '*/*']);
  if (f && !/\.(vtt|srt)$/i.test(f.name)) {
    toast('Pick a .vtt or .srt file');
    return null;
  }
  return f;
}

/** The uploader's captions: what's published, suggestions waiting, and adding a file. */
export function CaptionsManager({ api, video }: { api: Api; video: Video }) {
  const [list, setList] = useState<Caption[] | null>(null);
  const [lang, setLang] = useState('en');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/videos/${encodeURIComponent(video.id)}/captions`;
  const load = useCallback(
    () =>
      api
        .get<{ captions: Caption[] }>(base)
        .then((r) => setList(r.captions))
        .catch(() => setList([])),
    [api, base],
  );
  useEffect(() => {
    load();
  }, [load]);
  const add = async () => {
    const file = await pickCaptionFile();
    if (!file) return;
    setBusy(true);
    try {
      await api.sendFile(base, 'file', file, { lang: lang.trim(), label: label.trim() });
      setLabel('');
      load();
      toast('Captions added');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (c: Caption, method: 'PATCH' | 'DELETE', body?: object) => {
    try {
      await api.req(`${base}/${c.id}`, { method, body });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Captions">
      {list?.length === 0 && <Text style={fs.hint}>No captions yet.</Text>}
      {list?.map((c) => (
        <ListItem
          key={c.id}
          title={
            <Text style={fs.itemTitle}>
              {c.label} <Text style={fs.hint}>({c.lang})</Text>
            </Text>
          }
          sub={c.status === 'pending' ? <Badge text={`Suggested${c.submitted_by ? ` by @${c.submitted_by}` : ''}`} tone="warn" /> : undefined}
          right={
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Button title="View" small kind="ghost" onPress={() => Linking.openURL(api.abs(c.url)!)} />
              {c.status === 'pending' && <Button title="Publish" small kind="accent" onPress={() => act(c, 'PATCH', { status: 'published' })} />}
              <Button
                title=""
                icon="delete-outline"
                small
                onPress={async () => (await confirm(`Delete the ${c.label} captions?`, undefined, { confirmLabel: 'Delete', destructive: true })) && act(c, 'DELETE')}
              />
            </View>
          }
        />
      ))}
      <FieldRow>
        <Field label="Language" style={{ flexBasis: 100, flexGrow: 1 }}>
          <Input value={lang} onChangeText={setLang} autoCapitalize="none" placeholder="en, es, pt-BR" />
        </Field>
        <Field label="Name" style={{ flexBasis: 160, flexGrow: 2 }}>
          <Input value={label} onChangeText={setLabel} maxLength={40} placeholder="English" />
        </Field>
      </FieldRow>
      <Button title="Add a WebVTT or SRT file" icon="closed-caption" busy={busy} disabled={!lang.trim()} onPress={add} style={{ alignSelf: 'flex-start' }} />
    </Section>
  );
}

/** The uploader's skippable parts: marked ones, suggestions to accept, and marking a new one. */
export function SegmentsManager({ api, video }: { api: Api; video: Video }) {
  const [list, setList] = useState<Segment[] | null>(null);
  const [kind, setKind] = useState('intro');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(video.duration || 0, 10));
  const base = `/videos/${encodeURIComponent(video.id)}/segments`;
  const load = useCallback(
    () =>
      api
        .get<{ segments: Segment[] }>(base)
        .then((r) => setList(r.segments))
        .catch(() => setList([])),
    [api, base],
  );
  useEffect(() => {
    load();
  }, [load]);
  const clamp = (x: number) => Math.max(0, Math.min(video.duration || 0, Math.round(x * 10) / 10));
  const add = async () => {
    try {
      await api.post(base, { kind, start, end });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const act = async (sg: Segment, method: 'PATCH' | 'DELETE', body?: object) => {
    try {
      await api.req(`${base}/${sg.id}`, { method, body });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Skippable parts" hint="Mark sponsor reads, intros, outros and recaps. Each viewer chooses whether to skip them automatically, get a Skip button, or see them.">
      {list?.map((sg) => (
        <ListItem
          key={sg.id}
          title={sg.label}
          sub={
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={fs.hint}>{`${precise(sg.start)} – ${precise(sg.end)}`}</Text>
              {sg.status === 'pending' && <Badge text="Suggested" tone="warn" />}
            </View>
          }
          right={
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Button title="Play" small kind="ghost" onPress={() => seekCurrent(sg.start)} />
              {sg.status === 'pending' && <Button title="Accept" small kind="accent" onPress={() => act(sg, 'PATCH', { status: 'published' })} />}
              <Button title="" icon="delete-outline" small onPress={() => act(sg, 'DELETE')} />
            </View>
          }
        />
      ))}
      <Field label="Kind">
        <Select value={kind} options={SEGMENT_KINDS.map(([value, label]) => ({ value, label }))} onChange={setKind} />
      </Field>
      <FieldRow>
        <TimeField label="Start" value={start} onChange={(x) => setStart(clamp(x))} />
        <TimeField label="End" value={end} onChange={(x) => setEnd(clamp(x))} />
      </FieldRow>
      <Button title="Add part" disabled={end - start < 1} onPress={add} style={{ alignSelf: 'flex-start' }} />
    </Section>
  );
}

type Suggestions = {
  titles: { id: string; title: string; votes: number; voted?: boolean }[];
  thumbnails: { id: string; url: string; votes: number; voted?: boolean }[];
  can_adopt?: boolean;
};

/** Titles and thumbnails viewers suggested: use one as your own, or remove it. Hidden when there are none. */
export function SuggestionsManager({ api, video, onChanged }: { api: Api; video: Video; onChanged?: () => void }) {
  const [data, setData] = useState<Suggestions | null>(null);
  const load = useCallback(
    () =>
      api
        .get<Suggestions>(`/videos/${encodeURIComponent(video.id)}/suggestions`)
        .then(setData)
        .catch(() => {}),
    [api, video.id],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!data || (!data.titles.length && !data.thumbnails.length)) return null;
  const act = async (url: string, method: 'POST' | 'DELETE', msg?: string) => {
    try {
      setData(await api.req<Suggestions>(url, { method }));
      if (msg) toast(msg);
      onChanged?.();
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section title="Community suggestions" hint="Titles and thumbnails viewers suggested. Viewers who opt in see the most-voted one; you can use one as your own.">
      {data.titles.map((sg) => (
        <ListItem
          key={sg.id}
          title={sg.title}
          sub={`${sg.votes} vote${sg.votes === 1 ? '' : 's'}`}
          right={
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Button title="Use this" small onPress={() => act(`/suggestions/titles/${sg.id}/adopt`, 'POST', 'Title updated')} />
              <Button title="" icon="delete-outline" small onPress={() => act(`/suggestions/titles/${sg.id}`, 'DELETE')} />
            </View>
          }
        />
      ))}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {data.thumbnails.map((sg) => (
          <View key={sg.id} style={{ width: 200, gap: 6 }}>
            <Image source={{ uri: api.abs(sg.url)! }} style={{ width: 200, aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: colors.surface2 }} contentFit="cover" />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[fs.hint, { flex: 1 }]}>{`${sg.votes} vote${sg.votes === 1 ? '' : 's'}`}</Text>
              <Button title="Use this" small onPress={() => act(`/suggestions/thumbnails/${sg.id}/adopt`, 'POST', 'Thumbnail updated')} />
              <Button title="" icon="delete-outline" small onPress={() => act(`/suggestions/thumbnails/${sg.id}`, 'DELETE')} />
            </View>
          </View>
        ))}
      </View>
    </Section>
  );
}
