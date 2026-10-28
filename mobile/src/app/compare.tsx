import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView, type VideoPlayer, type VideoSource } from 'expo-video';
import { Image } from 'expo-image';
import { Input, Select, s as fs } from '@/components/Form';
import { Scrubber } from '@/components/Scrubber';
import { Text } from '@/components/Text';
import { Button, Icon, IconButton, Loading, toast } from '@/components/ui';
import type { Api } from '@/lib/api';
import { useLayout } from '@/lib/layout';
import { useOnePlayerAtATime } from '@/lib/playback';
import { useLinkedApi } from '@/lib/scope';
import { precise, urlSeconds } from '@/lib/time';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

const SIDES = ['a', 'b'] as const;
type Side = (typeof SIDES)[number];
const FRAME = 1 / 60;

type Info = { title: string; src: string; poster: string | null; duration: number; by: string; host?: string | null; link: string };

/** "abc123" is a video here; "n:3:abc123" is video abc123 on network server 3. */
async function loadRef(api: Api, ref: string): Promise<Info> {
  const m = /^n:(\d+):(.+)$/.exec(ref);
  if (m) {
    const { video } = await api.get<{ video: Video }>(`/network/videos/${m[1]}/${encodeURIComponent(m[2])}`);
    if (!video.video_url) throw new Error("This video can't be played");
    return { title: video.title, src: video.video_url, poster: video.thumbnail_url, duration: video.duration || 0, by: video.uploader.display_name, host: video.remote?.peer_name, link: `/n/${m[1]}/${encodeURIComponent(m[2])}` };
  }
  const { video } = await api.get<{ video: Video }>(`/videos/${encodeURIComponent(ref)}`);
  if (!video.video_url) throw new Error("This video can't be played");
  return { title: video.title, src: video.video_url, poster: video.thumbnail_url, duration: video.duration || 0, by: video.uploader.display_name, link: `/watch/${encodeURIComponent(ref)}` };
}

/**
 * Compare clips, the website's /compare: two videos on one transport. Each side has a start point (where it is at
 * the shared time 0) so the same moment lines up; while playing, side B follows side A with small speed nudges or
 * a seek.
 */
