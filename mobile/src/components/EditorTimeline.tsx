import { memo, useEffect, useRef, useState, type ComponentRef } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { Text } from './Text';
import { colors } from '@/lib/theme';

export const PAD = 14; // room at both ends so 0:00 and the end are easy to reach
const RULER_H = 20;
const FILM_H = 44;
const SEG_H = 40;
const WAVE_H = 30;
const HANDLE_W = 30;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export type Seg = { id: string; start: number; end: number };
export type Sprite = { tw: number; th: number; cols: number; rows: number; count: number; interval: number };
export type Peaks = { peaks: number[]; pps: number; max: number };

function tickLabel(t: number, step: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

/** One edge of the selected part, dragged to trim it. */
function Handle({ x, edge, onStart, onMove, onEnd }: { x: number; edge: 'start' | 'end'; onStart: () => number; onMove: (t0: number, dx: number) => void; onEnd: () => void }) {
  const t0 = useRef(0);
  const cb = useRef({ onStart, onMove, onEnd });
  cb.current = { onStart, onMove, onEnd };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        t0.current = cb.current.onStart();
      },
      onPanResponderMove: (_, g) => cb.current.onMove(t0.current, g.dx),
      onPanResponderRelease: () => cb.current.onEnd(),
      onPanResponderTerminate: () => cb.current.onEnd(),
    }),
  ).current;
  return (
    <View {...pan.panHandlers} style={[s.handle, { left: x - HANDLE_W / 2 }]} accessibilityLabel={`Drag to trim the ${edge}`} accessibilityRole="adjustable">
      <View style={[s.handleBar, edge === 'start' ? { borderTopLeftRadius: 6, borderBottomLeftRadius: 6 } : { borderTopRightRadius: 6, borderBottomRightRadius: 6 }]} />
    </View>
  );
}

/**
 * The editor's timeline, in source time: a ruler, the filmstrip, the kept parts (gaps between them are cut out) and
 * the waveform. Tap to move the playhead and pick the part there; long-press a cut-out gap to restore it; drag the
 * selected part's edges to trim it. Scrolls sideways; only what's in view is drawn.
 */
