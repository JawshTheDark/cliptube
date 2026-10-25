import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const PAD = 14; // px of breathing room at both ends so 0:00 and the end are easy to grab
const RULER_H = 26;
const FILM_H = 56;
const WAVE_H = 44;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

function tickLabel(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

const Ruler = memo(function Ruler({ duration, pps, left, width }) {
  const step = TICK_STEPS.find((s) => s * pps >= 72) || 3600;
  const minor = step / 5;
  const t0 = Math.max(0, Math.floor((left - PAD) / pps / step) * step);
  const t1 = Math.min(duration, (left + width) / pps);
  const ticks = [];
  for (let t = t0; t <= t1 + 1e-6; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ticks.push(
      <div key={t.toFixed(3)} className={`tl-tick ${major ? 'major' : ''}`} style={{ left: PAD + t * pps }}>
        {major && <span>{tickLabel(t, step)}</span>}
      </div>,
    );
  }
  return <div className="tl-ruler">{ticks}</div>;
});

const Filmstrip = memo(function Filmstrip({ duration, pps, left, width, sprite, spriteUrl }) {
  if (!sprite) return <div className="tl-film loading" />;
  const tileW = Math.round((FILM_H * sprite.tw) / sprite.th);
  const total = duration * pps;
  const first = Math.max(0, Math.floor((left - PAD) / tileW) - 1);
  const last = Math.min(Math.ceil(total / tileW), Math.ceil((left + width) / tileW) + 1);
  const tiles = [];
  for (let k = first; k < last; k++) {
    const x = k * tileW;
    const t = (x + tileW / 2) / pps;
    if (t > duration + 1e-6) break;
    const idx = Math.min(sprite.count - 1, Math.floor(t / sprite.interval));
    const col = idx % sprite.cols;
    const row = Math.floor(idx / sprite.cols);
    tiles.push(
      <div
        key={k}
        className="tl-tile"
        style={{
          left: PAD + x,
          width: Math.min(tileW, total - x),
          backgroundImage: `url(${spriteUrl})`,
          backgroundSize: `${sprite.cols * tileW}px ${sprite.rows * FILM_H}px`,
          backgroundPosition: `-${col * tileW}px -${row * FILM_H}px`,
        }}
      />,
    );
  }
  return <div className="tl-film">{tiles}</div>;
});

function Waveform({ duration, pps, left, width, peaks }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(WAVE_H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_H);
    const arr = peaks?.peaks;
    if (!arr?.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, WAVE_H / 2 - 0.5, width, 1);
      return;
    }
    const max = peaks.max || 1;
    ctx.fillStyle = 'rgba(62, 166, 255, 0.85)';
    for (let px = 0; px < width; px++) {
      const t0 = (left + px - PAD) / pps;
      const t1 = t0 + 1 / pps;
      if (t1 < 0 || t0 > duration) continue;
      const i0 = Math.max(0, Math.floor(t0 * peaks.pps));
      const i1 = Math.min(arr.length, Math.max(i0 + 1, Math.ceil(t1 * peaks.pps)));
      let m = 0;
      for (let i = i0; i < i1; i++) if (arr[i] > m) m = arr[i];
      const h = Math.max(1, (m / max) * (WAVE_H - 6));
      ctx.fillRect(px, (WAVE_H - h) / 2, 1, h);
    }
  }, [duration, pps, left, width, peaks]);
  return (
    <div className="tl-wave">
      <canvas ref={ref} style={{ left, width, height: WAVE_H }} />
    </div>
  );
}

/**
 * The editor timeline. Works entirely in source time; `segments` are the kept parts.
 * Gaps between segments are the cut-out parts.
 */
