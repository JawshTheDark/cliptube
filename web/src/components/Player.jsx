import { useEffect, useMemo, useRef, useState } from 'react';
import { PlayerControls } from './PlayerControls.jsx';
import { getPref, parseChapters, setPref, usePref } from '../util.js';

/**
 * Adaptive streaming with hls.js (loaded on demand) when the video has HLS renditions; the MP4 otherwise.
 * Returns the quality levels and a setter (-1 = automatic).
 */
function useHls(video, videoRef) {
  const [levels, setLevels] = useState(null);
  const [level, setLevelState] = useState(-1);
  const [active, setActive] = useState(-1);
  const hlsRef = useRef(null);
  useEffect(() => {
    const el = videoRef.current;
    setLevels(null);
    if (!el || !video.hls_url) return;
    let dead = false;
    import('hls.js').then(({ default: Hls }) => {
      if (dead) return;
      if (!Hls.isSupported()) {
        // Safari plays HLS itself (without a quality menu).
        if (el.canPlayType('application/vnd.apple.mpegurl')) {
          const t = el.currentTime;
          el.src = video.hls_url;
          if (t) el.currentTime = t;
        }
        return;
      }
      const hls = new Hls({ capLevelToPlayerSize: false, startLevel: -1 });
      hlsRef.current = hls;
      const t = el.currentTime;
      hls.loadSource(video.hls_url);
      hls.attachMedia(el);
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        const list = data.levels.map((l, i) => ({ index: i, name: l.name || `${l.height}p`, height: l.height, fps: l.frameRate || 0 }));
        setLevels(list);
        const pref = getPref('quality');
        const want = pref === 'source' ? list.find((l) => l.name === 'source') : list.find((l) => String(l.height) === pref && l.name !== 'source');
        if (want) {
          hls.currentLevel = want.index;
          setLevelState(want.index);
        }
        if (t) el.currentTime = t;
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => setActive(data.level));
      hls.on(Hls.Events.ERROR, (_, data) => {
        // Fall back to the MP4 if streaming can't recover.
        if (data.fatal) {
          const at = el.currentTime;
          hls.destroy();
          hlsRef.current = null;
          setLevels(null);
          el.src = video.video_url;
          el.currentTime = at;
          el.play().catch(() => {});
        }
      });
    });
    return () => {
      dead = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, video.hls_url]);
  const setLevel = (i) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = i;
    setLevelState(i);
    const l = levels?.[i];
    setPref('quality', i < 0 || !l ? 'auto' : l.name === 'source' ? 'source' : String(l.height));
  };
  return { levels, level, active, setLevel };
}

