import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Field, FieldRow, Input, Notice, Select, Toggle, s as fs } from '@/components/Form';
import { Heading, Text } from '@/components/Text';
import { TimeField } from '@/components/TimeField';
import { pickCaptionFile, SEGMENT_KINDS } from '@/components/VideoManage';
import { Button, Chip, IconButton, Loading, toast } from '@/components/ui';
import type { Api } from '@/lib/api';
import { downloadAndShare } from '@/lib/download';
import { bytes } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { currentTime, playRange } from '@/lib/playback';
import { useLinkedApi } from '@/lib/scope';
import { precise } from '@/lib/time';
import { colors } from '@/lib/theme';
import type { Video, Visibility } from '@/lib/types';

type Tool = 'clip' | 'segment' | 'captions' | 'suggest';
const TITLES: Record<Tool, string> = { clip: 'Clip a moment', segment: 'Mark a skippable part', captions: 'Add captions', suggest: 'Better title or thumbnail' };

/**
 * The website's watch-page dialogs (clip, mark a skippable part, add captions, suggest a title or thumbnail) as a
 * sheet that leaves the video in view: under it on a phone held upright, beside it on a wide screen. Now buttons
 * and Preview work on the video underneath.
 */
export default function WatchTools() {
  const p = useLocalSearchParams<{ tool: Tool; id: string; server?: string }>();
  const { api } = useLinkedApi(p.server);
  const layout = useLayout();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((k) => (k.isVisible ? k.height : 0));
  const [video, setVideo] = useState<Video | null>(null);
  useEffect(() => {
    api
      .get<{ video: Video }>(`/videos/${encodeURIComponent(p.id)}`)
      .then((r) => setVideo(r.video))
      .catch((e) => {
        toast(e.message);
        router.back();
      });
  }, [api, p.id]);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const tool: Tool = TITLES[p.tool] ? p.tool : 'clip';
  const side = layout.wide;
  const sheetStyle = side
    ? [s.side, { width: layout.width - layout.leftPane, paddingTop: insets.top, paddingBottom: keyboard }]
    : [s.sheet, { height: Math.min(Math.round(layout.height * 0.62), layout.height - keyboard - insets.top - 48), marginBottom: keyboard }];
  return (
    <View style={{ flex: 1, flexDirection: side ? 'row' : 'column' }}>
      <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close" />
      <View style={sheetStyle}>
        {!side && <View style={s.grip} />}
        <View style={s.head}>
          <Heading style={s.title}>{TITLES[tool]}</Heading>
          <IconButton name="close" label="Close" onPress={close} />
        </View>
        {!video ? (
          <Loading />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 12, paddingBottom: 24 + insets.bottom }} keyboardShouldPersistTaps="handled">
            {tool === 'clip' && <ClipPanel api={api} video={video} />}
            {tool === 'segment' && <SegmentPanel api={api} video={video} onDone={close} />}
            {tool === 'captions' && <CaptionPanel api={api} video={video} onDone={close} />}
            {tool === 'suggest' && <SuggestPanel api={api} video={video} />}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const LIMITS = { clip: 600, gif: 15, mp4: 60 };
const MINIMUM = { clip: 1, gif: 0.5, mp4: 0.5 };

/** The `len` seconds that end at `t` (or the first `len` seconds when `t` is near the start). */
function rangeBefore(t: number, length: number, len = 30) {
  const end = t > 1 ? Math.min(length, t) : Math.min(length, len);
  return { start: Math.max(0, end - len), end };
}

type Job = { id: string; format: 'gif' | 'mp4'; status: string; progress?: number; error?: string; size_bytes?: number; download_url?: string };

/** Clip a moment: a new video from a range, or the range as a GIF or a short MP4 to download. */
function ClipPanel({ api, video }: { api: Api; video: Video }) {
  const length = video.duration || 0;
  const now = () => currentTime() ?? 0;
  const canClip = !!video.can_clip;
  const [tab, setTab] = useState<'clip' | 'gif' | 'mp4'>(canClip ? 'clip' : 'gif');
  const [range, setRange] = useState(() => rangeBefore(now(), length));
  const [title, setTitle] = useState(`${video.title} (clip)`.slice(0, 120));
  const [visibility, setVisibility] = useState<Visibility>(video.visibility === 'private' ? 'private' : 'public');
  const [mode, setMode] = useState<'exact' | 'fast'>('exact');
  const [width, setWidth] = useState('480');
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Video | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed') return;
    const t = setTimeout(async () => {
      try {
        setJob((await api.get<{ export: Job }>(`/exports/${job.id}`)).export);
      } catch (e: any) {
        setJob((j) => (j ? { ...j, status: 'failed', error: e.message } : j));
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [api, job]);

  const clamp = (t: number) => Math.max(0, Math.min(length, Math.round(t * 100) / 100));
  const len = range.end - range.start;
  const tooLong = len > LIMITS[tab] + 0.01;
  const tooShort = len < MINIMUM[tab];
  const exporting = !!job && job.status !== 'ready' && job.status !== 'failed';
  const switchTab = (t: typeof tab) => {
    setTab(t);
    setJob(null);
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (tab === 'clip') {
        const r = await api.post<{ video: Video }>(`/videos/${encodeURIComponent(video.id)}/clip`, { start: range.start, end: range.end, title, visibility, mode });
        setMade(r.video);
      } else {
        const r = await api.post<{ export: Job }>(`/videos/${encodeURIComponent(video.id)}/exports`, { format: tab, start: range.start, end: range.end, width: Number(width), muted });
        setJob(r.export);
      }
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!job?.download_url) return;
    toast('Downloading…');
    try {
      await downloadAndShare(api, job.download_url, `${video.title.slice(0, 60)}.${job.format}`, job.format === 'gif' ? 'image/gif' : 'video/mp4');
    } catch (e: any) {
      toast(e.message);
    }
  };

  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {canClip && <Chip label="New video" active={tab === 'clip'} onPress={() => switchTab('clip')} />}
        <Chip label="GIF" active={tab === 'gif'} onPress={() => switchTab('gif')} />
        <Chip label="MP4 download" active={tab === 'mp4'} onPress={() => switchTab('mp4')} />
      </View>
      {!canClip && <Text style={fs.hint}>The uploader hasn't allowed clips of this video, but you can export a GIF or a short MP4.</Text>}
      <FieldRow>
        <TimeField label="Start" value={range.start} onChange={(t) => setRange((r) => ({ ...r, start: clamp(t) }))} />
        <TimeField label="End" value={range.end} onChange={(t) => setRange((r) => ({ ...r, end: clamp(t) }))} />
      </FieldRow>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: tooLong || tooShort ? colors.err : colors.text2, fontVariant: ['tabular-nums'] }}>{`${precise(Math.max(0, len))} long`}</Text>
        {[10, 30, 60].map((sec) => (
          <Chip key={sec} label={`Last ${sec}s`} onPress={() => setRange(rangeBefore(now(), length, sec))} />
        ))}
        <Button title="Preview" icon="play-arrow" small onPress={() => playRange(range.start, range.end)} />
      </View>
      {tooLong && <Text style={{ color: colors.err }}>{`${tab === 'clip' ? 'Clips' : `${tab.toUpperCase()} exports`} can be up to ${LIMITS[tab] >= 60 ? `${LIMITS[tab] / 60} min` : `${LIMITS[tab]} s`} long.`}</Text>}
      {tooShort && <Text style={{ color: colors.err }}>{`Pick at least ${MINIMUM[tab]} s.`}</Text>}

      {tab === 'clip' &&
        (made ? (
          <Notice icon="check-circle" tone="ok">
            <Text style={{ color: colors.text, lineHeight: 20 }}>Your clip is being made. It shows up in your Studio and plays as soon as it's ready.</Text>
            <Button title="Open clip" kind="accent" small onPress={() => router.replace(`/watch/${encodeURIComponent(made.id)}`)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
          </Notice>
        ) : (
          <>
            <Field label="Title">
              <Input value={title} maxLength={120} onChangeText={setTitle} />
            </Field>
            <FieldRow>
              <Field label="Visibility" style={{ flexBasis: 160, flexGrow: 1 }}>
                <Select
                  value={visibility}
                  options={[
                    { value: 'public', label: 'Public' },
                    { value: 'unlisted', label: 'Unlisted' },
                    { value: 'private', label: 'Private' },
                  ]}
                  onChange={setVisibility}
                />
              </Field>
              <Field label="Cut" style={{ flexBasis: 160, flexGrow: 1 }}>
                <Select
                  value={mode}
                  options={[
                    { value: 'exact', label: 'Exact', hint: 'Re-encodes if needed' },
                    { value: 'fast', label: 'Fast', hint: 'Starts at the nearest keyframe' },
                  ]}
                  onChange={setMode}
                />
              </Field>
            </FieldRow>
            <Text style={fs.hint}>
              {mode === 'fast'
                ? 'Fast clips copy the video without re-encoding, so they keep full quality and are ready almost instantly, but may start a few seconds early.'
                : 'Exact clips start right where you chose. They are copied without re-encoding when the start falls on a keyframe.'}{' '}
              The clip links back to this video.
            </Text>
          </>
        ))}
      {tab === 'gif' && (
        <Field label="Width" hint="15 frames a second with an optimised palette. Up to 15 seconds.">
          <Select
            value={width}
            options={[
              { value: '320', label: '320 px (smallest)' },
              { value: '480', label: '480 px' },
              { value: '640', label: '640 px (largest)' },
            ]}
            onChange={setWidth}
          />
        </Field>
      )}
      {tab === 'mp4' && <Toggle label="Without sound" hint="Up to 720p and 60 seconds." value={muted} onChange={setMuted} />}
      {job &&
        (job.status === 'failed' ? (
          <Text style={{ color: colors.err }}>{`Export failed: ${job.error || ''}`}</Text>
        ) : job.status !== 'ready' ? (
          <Notice icon="hourglass-top">
            <Text style={{ color: colors.text }}>{`Exporting ${job.format.toUpperCase()}… ${job.progress || 0}%`}</Text>
            <View style={s.meter}>
              <View style={[s.meterFill, { width: `${job.progress || 0}%` }]} />
            </View>
          </Notice>
        ) : (
          <Notice icon="check-circle" tone="ok">
            <Text style={{ color: colors.text, lineHeight: 20 }}>{`Your ${job.format.toUpperCase()} is ready (${bytes(job.size_bytes)}). The link works for a day.`}</Text>
            <Button title="Download" icon="file-download" kind="accent" small onPress={save} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
          </Notice>
        ))}
      <Button
        title={tab === 'clip' ? 'Make clip' : `Export ${tab.toUpperCase()}`}
        kind="primary"
        busy={busy}
        disabled={tooLong || tooShort || (tab === 'clip' && (!!made || !title.trim())) || exporting}
        onPress={submit}
      />
    </>
  );
}

/** Mark (as the uploader) or suggest (as anyone else) a sponsor read, intro, outro, recap or self-promotion. */
function SegmentPanel({ api, video, onDone }: { api: Api; video: Video; onDone: () => void }) {
  const length = video.duration || 0;
  const t = currentTime() ?? 0;
  const [kind, setKind] = useState('sponsor');
  const [start, setStart] = useState(Math.max(0, Math.round(t * 10) / 10));
  const [end, setEnd] = useState(Math.min(length, Math.round((t + 10) * 10) / 10));
  const [busy, setBusy] = useState(false);
  const clamp = (x: number) => Math.max(0, Math.min(length, Math.round(x * 10) / 10));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ segment: { status: string } }>(`/videos/${encodeURIComponent(video.id)}/segments`, { kind, start, end });
      toast(r.segment.status === 'published' ? 'Segment added' : 'Thanks! The uploader reviews suggestions before they apply.');
      onDone();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Field label="What is it?">
        <Select value={kind} options={SEGMENT_KINDS.map(([value, label]) => ({ value, label }))} onChange={setKind} />
      </Field>
      <FieldRow>
        <TimeField label="Start" value={start} onChange={(x) => setStart(clamp(x))} />
        <TimeField label="End" value={end} onChange={(x) => setEnd(clamp(x))} />
      </FieldRow>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Preview" icon="play-arrow" small onPress={() => playRange(start, end)} />
      </View>
      <Text style={fs.hint}>Viewers choose in Settings whether marked parts are skipped automatically, offered as a Skip button, or left alone.</Text>
      <Button title={video.can_edit ? 'Add' : 'Suggest'} kind="primary" busy={busy} disabled={end - start < 1} onPress={submit} />
    </>
  );
}