export const EditorTimeline = memo(function EditorTimeline({
  duration,
  segments,
  selectedId,
  playhead,
  pps,
  sprite,
  spriteUrl,
  spriteHeaders,
  peaks,
  follow,
  onSeek,
  onSelect,
  onTrimStart,
  onTrim,
  onTrimEnd,
  onRestoreGap,
  onWidth,
  anchor,
}: {
  duration: number;
  segments: Seg[];
  selectedId: string | null;
  playhead: number;
  pps: number;
  sprite: Sprite | null;
  spriteUrl: string | null;
  spriteHeaders?: Record<string, string>;
  peaks: Peaks | null;
  follow: boolean;
  onSeek: (t: number) => void;
  onSelect: (id: string) => void;
  onTrimStart: () => void;
  onTrim: (id: string, edge: 'start' | 'end', t: number) => void;
  onTrimEnd: () => void;
  onRestoreGap: (index: number) => void;
  onWidth: (w: number) => void;
  /** Bumped by a zoom: keeps the playhead where it was on screen. */
  anchor: { at: number; offset: number } | null;
}) {
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const [left, setLeft] = useState(0);
  const [width, setWidth] = useState(1);
  const leftRef = useRef(0);
  const total = duration * pps;
  const x = (t: number) => PAD + t * pps;

  // Keep the playhead in view while playing.
  useEffect(() => {
    if (!follow) return;
    const px = x(playhead);
    if (px < leftRef.current + 20 || px > leftRef.current + width - 20) scroller.current?.scrollTo({ x: Math.max(0, px - width * 0.25), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, follow]);
  // After a zoom, put the playhead back where it was on screen.
  useEffect(() => {
    if (!anchor) return;
    scroller.current?.scrollTo({ x: Math.max(0, x(anchor.at) - anchor.offset), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    leftRef.current = e.nativeEvent.contentOffset.x;
    setLeft(e.nativeEvent.contentOffset.x);
  };
  const lo = left - width; // draw a screen's width either side
  const hi = left + width * 2;

  // Ruler
  const step = TICK_STEPS.find((st) => st * pps >= 72) || 3600;
  const ticks: React.ReactNode[] = [];
  for (let t = Math.max(0, Math.floor((lo - PAD) / pps / step) * step); t <= Math.min(duration, (hi - PAD) / pps) + 1e-6; t += step) {
    ticks.push(
      <View key={t.toFixed(3)} style={[s.tick, { left: x(t) }]}>
        <Text style={s.tickText}>{tickLabel(t, step)}</Text>
      </View>,
    );
  }

  // Filmstrip
  const tiles: React.ReactNode[] = [];
  if (sprite && spriteUrl) {
    const tileW = Math.round((FILM_H * sprite.tw) / sprite.th);
    const first = Math.max(0, Math.floor((lo - PAD) / tileW));
    const last = Math.min(Math.ceil(total / tileW), Math.ceil((hi - PAD) / tileW));
    for (let k = first; k < last; k++) {
      const px = k * tileW;
      const t = (px + tileW / 2) / pps;
      if (t > duration + 1e-6) break;
      const idx = Math.min(sprite.count - 1, Math.floor(t / sprite.interval));
      const col = idx % sprite.cols;
      const row = Math.floor(idx / sprite.cols);
      tiles.push(
        <View key={k} style={[s.tile, { left: PAD + px, width: Math.min(tileW, total - px) }]}>
          <Image
            source={{ uri: spriteUrl, headers: spriteHeaders }}
            style={{ position: 'absolute', width: sprite.cols * tileW, height: sprite.rows * FILM_H, left: -col * tileW, top: -row * FILM_H }}
            contentFit="fill"
            cachePolicy="memory-disk"
          />
        </View>,
      );
    }
  }

  // Waveform: one bar per 3 px in view.
  const bars: React.ReactNode[] = [];
  if (peaks?.peaks.length) {
    for (let px = Math.max(PAD, Math.floor(lo / 3) * 3); px < Math.min(PAD + total, hi); px += 3) {
      const t0 = (px - PAD) / pps;
      const t1 = t0 + 3 / pps;
      const i0 = Math.max(0, Math.floor(t0 * peaks.pps));
      const i1 = Math.min(peaks.peaks.length, Math.max(i0 + 1, Math.ceil(t1 * peaks.pps)));
      let m = 0;
      for (let i = i0; i < i1; i++) if (peaks.peaks[i] > m) m = peaks.peaks[i];
      const h = Math.max(1, (m / (peaks.max || 1)) * (WAVE_H - 4));
      bars.push(<View key={px} style={[s.bar, { left: px, height: h, top: (WAVE_H - h) / 2 }]} />);
    }
  }

  // Cut-out gaps: before the first part, between parts, after the last.
  const gaps: { index: number; start: number; end: number }[] = [];
  segments.forEach((sg, i) => {
    const prev = i === 0 ? 0 : segments[i - 1].end;
    if (sg.start - prev > 0.01) gaps.push({ index: i, start: prev, end: sg.start });
  });
  const lastEnd = segments[segments.length - 1]?.end ?? duration;
  if (duration - lastEnd > 0.01) gaps.push({ index: segments.length, start: lastEnd, end: duration });

  const height = RULER_H + (sprite ? FILM_H : 0) + SEG_H + WAVE_H + 8;
  const segTop = RULER_H + (sprite ? FILM_H : 0);
  const selected = segments.find((sg) => sg.id === selectedId) || null;
  const at = (locationX: number) => Math.max(0, Math.min(duration, (locationX - PAD) / pps));

  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      onScroll={onScroll}
      scrollEventThrottle={32}
      onLayout={(e) => {
        setWidth(e.nativeEvent.layout.width);
        onWidth(e.nativeEvent.layout.width);
      }}
      style={s.scroll}
    >
      <View style={{ width: total + PAD * 2, height }}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={{ height: RULER_H }}>{ticks}</View>
          {!!sprite && <View style={{ height: FILM_H }}>{tiles}</View>}
          <View style={{ height: SEG_H }}>
            <View style={[s.track, { left: PAD, width: total }]} />
            {segments.map((sg, i) => {
              const w = (sg.end - sg.start) * pps;
              return (
                <View key={sg.id} style={[s.seg, { left: x(sg.start), width: Math.max(2, w) }, sg.id === selectedId && s.segOn]}>
                  {w > 30 && <Text style={s.segLabel}>{i + 1}</Text>}
                </View>
              );
            })}
          </View>
          <View style={{ height: WAVE_H }}>{bars}</View>
          {gaps.map((g) => (
            <View key={`gap${g.index}`} style={[s.gap, { left: x(g.start), width: (g.end - g.start) * pps, top: RULER_H }]} />
          ))}
          <View style={[s.playhead, { left: x(playhead) - 1 }]} />
        </View>
        <Pressable
          style={[StyleSheet.absoluteFill, { top: RULER_H }]}
          onPress={(e) => {
            const t = at(e.nativeEvent.locationX);
            onSeek(t);
            const sg = segments.find((x2) => t >= x2.start && t <= x2.end);
            if (sg) onSelect(sg.id);
          }}
          onLongPress={(e) => {
            const t = at(e.nativeEvent.locationX);
            const g = gaps.find((x2) => t >= x2.start && t <= x2.end);
            if (g) onRestoreGap(g.index);
          }}
          accessibilityLabel="Timeline: tap to move the playhead, long-press a cut-out part to restore it"
        />
        {selected && (
          <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { top: segTop, height: SEG_H }]}>
            {(['start', 'end'] as const).map((edge) => (
              <Handle
                key={`${selected.id}-${edge}`}
                x={x(selected[edge])}
                edge={edge}
                onStart={() => {
                  onTrimStart();
                  return selected[edge];
                }}
                onMove={(t0, dx) => onTrim(selected.id, edge, t0 + dx / pps)}
                onEnd={onTrimEnd}
              />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
});

const s = StyleSheet.create({
  scroll: { backgroundColor: colors.bg2, borderRadius: 12 },
  tick: { position: 'absolute', top: 0, height: RULER_H, borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: 3 },
  tickText: { color: colors.text2, fontSize: 10, fontVariant: ['tabular-nums'] },
  tile: { position: 'absolute', top: 0, height: FILM_H, overflow: 'hidden' },
  track: { position: 'absolute', top: 6, height: SEG_H - 12, borderRadius: 6, backgroundColor: colors.surface },
  seg: { position: 'absolute', top: 4, height: SEG_H - 8, borderRadius: 6, backgroundColor: 'rgba(124,77,255,0.55)', borderWidth: 2, borderColor: 'rgba(124,77,255,0.95)', justifyContent: 'center', paddingLeft: 6 },
  segOn: { borderColor: '#fff' },
  segLabel: { color: '#fff', fontSize: 12, fontWeight: '800' },
  gap: { position: 'absolute', bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  bar: { position: 'absolute', width: 2, backgroundColor: 'rgba(62,166,255,0.85)' },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#fff' },
  handle: { position: 'absolute', top: 0, height: SEG_H, width: HANDLE_W, alignItems: 'center', justifyContent: 'center' },
  handleBar: { width: 10, height: SEG_H - 6, backgroundColor: '#fff' },
});