export function Timeline({
  duration,
  segments,
  selectedId,
  playhead,
  pps,
  sprite,
  spriteUrl,
  peaks,
  follow,
  onZoom,
  onResize,
  onSeek,
  onSelect,
  onTrimStart,
  onTrim,
  onTrimEnd,
  onRestoreGap,
}) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const anchor = useRef(null); // { t, offset } kept in place across zoom changes
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

  const total = duration * pps;
  const x = (t) => PAD + t * pps;

  // Track scroll position and size for virtualised drawing.
  useEffect(() => {
    const el = scrollRef.current;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(() => {
      update();
      onResize?.(el.clientWidth);
    });
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, [onResize]);

  // Keep the anchored time under the same screen position when zoom changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const a = anchor.current;
    if (a) {
      el.scrollLeft = Math.max(0, PAD + a.t * pps - a.offset);
      anchor.current = null;
    }
    setView({ left: el.scrollLeft, width: el.clientWidth });
  }, [pps]);

  // Ctrl/Cmd + wheel zooms around the cursor; a plain vertical wheel scrolls sideways.
  useEffect(() => {
    const el = scrollRef.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const offset = e.clientX - rect.left;
        const t = (el.scrollLeft + offset - PAD) / ppsRef.current;
        anchor.current = { t, offset };
        onZoom(ppsRef.current * (e.deltaY < 0 ? 1.25 : 0.8));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);

  // Follow the playhead during playback.
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    const px = PAD + playhead * pps;
    if (px > el.scrollLeft + el.clientWidth - 40 || px < el.scrollLeft) el.scrollLeft = Math.max(0, px - 60);
  }, [playhead, pps, follow]);

  // Exposed for zoom buttons: anchor on the playhead.
  useEffect(() => {
    const el = scrollRef.current;
    el.anchorOnPlayhead = () => {
      anchor.current = { t: playheadRef.current, offset: PAD + playheadRef.current * ppsRef.current - el.scrollLeft };
    };
  }, []);

  const timeAt = useCallback(
    (clientX) => {
      const rect = contentRef.current.getBoundingClientRect();
      return Math.max(0, Math.min(duration, (clientX - rect.left - PAD) / ppsRef.current));
    },
    [duration],
  );

  const drag = (onMove, onUp) => {
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onUp?.(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onBackgroundDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const t = timeAt(e.clientX);
    onSeek(t);
    const seg = segments.find((s) => t >= s.start && t < s.end);
    if (seg) onSelect(seg.id);
    drag((ev) => onSeek(timeAt(ev.clientX)));
  };

  const onHandleDown = (e, seg, edge) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(seg.id);
    onTrimStart();
    drag(
      (ev) => {
        let t = timeAt(ev.clientX);
        if (Math.abs(t - playheadRef.current) * ppsRef.current < 8) t = playheadRef.current; // snap to playhead
        onTrim(seg.id, edge, t);
      },
      () => onTrimEnd(),
    );
  };

  // Gaps (cut-out parts) between kept segments.
  const gaps = [];
  let prevEnd = 0;
  segments.forEach((s, i) => {
    if (s.start - prevEnd > 0.001) gaps.push({ index: i, start: prevEnd, end: s.start });
    prevEnd = s.end;
  });
  if (duration - prevEnd > 0.001) gaps.push({ index: segments.length, start: prevEnd, end: duration });

  return (
    <div className="tl">
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" ref={contentRef} style={{ width: total + PAD * 2 }} onPointerDown={onBackgroundDown}>
          <Ruler duration={duration} pps={pps} left={view.left} width={view.width} />
          <Filmstrip duration={duration} pps={pps} left={view.left} width={view.width} sprite={sprite} spriteUrl={spriteUrl} />
          <Waveform duration={duration} pps={pps} left={view.left} width={view.width} peaks={peaks} />
          <div className="tl-overlay" style={{ top: RULER_H, height: FILM_H + WAVE_H }}>
            {gaps.map((g) => (
              <div
                key={`g${g.index}`}
                className="tl-gap"
                style={{ left: x(g.start), width: Math.max(1, (g.end - g.start) * pps) }}
                title="Cut out. Double-click to restore."
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onRestoreGap(g.index);
                }}
              />
            ))}
            {segments.map((s, i) => {
              const w = (s.end - s.start) * pps;
              return (
                <div key={s.id} className={`tl-seg ${s.id === selectedId ? 'selected' : ''}`} style={{ left: x(s.start), width: Math.max(2, w) }}>
                  {w > 54 && <span className="tl-seg-label">{i + 1}</span>}
                  <div className="tl-handle left" onPointerDown={(e) => onHandleDown(e, s, 'start')} title="Drag to trim the start" />
                  <div className="tl-handle right" onPointerDown={(e) => onHandleDown(e, s, 'end')} title="Drag to trim the end" />
                </div>
              );
            })}
          </div>
          <div className="tl-playhead" style={{ left: x(playhead) }}>
            <div className="tl-knob" />
          </div>
        </div>
      </div>
    </div>
  );
}