export default function Compare() {
  const params = useLocalSearchParams<{ a?: string; b?: string; sa?: string; sb?: string; server?: string }>();
  // A shared comparison from another server loads its videos from there.
  const { api } = useLinkedApi(params.server);
  const layout = useLayout();
  const [refs, setRefs] = useState<Record<Side, string>>({ a: params.a || '', b: params.b || '' });
  const [info, setInfo] = useState<Record<Side, Info | null>>({ a: null, b: null });
  const [errors, setErrors] = useState<Record<Side, string | null>>({ a: null, b: null });
  const [start, setStart] = useState<Record<Side, number>>({ a: Number(params.sa) || 0, b: Number(params.sb) || 0 });
  const [audio, setAudio] = useState<'a' | 'b' | 'off'>('a');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('1');
  const [t, setT] = useState(0);
  const [picking, setPicking] = useState<Side | null>(null);
  const players = useRef<Record<Side, VideoPlayer | null>>({ a: null, b: null });
  const startRef = useRef(start);
  startRef.current = start;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    for (const k of SIDES) {
      if (!refs[k]) {
        setInfo((x) => ({ ...x, [k]: null }));
        continue;
      }
      setErrors((x) => ({ ...x, [k]: null }));
      loadRef(api, refs[k])
        .then((v) => setInfo((x) => ({ ...x, [k]: v })))
        .catch((e) => setErrors((x) => ({ ...x, [k]: e.message })));
    }
  }, [api, refs]);

  const dur = (k: Side) => players.current[k]?.duration || info[k]?.duration || 0;
  const length = Math.max(0, Math.min(dur('a') - start.a, dur('b') - start.b));
  const ready = !!info.a && !!info.b;
  const rate = Number(speed);

  const seekAll = useCallback((time: number) => {
    for (const k of SIDES) {
      const p = players.current[k];
      if (p) p.currentTime = Math.max(0, Math.min((p.duration || 0) - 0.01, startRef.current[k] + time));
    }
    setT(time);
  }, []);
  const pause = useCallback(() => {
    for (const k of SIDES) players.current[k]?.pause();
    setPlaying(false);
  }, []);
  const play = () => {
    if (!ready) return;
    if (t >= length - 0.05) seekAll(0);
    for (const k of SIDES) {
      const p = players.current[k];
      if (p) {
        p.playbackRate = rate;
        p.play();
      }
    }
    setPlaying(true);
  };
  const toggle = () => (playing ? pause() : play());

  // Keep B on A's clock while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastUi = 0;
    const tick = (now: number) => {
      const A = players.current.a;
      const B = players.current.b;
      if (A && B) {
        const st = startRef.current;
        const time = A.currentTime - st.a;
        const drift = B.currentTime - (st.b + time);
        if (Math.abs(drift) > 0.2) B.currentTime = st.b + time;
        else if (Math.abs(drift) > 0.03) B.playbackRate = rate * (drift > 0 ? 0.94 : 1.06);
        else B.playbackRate = rate;
        if (now - lastUi > 100) {
          lastUi = now;
          setT(time);
        }
        const len = Math.min(A.duration - st.a, B.duration - st.b);
        if (time >= len - 0.02) {
          A.pause();
          B.pause();
          setPlaying(false);
          setT(Math.max(0, len));
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate]);

  useEffect(() => {
    for (const k of SIDES) if (players.current[k]) players.current[k]!.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    for (const k of SIDES) if (players.current[k]) players.current[k]!.muted = audio !== k;
  }, [audio, info]);

  const nudge = (k: Side, d: number) => {
    pause();
    const next = { ...startRef.current, [k]: Math.max(0, Math.min(dur(k) - 0.1, Math.round((startRef.current[k] + d) * 1000) / 1000)) };
    startRef.current = next;
    setStart(next);
    const p = players.current[k];
    if (p) p.currentTime = next[k] + t;
  };
  const step = (d: number) => {
    pause();
    seekAll(Math.max(0, Math.min(length, t + d)));
  };
  const pick = (k: Side, ref: string) => {
    pause();
    setPicking(null);
    setStart((x) => ({ ...x, [k]: 0 }));
    setT(0);
    setInfo((x) => ({ ...x, [k]: null }));
    setRefs((x) => ({ ...x, [k]: ref }));
  };
  const swap = () => {
    pause();
    setRefs({ a: refs.b, b: refs.a });
    setInfo({ a: info.b, b: info.a });
    setStart({ a: start.b, b: start.a });
  };
  const share = () => {
    const q = new URLSearchParams({ a: refs.a, b: refs.b, sa: urlSeconds(start.a), sb: urlSeconds(start.b) });
    Share.share({ message: `${api.base}/compare?${q}` }).catch(() => {});
  };

  const sideWidth = layout.wide ? (layout.width - 36) / 2 : layout.width - 24;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Compare clips' }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Swap sides" icon="swap-horiz" small onPress={swap} disabled={!refs.a && !refs.b} />
        <Button title="Share" icon="share" small onPress={share} disabled={!ready} />
      </View>
      <View style={{ flexDirection: layout.wide ? 'row' : 'column', gap: 12 }}>
        {SIDES.map((k) => (
          <View key={k} style={{ width: sideWidth, gap: 8 }}>
            {picking === k || !refs[k] ? (
              <Picker api={api} onPick={(ref) => pick(k, ref)} onCancel={refs[k] ? () => setPicking(null) : undefined} label={k.toUpperCase()} />
            ) : errors[k] ? (
              <View style={[fs.section, { alignItems: 'flex-start' }]}>
                <Text style={{ color: colors.err }}>{errors[k]}</Text>
                <Button title="Pick another" small onPress={() => setPicking(k)} />
              </View>
            ) : !info[k] ? (
              <View style={{ aspectRatio: 16 / 9, backgroundColor: '#000', borderRadius: 12, justifyContent: 'center' }}>
                <Loading />
              </View>
            ) : (
              <>
                <SidePlayer
                  key={refs[k]}
                  api={api}
                  info={info[k]!}
                  label={k.toUpperCase()}
                  hasAudio={audio === k}
                  onPlayer={(p) => (players.current[k] = p)}
                  onReady={(p) => {
                    p.currentTime = startRef.current[k] + tRef.current;
                    p.muted = audio !== k;
                  }}
                  onPress={toggle}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ flex: 1, color: colors.text }} numberOfLines={1}>
                    <Text style={{ color: colors.link }} onPress={() => router.push(info[k]!.link as any)}>
                      {info[k]!.title}
                    </Text>
                    <Text style={fs.hint}>{` · ${info[k]!.by}${info[k]!.host ? ` · ${info[k]!.host}` : ''}`}</Text>
                  </Text>
                  <Button title="Change" small kind="ghost" onPress={() => setPicking(k)} />
                </View>
                <Text style={fs.hint}>{`Starts at ${precise(start[k])}`}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {(
                    [
                      ['−1s', -1],
                      ['−0.1', -0.1],
                      ['−1f', -FRAME],
                      ['+1f', FRAME],
                      ['+0.1', 0.1],
                      ['+1s', 1],
                    ] as const
                  ).map(([l, d]) => (
                    <Button key={l} title={l} small onPress={() => nudge(k, d)} />
                  ))}
                </View>
              </>
            )}
          </View>
        ))}
      </View>

      <View style={[fs.section, { gap: 8 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <IconButton name="skip-previous" label="Back one frame" onPress={() => ready && step(-FRAME)} />
          <Pressable onPress={toggle} disabled={!ready} style={[s.play, !ready && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play-arrow'} size={28} color={colors.bg} />
          </Pressable>
          <IconButton name="skip-next" label="Forward one frame" onPress={() => ready && step(FRAME)} />
          <Text style={s.time}>
            {precise(t)} <Text style={fs.hint}>{`/ ${precise(length)}`}</Text>
          </Text>
        </View>
        <Scrubber value={Math.min(t, length)} max={Math.max(0.01, length)} disabled={!ready} onStart={pause} onSeek={seekAll} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Select value={speed} small options={['0.1', '0.25', '0.5', '1'].map((x) => ({ value: x, label: `${x}×` }))} onChange={setSpeed} />
          </View>
          <View style={{ flex: 2 }}>
            <Select
              value={audio}
              small
              options={[
                { value: 'a', label: 'Sound from A' },
                { value: 'b', label: 'Sound from B' },
                { value: 'off', label: 'No sound' },
              ]}
              onChange={setAudio}
            />
          </View>
        </View>
      </View>
      <Text style={fs.hint}>Line up the same moment with each side's start buttons, then play both together. Tap a video to play or pause.</Text>
    </ScrollView>
  );
}

function SidePlayer({ api, info, label, hasAudio, onPlayer, onReady, onPress }: { api: Api; info: Info; label: string; hasAudio: boolean; onPlayer: (p: VideoPlayer | null) => void; onReady: (p: VideoPlayer) => void; onPress: () => void }) {
  const url = api.abs(info.src)!;
  const source = useMemo<VideoSource>(() => ({ uri: url, headers: api.authFor(url), contentType: 'progressive' }), [api, url]);
  const player = useVideoPlayer(source);
  useOnePlayerAtATime(player);
  useEffect(() => {
    onPlayer(player);
    return () => onPlayer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);
  const readied = useRef(false);
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && !readied.current) {
      readied.current = true;
      onReady(player);
    }
  });
  return (
    <Pressable onPress={onPress} style={[s.video, hasAudio && { borderColor: colors.accent }]} accessibilityRole="button" accessibilityLabel={`Video ${label}: play or pause both`}>
      <VideoView player={player} style={{ width: '100%', height: '100%' }} nativeControls={false} contentFit="contain" pointerEvents="none" />
      <View style={s.label}>
        <Text style={{ color: '#fff', fontWeight: '800' }}>{label}</Text>
        {hasAudio && <Icon name="volume-up" size={14} color="#fff" />}
      </View>
    </Pressable>
  );
}

function Picker({ api, onPick, onCancel, label }: { api: Api; onPick: (ref: string) => void; onCancel?: () => void; label: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Video[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .get<{ videos: Video[] }>(`/videos?scope=all&limit=12${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
        .then((r) => setResults(r.videos))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [api, q]);
  return (
    <View style={[fs.section, { gap: 8 }]}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Text style={{ color: colors.text, fontWeight: '800' }}>{label}</Text>
        <Input value={q} onChangeText={setQ} placeholder="Search for a clip" style={{ flex: 1 }} autoFocus={!!onCancel} />
        {onCancel && <Button title="Cancel" small kind="ghost" onPress={onCancel} />}
      </View>
      {results === null ? (
        <Loading />
      ) : results.length === 0 ? (
        <Text style={fs.hint}>Nothing found.</Text>
      ) : (
        <FlatList
          scrollEnabled={false}
          data={results}
          keyExtractor={(v) => (v.remote ? `n:${v.remote.peer_id}:${v.remote.remote_id}` : v.id)}
          renderItem={({ item: v }) => (
            <Pressable onPress={() => onPick(v.remote ? `n:${v.remote.peer_id}:${v.remote.remote_id}` : v.id)} style={({ pressed }) => [s.result, pressed && { backgroundColor: colors.surface2 }]}>
              <View style={s.resultThumb}>{!!v.thumbnail_url && <Image source={{ uri: api.abs(v.thumbnail_url)! }} style={{ width: '100%', height: '100%' }} contentFit="cover" />}</View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
                  {v.title}
                </Text>
                <Text style={fs.hint} numberOfLines={1}>
                  {`${v.uploader.display_name}${v.remote ? ` · ${v.remote.peer_name}` : ''}`}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  label: { position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.overlay, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  play: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
  time: { flex: 1, textAlign: 'right', color: colors.text, fontVariant: ['tabular-nums'] },
  result: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderRadius: 8 },
  resultThumb: { width: 96, aspectRatio: 16 / 9, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.surface2 },
});
