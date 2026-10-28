import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { Image } from 'expo-image';
import { EditorTimeline, PAD, type Peaks, type Seg, type Sprite } from '@/components/EditorTimeline';
import { Badge, MoreMenu, Section, Toggle, s as fs } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { Scrubber } from '@/components/Scrubber';
import { Text } from '@/components/Text';
import { Button, Chip, ErrorBox, Icon, IconButton, Loading, toast } from '@/components/ui';
import { duration as clock } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOnePlayerAtATime } from '@/lib/playback';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

const MIN_SEG = 0.1;
const MAX_PPS = 400;
const FADE = 0.75;
let segSeq = 0;
const sid = () => `s${++segSeq}`;

type Doc = { segments: Seg[]; volume: number; muted: boolean; fade_in: number; fade_out: number };
type Edit = { segments: { start: number; end: number }[]; volume?: number; muted?: boolean; fade_in?: number; fade_out?: number } | null;
type Data = {
  video: Video & { fps?: number };
  edit: Edit;
  duration: number;
  source_url: string;
  sprite_url: string;
  assets: { status: 'building' | 'ready' | 'failed' | string; error?: string; meta?: { fps?: number; has_audio?: boolean; sprite?: Sprite } };
};

function fromServer(edit: Edit, length: number): Doc {
  if (!edit) return { segments: [{ id: sid(), start: 0, end: length }], volume: 1, muted: false, fade_in: 0, fade_out: 0 };
  return {
    segments: edit.segments.map((x) => ({ id: sid(), start: x.start, end: x.end })),
    volume: edit.volume ?? 1,
    muted: !!edit.muted,
    fade_in: edit.fade_in || 0,
    fade_out: edit.fade_out || 0,
  };
}
const payload = (d: Doc) => ({
  segments: d.segments.map((x) => ({ start: Math.round(x.start * 1000) / 1000, end: Math.round(x.end * 1000) / 1000 })),
  volume: d.volume,
  muted: d.muted,
  fade_in: d.fade_in,
  fade_out: d.fade_out,
});
const sameDoc = (a: Doc, b: Doc) => JSON.stringify(payload(a)) === JSON.stringify(payload(b));
const outLength = (d: Doc) => d.segments.reduce((n, x) => n + (x.end - x.start), 0);

/** 83.456 -> "1:23.46". */
function preciseTime(t: number) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t - h * 3600 - m * 60;
  const ss = sec.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Position of source time `t` in the edited output (cut parts removed). */
function outputTime(d: Doc, t: number) {
  let acc = 0;
  for (const x of d.segments) {
    if (t >= x.end) acc += x.end - x.start;
    else {
      if (t > x.start) acc += t - x.start;
      break;
    }
  }
  return acc;
}

/**
 * The timeline editor, the website's Studio → Editor: cut a video into the parts to keep, trim them, set the volume
 * and fades, pick a thumbnail frame and clip moments from the unedited recording. Saving renders the edit on the
 * server; the current version stays up until it finishes.
 */
