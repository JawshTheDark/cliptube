import { useCallback, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Field, InfoRow, Input, Notice, Section, Select, Toggle, s as fs } from '@/components/Form';
import { PreviewPlayer, usePreviewPlayer } from '@/components/PreviewPlayer';
import { confirm } from '@/components/Prompt';
import { StatusBadge } from '@/components/StudioBadges';
import { Text } from '@/components/Text';
import { GameField } from '@/components/VideoForm';
import { CaptionsManager, SegmentsManager, SuggestionsManager } from '@/components/VideoManage';
import { Button, ErrorBox, Icon, Loading, toast } from '@/components/ui';
import type { Api } from '@/lib/api';
import { bytes, duration } from '@/lib/format';
import { readable } from '@/lib/layout';
import { pickFile } from '@/lib/pick';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Video, Visibility } from '@/lib/types';

const VISIBILITY: { value: Visibility; label: string; hint: string }[] = [
  { value: 'public', label: 'Public', hint: 'Anyone can find and watch this video.' },
  { value: 'unlisted', label: 'Unlisted', hint: 'Only people with the link can watch. It will not show up in listings or search.' },
  { value: 'private', label: 'Private', hint: 'Only you (and admins) can watch this video.' },
];
const COMMENTS = [
  { value: 'inherit', label: 'Use my default (Settings)' },
  { value: 'open', label: 'Publish right away' },
  { value: 'hold_all', label: 'Hold all for review' },
  { value: 'off', label: 'Turn comments off' },
] as const;

type Form = {
  title: string;
  description: string;
  tags: string;
  visibility: Visibility;
  federate: boolean;
  comment_mode: (typeof COMMENTS)[number]['value'];
  game: string;
  allow_clips: boolean;
  allow_original_download: boolean;
};

const toForm = (v: Video): Form => ({
  title: v.title,
  description: v.description || '',
  tags: (v.tags || []).join(', '),
  visibility: (v.draft ? v.draft_visibility : v.visibility) || 'public',
  federate: v.federate !== false,
  comment_mode: v.comment_mode || 'inherit',
  game: v.game?.name || '',
  allow_clips: !!v.allow_clips,
  allow_original_download: !!v.allow_original_download,
});
const same = (a: Form, b: Form) => (Object.keys(a) as (keyof Form)[]).every((k) => a[k] === b[k]);