/** Upload a WebVTT or SRT file; the uploader reviews captions from anyone else before they appear. */
function CaptionPanel({ api, video, onDone }: { api: Api; video: Video; onDone: () => void }) {
  const [lang, setLang] = useState('en');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<Awaited<ReturnType<typeof pickCaptionFile>>>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.sendFile<{ caption: { status: string } }>(`/videos/${encodeURIComponent(video.id)}/captions`, 'file', file, { lang: lang.trim(), label: label.trim() });
      toast(r.caption.status === 'published' ? 'Captions added' : 'Thanks! The uploader reviews captions before they appear.');
      onDone();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Text style={fs.hint}>Upload a WebVTT (.vtt) or SubRip (.srt) file. Captions are written by people, never generated or machine-translated here.</Text>
      <Field label="File">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Button title={file ? 'Choose another' : 'Choose a file'} icon="attach-file" small onPress={async () => setFile((await pickCaptionFile()) || file)} />
          <Text style={[fs.hint, { flex: 1 }]} numberOfLines={1}>
            {file ? file.name : 'Nothing chosen'}
          </Text>
        </View>
      </Field>
      <FieldRow>
        <Field label="Language code" style={{ flexBasis: 120, flexGrow: 1 }}>
          <Input value={lang} onChangeText={setLang} autoCapitalize="none" placeholder="en, es, pt-BR" />
        </Field>
        <Field label="Name in the menu" style={{ flexBasis: 160, flexGrow: 1 }}>
          <Input value={label} onChangeText={setLabel} maxLength={40} placeholder="English" />
        </Field>
      </FieldRow>
      <Button title="Upload" kind="primary" busy={busy} disabled={!file || !lang.trim()} onPress={submit} />
    </>
  );
}

