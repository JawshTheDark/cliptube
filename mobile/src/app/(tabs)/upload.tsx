import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useKeepAwake } from 'expo-keep-awake';
import { AppHeader } from '@/components/AppHeader';
import { Button, Empty, Icon, toast } from '@/components/ui';
import { emptyFields, VideoForm, type VideoFields } from '@/components/VideoForm';
import { useSession } from '@/lib/session';
import { bytes } from '@/lib/format';
import { colors } from '@/lib/theme';
import { readable } from '@/lib/layout';
import type { Video } from '@/lib/types';

type Picked = { uri: string; name: string; size: number | null; type: string; lastModified: number | null };
type Stage =
  | { kind: 'form' }
  | { kind: 'uploading'; sent: number; total: number; resumedFrom?: number }
  | { kind: 'processing'; video: Video }
  | { kind: 'done'; video: Video };

function KeepAwake() {
  useKeepAwake();
  return null;
}

export default function Upload() {
  const { api, user, site, server } = useSession();
  const [file, setFile] = useState<Picked | null>(null);
  const [fields, setFields] = useState<VideoFields>(emptyFields);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<(() => void) | null>(null);

  // Signing out or switching servers drops a half-filled form.
  useEffect(() => {
    setFile(null);
    setFields(emptyFields);
    setStage({ kind: 'form' });
  }, [server, user?.id]);

  // After the upload, follow processing until the video is ready.
  useEffect(() => {
    if (stage.kind !== 'processing') return;
    const t = setInterval(async () => {
      try {
        const { video } = await api.get<{ video: Video }>(`/videos/${encodeURIComponent(stage.video.id)}`);
        if (video.status === 'ready' || video.status === 'failed') setStage({ kind: 'done', video });
        else setStage({ kind: 'processing', video });
      } catch {
        /* try again next tick */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [stage, api]);

  if (!user) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AppHeader title="Upload" />
        <Empty icon="file-upload" title="Sign in to upload videos">
          <View style={{ marginTop: 8 }}>
            <Button title="Sign in" kind="primary" onPress={() => router.push('/login')} />
          </View>
        </Empty>
      </View>
    );
  }

  const pick = async () => {
    setError(null);
    // copyToCacheDirectory: false streams the file from where it is, so multi-GB videos aren't copied first.
    const r = await DocumentPicker.getDocumentAsync({ type: 'video/*', copyToCacheDirectory: false, multiple: false });
    if (r.canceled || !r.assets?.[0]) return;
    const a = r.assets[0];
    const max = (site?.max_upload_mb || 0) * 1024 * 1024;
    if (max && a.size && a.size > max) {
      setError(`That file is ${bytes(a.size)}. This server takes up to ${bytes(max)}.`);
      return;
    }
    setFile({ uri: a.uri, name: a.name || 'video.mp4', size: a.size ?? null, type: a.mimeType || 'video/mp4', lastModified: a.lastModified ?? null });
    if (!fields.title) setFields((f) => ({ ...f, title: (a.name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 120) }));
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    setStage({ kind: 'uploading', sent: 0, total: file.size || 0 });
    // In pieces that survive a dropped connection (OurTube 1.10+), or in one request on older servers.
    const job = api.uploadVideo<{ video: Video }>(
      {
        title: fields.title.trim(),
        description: fields.description,
        tags: fields.tags,
        game: fields.game.trim(),
        visibility: fields.visibility,
        allow_clips: String(fields.allow_clips),
      },
      file,
      (sent, total, resumedFrom) =>
        setStage((s) => ({ kind: 'uploading', sent, total, resumedFrom: resumedFrom ?? (s.kind === 'uploading' ? s.resumedFrom : undefined) })),
    );
    abort.current = job.abort;
    try {
      const { video } = await job.promise;
      setStage({ kind: 'processing', video });
      setFile(null);
      setFields(emptyFields);
    } catch (e: any) {
      setStage({ kind: 'form' });
      setError(e.message);
    } finally {
      abort.current = null;
    }
  };

  if (stage.kind === 'uploading') {
    const pct = stage.total ? Math.min(100, Math.floor((stage.sent / stage.total) * 100)) : 0;
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeepAwake />
        <AppHeader title="Uploading" />
        <View style={s.progressBox}>
          <Icon name="cloud-upload" size={48} color={colors.text2} />
          <Text style={s.big}>{pct}%</Text>
          <View style={s.track}>
            <View style={[s.fill, { width: `${pct}%` }]} />
          </View>
          <Text style={s.hint}>{stage.total ? `${bytes(stage.sent)} of ${bytes(stage.total)}` : 'Starting…'}</Text>
          {!!stage.resumedFrom && <Text style={[s.hint, { color: colors.ok }]}>{`Picked up where the last try stopped, at ${bytes(stage.resumedFrom)}.`}</Text>}
          <Text style={s.hint}>
            If the connection drops, the upload carries on where it stopped. If you close the app, choose the same file again
            to continue.
          </Text>
          <Button title="Cancel" kind="ghost" onPress={() => abort.current?.()} />
        </View>
      </View>
    );
  }

  if (stage.kind === 'processing' || stage.kind === 'done') {
    const v = stage.video;
    const failed = v.status === 'failed';
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AppHeader title="Upload" />
        <View style={s.progressBox}>
          <Icon name={stage.kind === 'processing' ? 'hourglass-top' : failed ? 'error-outline' : 'check-circle'} size={56} color={failed ? colors.err : stage.kind === 'done' ? colors.ok : colors.text2} />
          <Text style={s.big} numberOfLines={2}>
            {stage.kind === 'processing' ? 'Processing…' : failed ? 'Processing failed' : 'Your video is up'}
          </Text>
          <Text style={s.hint}>
            {stage.kind === 'processing'
              ? `The server is preparing "${v.title}"${v.progress ? ` (${Math.round(v.progress)}%)` : ''}. You can leave this screen.`
              : failed
                ? v.error || 'The server could not read this file.'
                : `"${v.title}" is ${v.visibility}.`}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Button title="Watch" kind="primary" icon="play-arrow" onPress={() => router.push(`/watch/${encodeURIComponent(v.id)}`)} disabled={failed} />
            <Button title="Upload another" onPress={() => setStage({ kind: 'form' })} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AppHeader title="Upload" />
      <KeyboardAwareScrollView contentContainerStyle={[{ padding: 16, gap: 16 }, readable]} keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {file ? (
          <View style={s.fileCard}>
            <Icon name="movie" size={28} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={2}>
                {file.name}
              </Text>
              <Text style={s.hint}>{file.size ? bytes(file.size) : 'Size unknown'}</Text>
            </View>
            <Button title="Change" small onPress={pick} />
          </View>
        ) : (
          <Button title="Choose a video" kind="accent" icon="video-library" onPress={pick} />
        )}
        {!!error && <Text style={{ color: colors.err }}>{error}</Text>}
        {file && (
          <>
            <VideoForm value={fields} onChange={setFields} />
            <Button title="Upload" kind="primary" icon="file-upload" onPress={() => (fields.title.trim() ? start() : toast('Give the video a title'))} />
          </>
        )}
        {!file && <Text style={[s.hint, { textAlign: 'center' }]}>{`Videos up to ${bytes((site?.max_upload_mb || 0) * 1024 * 1024)} go to ${server.replace(/^https?:\/\//, '')}.`}</Text>}
      </KeyboardAwareScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  progressBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  big: { color: colors.text, fontSize: 26, fontWeight: '700', textAlign: 'center' },
  hint: { color: colors.text2, fontSize: 13, textAlign: 'center' },
  track: { width: '100%', height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: colors.accent },
  fileCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: colors.surface },
});