/** Skips creator-marked segments (sponsor, intro, ...) the way the viewer chose: automatically, on request, or not at all. */
function useSegments(video, videoRef) {
  const [mode] = usePref('skip');
  const [current, setCurrent] = useState(null);
  const [skipped, setSkipped] = useState(null);
  const done = useRef(new Set());
  useEffect(() => {
    done.current = new Set();
    setCurrent(null);
    const el = videoRef.current;
    const segs = video.segments || [];
    if (!el || !segs.length || mode === 'off') return;
    const tick = () => {
      const t = el.currentTime;
      const s = segs.find((x) => t >= x.start && t < x.end - 0.3);
      if (!s) {
        setCurrent(null);
        return;
      }
      if (mode === 'auto' && !done.current.has(s.id)) {
        done.current.add(s.id);
        el.currentTime = s.end;
        setSkipped(s);
        setTimeout(() => setSkipped((x) => (x === s ? null : x)), 4000);
      } else setCurrent((c) => (c?.id === s.id ? c : s));
    };
    el.addEventListener('timeupdate', tick);
    return () => el.removeEventListener('timeupdate', tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, video.segments, mode]);
  const skip = () => {
    const el = videoRef.current;
    if (el && current) {
      done.current.add(current.id);
      el.currentTime = current.end;
      setCurrent(null);
    }
  };
  const undo = () => {
    const el = videoRef.current;
    if (el && skipped) el.currentTime = skipped.start;
    setSkipped(null);
  };
  return { mode, current: mode === 'ask' ? current : null, skipped, skip, undo };
}

/**
 * The video with OurTube's own controls (PlayerControls), YouTube-style keyboard shortcuts, resume position and
 * progress reporting. `videoRef` is owned by the parent so the description timestamps and share dialog can reach
 * the element. Chapters come from `chapters` (set on another server) or from timestamps in the description.
 */
export function Player({ video, videoRef, startAt = 0, exactStart = false, loop = null, onProgress, theater, onToggleTheater, chapters = null, live = false }) {
  const q = useHls(video, videoRef);
  const seg = useSegments(video, videoRef);
  const boxRef = useRef(null);
  const chapterList = useMemo(() => (chapters?.length ? chapters : parseChapters(video.description)), [chapters, video.description]);
  // Seek to the start position once metadata is known. Resume points skip the very start and end;
  // a time from a shared link (exactStart) is used as is.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const seek = () => {
      const d = el.duration || video.duration;
      if (exactStart ? startAt > 0 && startAt < d : startAt > 3 && startAt < d - 5) el.currentTime = startAt;
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
    return () => el.removeEventListener('loadedmetadata', seek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  // Loop a range from a shared link (?t=..&end=..).
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !loop) return;
    // Animation frames give a tight loop point; timeupdate keeps it working in background tabs.
    let raf;
    const check = () => {
      if (el.currentTime >= loop.end) el.currentTime = loop.start;
    };
    const step = () => {
      check();
      raf = requestAnimationFrame(step);
    };
    const onEnded = () => {
      el.currentTime = loop.start;
      el.play().catch(() => {});
    };
    raf = requestAnimationFrame(step);
    el.addEventListener('timeupdate', check);
    el.addEventListener('ended', onEnded);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('timeupdate', check);
      el.removeEventListener('ended', onEnded);
    };
  }, [video.id, loop?.start, loop?.end, videoRef]);

  // Report playback position (throttled) for watch history / resume.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !onProgress) return;
    let last = -10;
    const tick = () => {
      if (Math.abs(el.currentTime - last) >= 5) {
        last = el.currentTime;
        onProgress(el.currentTime);
      }
    };
    const flush = () => {
      last = el.currentTime;
      onProgress(el.currentTime);
    };
    el.addEventListener('timeupdate', tick);
    el.addEventListener('pause', flush);
    el.addEventListener('ended', flush);
    return () => {
      el.removeEventListener('timeupdate', tick);
      el.removeEventListener('pause', flush);
      el.removeEventListener('ended', flush);
    };
  }, [video.id, onProgress, videoRef]);

  // Keyboard shortcuts.
  useEffect(() => {
    const h = (e) => {
      const el = videoRef.current;
      if (!el || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const nativeFocused = e.target === el;
      const key = e.key;
      if (nativeFocused && (key === ' ' || key.startsWith('Arrow'))) return; // browser handles these already
      switch (key) {
        case ' ':
        case 'k':
          e.preventDefault();
          if (el.paused) el.play();
          else el.pause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          el.currentTime = Math.max(0, el.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 5);
          break;
        case 'j':
          el.currentTime = Math.max(0, el.currentTime - 10);
          break;
        case 'l':
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          el.volume = Math.min(1, el.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          el.volume = Math.max(0, el.volume - 0.1);
          break;
        case 'm':
          el.muted = !el.muted;
          break;
        case 'f':
          if (document.fullscreenElement) document.exitFullscreen();
          else if (boxRef.current?.requestFullscreen) boxRef.current.requestFullscreen().catch(() => {});
          else el.webkitEnterFullscreen?.();
          break;
        case 't':
          onToggleTheater?.();
          break;
        case ',':
          if (el.paused) el.currentTime = Math.max(0, el.currentTime - 1 / 30);
          break;
        case '.':
          if (el.paused) el.currentTime = el.currentTime + 1 / 30;
          break;
        default:
          if (/^[0-9]$/.test(key) && el.duration) el.currentTime = (el.duration * Number(key)) / 10;
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [videoRef, onToggleTheater]);

  return (
    <div ref={boxRef} className={`player ${theater ? 'theater' : ''}`}>
      <video key={video.id} ref={videoRef} src={video.hls_url ? undefined : video.video_url} poster={video.thumbnail_url || undefined} autoPlay playsInline>
        {/* No hls_url: the MP4 is the source. With HLS the stream is attached by hls.js. */}
        {(video.captions || []).map((c, i) => (
          <track key={c.id} kind="subtitles" srcLang={c.lang} label={c.label} src={c.url} default={i === 0 && getPref('captions') === 'on'} />
        ))}
      </video>
      <PlayerControls
        videoRef={videoRef}
        boxRef={boxRef}
        videoKey={video.id}
        q={q}
        chapters={chapterList}
        segments={video.segments || []}
        captions={video.captions || []}
        live={live}
        theater={theater}
        onToggleTheater={onToggleTheater}
      />
      {seg.current && (
        <button className="player-skip" onClick={seg.skip}>
          Skip {seg.current.label.toLowerCase()} ⏭
        </button>
      )}
      {seg.skipped && (
        <button className="player-skip" onClick={seg.undo}>
          Skipped {seg.skipped.label.toLowerCase()} · Undo
        </button>
      )}
    </div>
  );
}