type Suggestions = {
  titles: { id: string; title: string; votes: number; voted?: boolean }[];
  thumbnails: { id: string; url: string; votes: number; voted?: boolean }[];
  can_adopt?: boolean;
};

/** Community titles and thumbnails: suggest one, vote, and (for the uploader) use one. */
function SuggestPanel({ api, video }: { api: Api; video: Video }) {
  const [data, setData] = useState<Suggestions | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/videos/${encodeURIComponent(video.id)}/suggestions`;
  useEffect(() => {
    api
      .get<Suggestions>(base)
      .then(setData)
      .catch((e) => toast(e.message));
  }, [api, base]);
  const run = async (fn: () => Promise<Suggestions>, msg?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      setData(r);
      if (msg) toast(msg);
      return r;
    } catch (e: any) {
      toast(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const vote = (kind: 'titles' | 'thumbnails', id: string) => run(() => api.post<Suggestions>(`/suggestions/${kind}/${id}/vote`));
  const adopt = (kind: 'titles' | 'thumbnails', id: string) => run(() => api.post<Suggestions>(`/suggestions/${kind}/${id}/adopt`), 'Updated your video');
  return (
    <>
      <Text style={fs.hint}>
        {`Suggest a plainer title or a frame that shows what really happens. Viewers who turn on community titles in Settings see the most-voted suggestion${data?.can_adopt ? '; you can also use one as the real title or thumbnail' : ''}.`}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Input value={title} onChangeText={setTitle} maxLength={100} placeholder="A plainer title" style={{ flex: 1 }} accessibilityLabel="Suggested title" />
        <Button
          title="Suggest"
          disabled={busy || title.trim().length < 3}
          onPress={() => run(() => api.post<Suggestions>(`${base}/titles`, { title }), 'Title suggested').then((r) => r && setTitle(''))}
        />
      </View>
      <Button title="Suggest the current frame as the thumbnail" icon="image" small disabled={busy} onPress={() => run(() => api.post<Suggestions>(`${base}/thumbnails`, { time: currentTime() ?? 0 }), 'Frame suggested')} style={{ alignSelf: 'flex-start' }} />
      {!data ? (
        <Loading />
      ) : (
        <>
          {data.titles.length > 0 && <Text style={fs.label}>Titles</Text>}
          {data.titles.map((sg) => (
            <View key={sg.id} style={s.suggRow}>
              <Button title={String(sg.votes)} icon={sg.voted ? 'thumb-up' : 'thumb-up-off-alt'} small kind={sg.voted ? 'accent' : 'secondary'} disabled={busy} onPress={() => vote('titles', sg.id)} />
              <Text style={{ color: colors.text, flex: 1 }}>{sg.title}</Text>
              {data.can_adopt && <Button title="Use this" small disabled={busy} onPress={() => adopt('titles', sg.id)} />}
            </View>
          ))}
          {data.thumbnails.length > 0 && <Text style={fs.label}>Thumbnails</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {data.thumbnails.map((sg) => (
              <View key={sg.id} style={{ width: 180, gap: 6 }}>
                <Image source={{ uri: api.abs(sg.url)! }} style={{ width: 180, aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: colors.surface2 }} contentFit="cover" />
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Button title={String(sg.votes)} icon={sg.voted ? 'thumb-up' : 'thumb-up-off-alt'} small kind={sg.voted ? 'accent' : 'secondary'} disabled={busy} onPress={() => vote('thumbnails', sg.id)} />
                  {data.can_adopt && <Button title="Use this" small disabled={busy} onPress={() => adopt('thumbnails', sg.id)} />}
                </View>
              </View>
            ))}
          </View>
        </>
      )}
    </>
  );
}

const s = StyleSheet.create({
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden', borderTopWidth: 1, borderColor: colors.border },
  side: { backgroundColor: colors.bg, borderLeftWidth: 1, borderColor: colors.border, height: '100%' },
  grip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.surface3, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4 },
  title: { flex: 1, fontSize: 18 },
  meter: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: 'hidden', marginTop: 8 },
  meterFill: { height: 6, backgroundColor: colors.accent },
  suggRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