export default function Editor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const layout = useLayout();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDocState] = useState<Doc | null>(null);
  const docRef = useRef<Doc | null>(null);
  const [saved, setSaved] = useState<Doc | null>(null);
  const hist = useRef<{ past: Doc[]; future: Doc[] }>({ past: [], future: [] });
  const [, setHistTick] = useState(0);
  const gesture = useRef<Doc | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [skipCuts, setSkipCuts] = useState(true);
  const skipRef = useRef(true);
  skipRef.current = skipCuts;
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [busy, setBusy] = useState(false);
  const [pps, setPps] = useState(0);
  const [fitPps, setFitPps] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ at: number; offset: number } | null>(null);
  const tlWidth = useRef(0);
  const path = `/videos/${encodeURIComponent(id)}`;

  const length = data?.duration || 0;
  const fps = data?.assets?.meta?.fps || data?.video?.fps || 30;

  // ---- loading ---------------------------------------------------------------------------------

  const applyLoaded = useCallback((edit: Edit, len: number) => {
    const d = fromServer(edit, len);
    docRef.current = d;
    setDocState(d);
    setSaved(d);
    setSelected(d.segments[0].id);
    hist.current = { past: [], future: [] };
    setHistTick((n) => n + 1);
  }, []);
  useEffect(() => {
    let dead = false;
    api
      .get<Data>(`${path}/editor`)
      .then((r) => {
        if (dead) return;
        setData(r);
        applyLoaded(r.edit, r.duration);
      })
      .catch((e) => !dead && setError(e.message));
    return () => {
      dead = true;
    };
  }, [api, path, applyLoaded]);

  // The filmstrip and waveform are built after the first open, and saving renders: check again until done.
  const assetsStatus = data?.assets?.status;
  const renderStatus = data?.video?.render_status;
  const renderPrev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!data || (assetsStatus !== 'building' && renderStatus !== 'queued' && renderStatus !== 'rendering')) return;
    const t = setInterval(async () => {
      try {
        const r = await api.get<Data>(`${path}/editor`);
        setData((d) => (d ? { ...d, assets: r.assets, video: r.video } : d));
      } catch {
        /* try again next time */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [api, path, data, assetsStatus, renderStatus]);
  useEffect(() => {
    const prev = renderPrev.current;
    renderPrev.current = renderStatus;
    if ((prev === 'queued' || prev === 'rendering') && !renderStatus) toast('Your edit is live');
    if (prev !== undefined && prev !== 'failed' && renderStatus === 'failed') toast(`Rendering failed: ${data?.video?.render_error || 'unknown error'}`);
  }, [renderStatus, data?.video?.render_error]);
  useEffect(() => {
    if (assetsStatus !== 'ready') return;
    api
      .get<{ peaks: number[]; pps: number }>(`${path}/editor/waveform`)
      .then((w) => setPeaks({ ...w, max: w.peaks.reduce((m, x) => (x > m ? x : m), 1) }))
      .catch(() => setPeaks(null));
  }, [api, path, assetsStatus]);

  // ---- the player ------------------------------------------------------------------------------

  const url = data ? api.abs(data.source_url) : null;
  const source = useMemo<VideoSource>(() => (url ? { uri: url, headers: api.authFor(url), contentType: 'progressive' } : null), [api, url]);
  const player = useVideoPlayer(source);
  useOnePlayerAtATime(player);
  useEventListener(player, 'playingChange', ({ isPlaying }) => setPlaying(isPlaying));
  // Preview volume (the player can't go above 100%; the render can).
  useEffect(() => {
    if (!doc) return;
    player.muted = doc.muted;
    player.volume = Math.min(1, doc.volume);
  }, [player, doc]);

  const seek = useCallback(
    (t: number) => {
      t = Math.max(0, Math.min(length, t));
      playheadRef.current = t;
      setPlayhead(t);
      player.currentTime = t;
    },
    [length, player],
  );

  // Drive the playhead, and skip the cut parts while previewing the edit.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const t = player.currentTime;
      const segs = docRef.current?.segments || [];
      if (skipRef.current && segs.length) {
        const inside = segs.some((x) => t >= x.start - 0.02 && t < x.end);
        if (!inside) {
          const next = segs.find((x) => x.start > t - 0.02);
          if (next) player.currentTime = next.start;
          else {
            player.pause();
            player.currentTime = segs[segs.length - 1].end;
          }
        }
      }
      if (now - last > 50) {
        last = now;
        playheadRef.current = t;
        setPlayhead(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, player]);

  const togglePlay = () => {
    if (player.playing) return player.pause();
    const segs = docRef.current?.segments || [];
    if (skipRef.current && segs.length) {
      const t = player.currentTime;
      if (t >= segs[segs.length - 1].end - 0.05) player.currentTime = segs[0].start;
      else if (!segs.some((x) => t >= x.start && t < x.end)) {
        const next = segs.find((x) => x.start > t);
        if (next) player.currentTime = next.start;
      }
    }
    player.play();
  };
  const stepBy = (d: number) => {
    player.pause();
    seek(playheadRef.current + d);
  };
  const jumpCut = (dir: 1 | -1) => {
    const edges = [0, length, ...(docRef.current?.segments || []).flatMap((x) => [x.start, x.end])].sort((a, b) => a - b);
    const t = playheadRef.current;
    const target = dir < 0 ? [...edges].reverse().find((x) => x < t - 0.01) : edges.find((x) => x > t + 0.01);
    if (target !== undefined) {
      player.pause();
      seek(target);
    }
  };

  // ---- history ---------------------------------------------------------------------------------

  const setDoc = useCallback((next: Doc, record = true) => {
    if (record && docRef.current) {
      hist.current.past.push(docRef.current);
      if (hist.current.past.length > 300) hist.current.past.shift();
      hist.current.future = [];
    }
    docRef.current = next;
    setDocState(next);
    setHistTick((n) => n + 1);
  }, []);
  const restore = useCallback((d: Doc) => {
    docRef.current = d;
    setDocState(d);
    setSelected((sel) => (d.segments.some((x) => x.id === sel) ? sel : d.segments[0].id));
    setHistTick((n) => n + 1);
  }, []);
  const undo = () => {
    const h = hist.current;
    if (!h.past.length || !docRef.current) return;
    h.future.push(docRef.current);
    restore(h.past.pop()!);
  };
  const redo = () => {
    const h = hist.current;
    if (!h.future.length || !docRef.current) return;
    h.past.push(docRef.current);
    restore(h.future.pop()!);
  };
  const beginGesture = useCallback(() => {
    gesture.current = docRef.current;
  }, []);
  const endGesture = useCallback(() => {
    const start = gesture.current;
    gesture.current = null;
    if (start && start !== docRef.current) {
      hist.current.past.push(start);
      hist.current.future = [];
      setHistTick((n) => n + 1);
    }
  }, []);

  // ---- edits -----------------------------------------------------------------------------------

  const split = () => {
    const d = docRef.current!;
    const t = playheadRef.current;
    const sg = d.segments.find((x) => t > x.start + MIN_SEG && t < x.end - MIN_SEG);
    if (!sg) return toast('Put the playhead inside a part to split it');
    const right = { id: sid(), start: t, end: sg.end };
    setDoc({ ...d, segments: d.segments.flatMap((x) => (x.id === sg.id ? [{ ...sg, end: t }, right] : [x])) });
    setSelected(right.id);
  };
  const removeSelected = () => {
    const d = docRef.current!;
    const idx = d.segments.findIndex((x) => x.id === selected);
    if (idx < 0) return;
    if (d.segments.length === 1) return toast("You can't delete the only part. Trim it instead.");
    const segs = d.segments.filter((x) => x.id !== selected);
    setDoc({ ...d, segments: segs });
    setSelected(segs[Math.min(idx, segs.length - 1)].id);
  };
  const setEdge = (edge: 'start' | 'end') => {
    const d = docRef.current!;
    const i = d.segments.findIndex((x) => x.id === selected);
    if (i < 0) return;
    const sg = d.segments[i];
    const t = playheadRef.current;
    const lo = edge === 'start' ? (i > 0 ? d.segments[i - 1].end : 0) : sg.start + MIN_SEG;
    const hi = edge === 'start' ? sg.end - MIN_SEG : i < d.segments.length - 1 ? d.segments[i + 1].start : length;
    if (t < lo - 1e-6 || t > hi + 1e-6) return toast(`Move the playhead inside part ${i + 1} first`);
    setDoc({ ...d, segments: d.segments.map((x) => (x.id === sg.id ? { ...x, [edge]: t } : x)) });
  };
  const trim = useCallback(
    (segId: string, edge: 'start' | 'end', t: number) => {
      const d = docRef.current!;
      const i = d.segments.findIndex((x) => x.id === segId);
      const sg = d.segments[i];
      if (!sg) return;
      if (edge === 'start') t = Math.max(i > 0 ? d.segments[i - 1].end : 0, Math.min(t, sg.end - MIN_SEG));
      else t = Math.min(i < d.segments.length - 1 ? d.segments[i + 1].start : length, Math.max(t, sg.start + MIN_SEG));
      if (t === sg[edge]) return;
      setDoc({ ...d, segments: d.segments.map((x) => (x.id === segId ? { ...x, [edge]: t } : x)) }, false);
      player.pause();
      seek(t);
    },
    [length, setDoc, seek, player],
  );
  const restoreGap = useCallback(
    (index: number) => {
      const d = docRef.current!;
      const segs = [...d.segments];
      const before = segs[index - 1];
      const after = segs[index];
      if (before && after) {
        const merged = { id: before.id, start: before.start, end: after.end };
        segs.splice(index - 1, 2, merged);
        setSelected(merged.id);
      } else if (after) {
        segs[index] = { ...after, start: 0 };
        setSelected(after.id);
      } else if (before) {
        segs[index - 1] = { ...before, end: length };
        setSelected(before.id);
      }
      setDoc({ ...d, segments: segs });
      toast('Cut part restored');
    },
    [length, setDoc],
  );
  const resetAll = () => {
    const d = fromServer(null, length);
    setDoc(d);
    setSelected(d.segments[0].id);
  };

  // ---- zoom ------------------------------------------------------------------------------------

  const onWidth = useCallback(
    (w: number) => {
      tlWidth.current = w;
      if (!length) return;
      const fit = Math.max(0.01, (w - PAD * 2) / length);
      setFitPps((old) => {
        setPps((p) => (old === null || Math.abs(p - old) < 1e-6 ? fit : Math.max(fit, p)));
        return fit;
      });
    },
    [length],
  );
  useEffect(() => {
    if (tlWidth.current && length) onWidth(tlWidth.current);
  }, [length, onWidth]);
  const zoomTo = (p: number) => {
    const next = Math.max(fitPps || 0.01, Math.min(MAX_PPS, p));
    // Keep the playhead where it is on screen (a third of the way in when it was out of view).
    setAnchor({ at: playheadRef.current, offset: tlWidth.current / 3 });
    setPps(next);
  };

  // ---- save, revert, leave ---------------------------------------------------------------------

  const dirty = !!doc && !!saved && !sameDoc(doc, saved);
  // Leaving with unsaved changes asks first, as the website does.
  usePreventRemove(dirty, ({ repeat }) => {
    confirm('Leave the editor?', 'You have unsaved changes.', { confirmLabel: 'Leave', destructive: true }).then((ok) => ok && repeat());
  });

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ video: Video; edit: Edit }>(`${path}/edit`, payload(docRef.current!));
      setData((d) => (d ? { ...d, video: r.video, edit: r.edit } : d));
      setSaved(docRef.current);
      toast(r.video.render_status ? 'Saved. Rendering your edit now; the current version stays up until it finishes.' : 'Saved');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    if (!(await confirm('Go back to the original upload?', 'Your edit will be removed.', { confirmLabel: 'Revert', destructive: true }))) return;
    setBusy(true);
    try {
      const r = await api.del<{ video: Video }>(`${path}/edit`);
      setData((d) => (d ? { ...d, video: r.video, edit: null } : d));
      applyLoaded(null, length);
      toast('Reverted to the original');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const frameAsThumbnail = async () => {
    try {
      const r = await api.post<{ video: Video }>(`${path}/thumbnail/frame`, { time: playheadRef.current });
      setData((d) => (d ? { ...d, video: { ...d.video, ...r.video } } : d));
      toast('Thumbnail updated');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const clip = () => {
    const segs = docRef.current!.segments;
    const sel = segs.find((x) => x.id === selected);
    const t = playheadRef.current;
    const range = sel && segs.length > 1 ? { start: sel.start, end: sel.end } : { start: Math.max(0, (t > 1 ? Math.min(length, t) : Math.min(length, 30)) - 30), end: t > 1 ? Math.min(length, t) : Math.min(length, 30) };
    router.push({ pathname: '/watch-tools' as any, params: { tool: 'clip', id, from: 'source', length: String(length), start: String(range.start), end: String(range.end) } });
  };

  // ---- render ----------------------------------------------------------------------------------

  if (error) return <ErrorBox message={error} />;
  if (!data || !doc) return <Loading />;

  const v = data.video;
  const segs = doc.segments;
  const sel = segs.find((x) => x.id === selected) || null;
  const selIndex = segs.findIndex((x) => x.id === selected);
  const outLen = outLength(doc);
  const canUndo = hist.current.past.length > 0;
  const canRedo = hist.current.future.length > 0;
  const rendering = v.render_status === 'queued' || v.render_status === 'rendering';
  const hasAudio = !data.assets.meta || data.assets.meta.has_audio !== false;
  const sprite = data.assets.status === 'ready' ? data.assets.meta?.sprite || null : null;
  const spriteUrl = api.abs(data.sprite_url);
  const aspect = v.width && v.height ? v.width / v.height : 16 / 9;
  const wide = layout.wide;
  const frame = 1 / fps;

  const preview = (
    <View style={{ gap: 8 }}>
      <Pressable onPress={togglePlay} style={[s.video, { aspectRatio: Math.max(aspect, 1) }]} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'}>
        <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit="contain" pointerEvents="none" />
        {!playing && (
          <View style={s.bigPlay} pointerEvents="none">
            <Icon name="play-arrow" size={40} color="#fff" />
          </View>
        )}
      </Pressable>
      <View style={s.transport}>
        <IconButton name="first-page" label="Go to the start of the edit" onPress={() => seek(segs[0].start)} />
        <IconButton name={playing ? 'pause' : 'play-arrow'} label={playing ? 'Pause' : 'Play'} onPress={togglePlay} />
        <IconButton name="last-page" label="Go to the end of the edit" onPress={() => seek(segs[segs.length - 1].end)} />
        <View style={{ flex: 1 }}>
          <Text style={s.time}>
            {preciseTime(playhead)} <Text style={fs.hint}>{`/ ${preciseTime(length)}`}</Text>
          </Text>
          <Text style={[fs.hint, { textAlign: 'right' }]}>{`out ${preciseTime(outputTime(doc, playhead))}`}</Text>
        </View>
      </View>
      <View style={s.row}>
        <Button title="−1s" small onPress={() => stepBy(-1)} />
        <Button title="−1f" small onPress={() => stepBy(-frame)} />
        <Button title="+1f" small onPress={() => stepBy(frame)} />
        <Button title="+1s" small onPress={() => stepBy(1)} />
        <IconButton name="keyboard-arrow-left" label="Jump to the previous cut" onPress={() => jumpCut(-1)} />
        <IconButton name="keyboard-arrow-right" label="Jump to the next cut" onPress={() => jumpCut(1)} />
        <Chip label="Preview edit" active={skipCuts} onPress={() => setSkipCuts((x) => !x)} />
      </View>
    </View>
  );

  const timeline = (
    <View style={{ gap: 8 }}>
      <View style={s.row}>
        <Button title="Split" icon="content-cut" small onPress={split} />
        <Button title={`Delete part ${selIndex >= 0 ? selIndex + 1 : ''}`} icon="delete-outline" small disabled={segs.length < 2} onPress={removeSelected} />
        <Button title="Set start" small disabled={!sel} onPress={() => setEdge('start')} />
        <Button title="Set end" small disabled={!sel} onPress={() => setEdge('end')} />
        <View style={{ flex: 1 }} />
        <IconButton name="zoom-out" label="Zoom out" onPress={() => zoomTo(pps / 1.5)} />
        <IconButton name="fit-screen" label="Fit the whole video" onPress={() => zoomTo(fitPps || pps)} />
        <IconButton name="zoom-in" label="Zoom in" onPress={() => zoomTo(pps * 1.5)} />
      </View>
      {(
        <EditorTimeline
          duration={length}
          segments={segs}
          selectedId={selected}
          playhead={playhead}
          pps={pps || 1}
          sprite={sprite}
          spriteUrl={spriteUrl}
          spriteHeaders={api.authFor(spriteUrl)}
          peaks={peaks}
          follow={playing}
          onSeek={(t) => {
            player.pause();
            seek(t);
          }}
          onSelect={setSelected}
          onTrimStart={beginGesture}
          onTrim={trim}
          onTrimEnd={endGesture}
          onRestoreGap={restoreGap}
          onWidth={onWidth}
          anchor={anchor}
        />
      )}
      {data.assets.status === 'building' && <Text style={fs.hint}>Generating the filmstrip and waveform…</Text>}
      {data.assets.status === 'failed' && <Text style={{ color: colors.err }}>{`Could not build the filmstrip: ${data.assets.error || ''}`}</Text>}
      <Text style={fs.hint}>Tap to move the playhead, drag the white edges of the selected part to trim it, long-press a dark cut-out part to bring it back.</Text>
    </View>
  );

  const side = (
    <View style={{ gap: 12 }}>
      <Section title="Result">
        <View style={s.stats}>
          <Stat label="Length" value={clock(outLen)} />
          <Stat label="Cut out" value={clock(Math.max(0, length - outLen))} />
          <Stat label="Parts" value={String(segs.length)} />
        </View>
      </Section>
      <Section title="Audio">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <IconButton name={doc.muted ? 'volume-off' : 'volume-up'} label={doc.muted ? 'Unmute' : 'Mute (removes the audio track)'} onPress={() => hasAudio && setDoc({ ...doc, muted: !doc.muted })} />
          <View style={{ flex: 1, opacity: doc.muted || !hasAudio ? 0.4 : 1 }}>
            <Scrubber
              value={doc.volume}
              max={3}
              disabled={doc.muted || !hasAudio}
              onStart={beginGesture}
              onSeek={(x) => setDoc({ ...docRef.current!, volume: Math.round(x * 20) / 20 }, gesture.current === null)}
              onEnd={endGesture}
            />
          </View>
          <Text style={[s.time, { width: 56 }]}>{doc.muted ? 'Muted' : `${Math.round(doc.volume * 100)}%`}</Text>
        </View>
        {!hasAudio && <Text style={fs.hint}>This video has no audio track.</Text>}
      </Section>
      <Section title="Fades" hint="Fades apply to picture and sound in the rendered video.">
        <Toggle label="Fade in from black" value={doc.fade_in > 0} onChange={(on) => setDoc({ ...doc, fade_in: on ? FADE : 0 })} />
        <Toggle label="Fade out to black" value={doc.fade_out > 0} onChange={(on) => setDoc({ ...doc, fade_out: on ? FADE : 0 })} />
      </Section>
      <Section title="Thumbnail">
        <View style={s.thumb}>{v.thumbnail_url ? <Image source={{ uri: api.abs(v.thumbnail_url)! }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Text style={fs.hint}>None</Text>}</View>
        <Button title={`Use frame at ${preciseTime(playhead)}`} icon="image" small onPress={frameAsThumbnail} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Clip a moment" hint="Make a separate video from the selected part, or from the 30 seconds before the playhead. It is cut from the unedited recording.">
        <Button title="Make a clip" icon="content-cut" small onPress={clip} style={{ alignSelf: 'flex-start' }} />
      </Section>
      <Section title="Parts">
        {segs.map((x, i) => (
          <Pressable
            key={x.id}
            onPress={() => {
              setSelected(x.id);
              player.pause();
              seek(x.start);
            }}
            style={[s.part, x.id === selected && s.partOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: x.id === selected }}
          >
            <Text style={s.partN}>{i + 1}</Text>
            <Text style={[s.time, { flex: 1, textAlign: 'left' }]}>{`${preciseTime(x.start)} – ${preciseTime(x.end)}`}</Text>
            <Text style={fs.hint}>{clock(x.end - x.start)}</Text>
          </Pressable>
        ))}
        <Button title="Reset to full video" small kind="ghost" onPress={resetAll} style={{ alignSelf: 'flex-start' }} />
      </Section>
    </View>
  );

  const status = rendering ? (
    <Badge text={v.render_status === 'queued' ? 'Waiting to render' : `Rendering ${v.render_progress || 0}%`} tone="warn" />
  ) : v.render_status === 'failed' ? (
    <Badge text="Render failed" tone="err" />
  ) : v.edited ? (
    <Badge text="Edited version is live" tone="ok" />
  ) : (
    <Text style={fs.hint}>Original upload</Text>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Editor',
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <IconButton name="undo" label="Undo" onPress={undo} color={canUndo ? colors.text : colors.text2} />
              <IconButton name="redo" label="Redo" onPress={redo} color={canRedo ? colors.text : colors.text2} />
              <Button title={busy ? 'Saving…' : 'Save'} kind="accent" small disabled={!dirty || busy} onPress={save} />
              <MoreMenu
                label="More editor actions"
                items={[
                  ...(dirty ? [{ label: 'Discard changes', icon: 'restore' as const, onPress: () => saved && restore(saved) }] : []),
                  ...(v.edited || rendering ? [{ label: 'Revert to original', icon: 'history' as const, destructive: true, onPress: revert }] : []),
                  { label: 'Video details', icon: 'edit' as const, onPress: () => router.push(`/studio/edit/${encodeURIComponent(id)}` as any) },
                ]}
              />
            </View>
          ),
        }}
      />
      <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 40 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Text style={[fs.itemTitle, { flexShrink: 1 }]} numberOfLines={1}>
            {v.title}
          </Text>
          {status}
          {dirty && <Badge text="Unsaved changes" />}
        </View>
        {wide ? (
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 3, gap: 12 }}>
              {preview}
              {timeline}
            </View>
            <View style={{ flex: 2 }}>{side}</View>
          </View>
        ) : (
          <>
            {preview}
            {timeline}
            {side}
          </>
        )}
      </ScrollView>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={fs.hint}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  video: { width: '100%', maxHeight: 420, backgroundColor: '#000', borderRadius: 12, overflow: 'hidden', alignSelf: 'center' },
  bigPlay: { position: 'absolute', alignSelf: 'center', top: '50%', marginTop: -32, width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  time: { color: colors.text, fontVariant: ['tabular-nums'], textAlign: 'right' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  stats: { flexDirection: 'row', gap: 12 },
  thumb: { width: '100%', maxWidth: 320, aspectRatio: 16 / 9, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  part: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, backgroundColor: colors.bg2, borderWidth: 1, borderColor: 'transparent' },
  partOn: { borderColor: colors.accent },
  partN: { color: colors.text, fontWeight: '800', width: 20 },
});