/** Video details, the website's Studio → Edit: every field, the thumbnail, captions, skippable parts and suggestions. */
export default function EditVideo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, site } = useSession();
  const [video, setVideo] = useState<Video | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/videos/${encodeURIComponent(id)}`;

  const load = useCallback(
    () =>
      api
        .get<{ video: Video }>(path)
        .then((r) => {
          setVideo(r.video);
          setForm((f) => f || toForm(r.video));
        })
        .catch((e) => setError(e.message)),
    [api, path],
  );
  useEffect(() => {
    load();
  }, [load]);
  const status = video?.status === 'ready' && (video.render_status === 'queued' || video.render_status === 'rendering') ? 'rendering' : video?.status;
  useEffect(() => {
    if (!status || status === 'ready' || status === 'failed') return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [status, load]);

  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!video || !form) return <Loading />;
  if (!video.can_edit) return <ErrorBox message="You can only edit your own videos." />;

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const dirty = !same(form, toForm(video));
  const save = async () => {
    if (!form.title.trim()) return toast('Give the video a title');
    setBusy(true);
    try {
      // Saving a draft's details publishes it, as on the website.
      const r = await api.patch<{ video: Video }>(path, { ...form, title: form.title.trim(), game: form.game.trim(), publish: !!video.draft });
      setVideo(r.video);
      setForm(toForm(r.video));
      toast(video.draft ? 'Saved and published' : 'Changes saved');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const uploadThumb = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.sendFile<{ video: Video }>(`${path}/thumbnail`, 'thumbnail', file);
      setVideo(r.video);
      toast('Thumbnail updated');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!(await confirm(`Delete "${video.title}"?`, 'This permanently removes the video and its comments.', { confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await api.del(path);
      toast('Video deleted');
      router.back();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const link = `${api.base}/watch/${video.id}`;
  const saveTitle = busy ? 'Saving…' : video.draft ? 'Save and publish' : 'Save';

  return (
    <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 12, gap: 14, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled" bottomOffset={24}>
      <Stack.Screen
        options={{
          title: 'Video details',
          headerRight: () => <Button title={saveTitle} kind="accent" small disabled={busy || (!dirty && !video.draft)} onPress={save} />,
        }}
      />
      {video.draft && <Notice tone="warn">Not published yet: only you can see it until you save its details.</Notice>}

      {video.status === 'ready' && video.video_url ? <Preview api={api} video={video} /> : (
        <Section>
          <StatusBadge video={video} />
          {!!video.error && <Text style={{ color: colors.err }}>{video.error}</Text>}
        </Section>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {video.status === 'ready' && <Button title="View" icon="play-arrow" small onPress={() => router.push(`/watch/${encodeURIComponent(video.id)}`)} />}
        <Button title="Analytics" icon="insights" small onPress={() => router.push({ pathname: '/studio/analytics' as any, params: { video: video.id } })} />
      </View>

      <Section>
        <Field label="Title (required)">
          <Input value={form.title} maxLength={120} onChangeText={(title) => set({ title })} />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChangeText={(description) => set({ description })} multiline placeholder="Tell viewers about your clip. Timestamps like 1:23 become tappable." />
        </Field>
        <Field label="Tags" hint="Separate with commas.">
          <Input value={form.tags} onChangeText={(tags) => set({ tags })} autoCapitalize="none" placeholder="valorant, ace, clutch" />
        </Field>
        <Field label="Game">
          <GameField value={form.game} onChange={(game) => set({ game })} />
        </Field>
        <Field label="Visibility" hint={VISIBILITY.find((x) => x.value === form.visibility)?.hint}>
          <Select value={form.visibility} options={VISIBILITY.map(({ value, label }) => ({ value, label }))} onChange={(visibility) => set({ visibility })} />
        </Field>
        <Field label="Comments">
          <Select value={form.comment_mode} options={COMMENTS.map((c) => ({ ...c }))} onChange={(comment_mode) => set({ comment_mode })} />
        </Field>
        <Toggle label="Let others clip this video" hint="Signed-in viewers can cut their own clips from it, and every clip links back here." value={form.allow_clips} onChange={(allow_clips) => set({ allow_clips })} />
        <Toggle label="Let viewers download the original" hint="You can always download it yourself from the watch page." value={form.allow_original_download} onChange={(allow_original_download) => set({ allow_original_download })} />
        {site?.federation && (
          <Toggle
            label="Share with the network"
            hint="Only public videos are shared with other instances. Turn this off to keep a public clip on this site only."
            value={form.federate}
            disabled={form.visibility !== 'public'}
            onChange={(federate) => set({ federate })}
          />
        )}
        {!!video.source && (
          <Text style={fs.hint}>
            <Icon name="content-cut" size={13} color={colors.text2} /> Clipped from{' '}
            <Text style={{ color: colors.link }} onPress={() => router.push(`/watch/${encodeURIComponent(video.source!.id)}`)}>
              {video.source.title || 'another video'}
            </Text>
            .
          </Text>
        )}
        {video.edited && <Text style={fs.hint}>This video has been edited in the timeline editor.</Text>}
        <Button title={saveTitle} kind="accent" disabled={busy || (!dirty && !video.draft)} onPress={save} style={{ alignSelf: 'flex-start' }} />
      </Section>

      <Section title="Thumbnail">
        <View style={{ width: '100%', maxWidth: 360, aspectRatio: 16 / 9, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' }}>
          {video.thumbnail_url ? <Image source={{ uri: api.abs(video.thumbnail_url)! }} style={{ width: '100%', height: '100%' }} contentFit="cover" /> : <Text style={fs.hint}>No thumbnail yet</Text>}
        </View>
        <Button title="Upload custom thumbnail" icon="image" disabled={busy} onPress={uploadThumb} style={{ alignSelf: 'flex-start' }} />
      </Section>

      <Section title="Details">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[fs.hint, { flex: 1 }]} selectable numberOfLines={1}>
            {link}
          </Text>
          <Button title="Copy" small onPress={async () => (await Clipboard.setStringAsync(link)) && toast('Link copied')} />
          <Button title="" icon="share" small onPress={() => Share.share({ message: link }).catch(() => {})} />
        </View>
        <InfoRow label="Original file" value={video.original_name} />
        <InfoRow label="Size" value={video.size_bytes ? bytes(video.size_bytes) : null} />
        <InfoRow label="Resolution" value={video.width && video.height ? `${video.width}×${video.height}` : null} />
        <InfoRow label="Duration" value={video.duration ? duration(video.duration) : null} />
      </Section>

      {video.status === 'ready' && (
        <>
          <SegmentsManager api={api} video={video} />
          <CaptionsManager api={api} video={video} />
          <SuggestionsManager api={api} video={video} onChanged={load} />
        </>
      )}

      <Section title="Delete">
        <Button title="Delete video" kind="danger" icon="delete-outline" onPress={del} style={{ alignSelf: 'flex-start' }} />
      </Section>
    </KeyboardAwareScrollView>
  );
}

function Preview({ api, video }: { api: Api; video: Video }) {
  const player = usePreviewPlayer(video, api);
  return <PreviewPlayer player={player} video={video} />;
}
