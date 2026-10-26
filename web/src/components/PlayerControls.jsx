import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { formatDuration, getPref, setPref } from '../util.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const HIDE_AFTER = 2500;
const rungLabel = (r) => (r.name === 'source' ? `Source (${r.height}p${r.fps > 31 ? Math.round(r.fps) : ''})` : `${r.height}p${r.fps > 31 ? Math.round(r.fps) : ''}`);
const speedLabel = (r) => (r === 1 ? 'Normal' : `${r}x`);

/** The video element's state for the controls, read on its events (and every frame while playing and shown). */
function useMediaState(videoRef, videoKey, smooth) {
  const read = (el) => {
    let buffered = 0;
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= el.currentTime + 0.5) buffered = Math.max(buffered, el.buffered.end(i));
    }
    return {
      time: el.currentTime,
      duration: el.duration,
      buffered,
      paused: el.paused,
      ended: el.ended,
      volume: el.volume,
      muted: el.muted,
      rate: el.playbackRate,
      waiting: !el.paused && el.readyState < 3,
      started: el.played.length > 0 || el.currentTime > 0,
    };
  };
  const [s, setS] = useState({ time: 0, duration: NaN, buffered: 0, paused: true, ended: false, volume: 1, muted: false, rate: 1, waiting: false, started: false });
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const update = () => setS(read(el));
    const events = ['timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'play', 'pause', 'playing', 'waiting', 'canplay', 'seeking', 'seeked', 'ended', 'volumechange', 'ratechange'];
    for (const e of events) el.addEventListener(e, update);
    update();
    return () => {
      for (const e of events) el.removeEventListener(e, update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey]);
  // timeupdate comes a few times a second; the bar moves smoothly while it can be seen.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !smooth || s.paused) return;
    let raf;
    const step = () => {
      setS(read(el));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smooth, s.paused, videoKey]);
  return s;
}

/** The seek bar: one piece per chapter, what has loaded, skippable parts marked, a tooltip, dragging. */
function SeekBar({ s, chapters, segments, onSeek, onDrag }) {
  const bar = useRef(null);
  const [hover, setHover] = useState(null); // { t, x, width }
  const [drag, setDrag] = useState(null);
  const lastScrub = useRef(0);
  const d = s.duration;
  if (!Number.isFinite(d) || d <= 0) return <div className="pc-seek" />;

  const fit = chapters.filter((c) => c.start < d);
  const parts = fit.length > 1 ? fit.map((c, i) => ({ ...c, end: fit[i + 1]?.start ?? d })) : [{ start: 0, end: d, title: '' }];
  const at = (e) => {
    const r = bar.current.getBoundingClientRect();
    const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
    return { t: (x / r.width) * d, x, width: r.width };
  };
  const shown = drag ?? s.time;
  const frac = (p, t) => Math.min(1, Math.max(0, (t - p.start) / (p.end - p.start)));
  const pct = (t) => `${(t / d) * 100}%`;
  const partAt = (t) => parts.findLast((p) => t >= p.start) || parts[0];
  const hoverPart = hover && partAt(hover.t);
  const segAt = hover && segments.find((x) => hover.t >= x.start && hover.t < x.end);
  const end = (e) => {
    if (drag === null) return;
    onSeek(at(e).t);
    setDrag(null);
    onDrag(false);
  };

  return (
    <div
      ref={bar}
      className={`pc-seek ${drag !== null ? 'dragging' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e).t);
        onDrag(true);
      }}
      onPointerMove={(e) => {
        const h = at(e);
        setHover(h);
        if (drag === null) return;
        setDrag(h.t);
        // Show the frame under the pointer while dragging, a few times a second.
        if (Date.now() - lastScrub.current > 120) {
          lastScrub.current = Date.now();
          onSeek(h.t, true);
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={() => drag === null && setHover(null)}
    >
      {parts.map((p, i) => (
        <div
          key={p.start}
          className={`pc-part ${hoverPart === p ? 'hover' : ''}`}
          style={{ left: pct(p.start), width: i < parts.length - 1 ? `calc(${pct(p.end - p.start)} - 3px)` : `calc(${pct(p.end - p.start)})` }}
        >
          <span className="pc-buffered" style={{ transform: `scaleX(${frac(p, s.buffered)})` }} />
          {hover && <span className="pc-hovered" style={{ transform: `scaleX(${frac(p, hover.t)})` }} />}
          <span className="pc-played" style={{ transform: `scaleX(${frac(p, shown)})` }} />
        </div>
      ))}
      {segments.map((x) => (
        <span key={x.id || x.start} className="pc-mark" style={{ left: pct(x.start), width: pct(Math.max(0, Math.min(d, x.end) - x.start)) }} />
      ))}
      <span className="pc-knob" style={{ left: pct(shown) }} />
      {hover && (
        <div className="pc-tip" style={{ left: Math.min(hover.width - 70, Math.max(70, hover.x)) }}>
          {segAt ? <span className="pc-tip-seg">{segAt.label}</span> : hoverPart?.title && <span>{hoverPart.title}</span>}
          <b>{formatDuration(hover.t)}</b>
        </div>
      )}
    </div>
  );
}

function Choice({ on, children, onClick }) {
  return (
    <button className={`pc-choice ${on ? 'active' : ''}`} onClick={onClick}>
      <span className="pc-check">{on && <Icon name="check" size={18} />}</span>
      {children}
    </button>
  );
}

/** Settings: quality, speed and captions, each a list of its own. */
function SettingsMenu({ q, s, captions, caption, setCaption, setRate, onClose, maxHeight }) {
  const [page, setPage] = useState('main');
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('.pc-gear') && close.current();
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);
  const activeLevel = q.levels?.[q.active];
  const levelName = q.level < 0 ? `Auto${activeLevel ? ` (${rungLabel(activeLevel)})` : ''}` : rungLabel(q.levels[q.level]);
  const back = (title) => (
    <button className="pc-menu-back" onClick={() => setPage('main')}>
      <Icon name="back" size={18} /> {title}
    </button>
  );
  return (
    <div className="pc-menu" ref={ref} style={{ maxHeight }}>
      {page === 'main' && (
        <>
          {q.levels?.length > 1 && (
            <button className="pc-row" onClick={() => setPage('quality')}>
              <span>Quality</span>
              <span className="pc-row-value">{levelName} ›</span>
            </button>
          )}
          <button className="pc-row" onClick={() => setPage('speed')}>
            <span>Speed</span>
            <span className="pc-row-value">{speedLabel(s.rate)} ›</span>
          </button>
          {captions.length > 0 && (
            <button className="pc-row" onClick={() => setPage('captions')}>
              <span>Captions</span>
              <span className="pc-row-value">{caption >= 0 ? captions[caption]?.label : 'Off'} ›</span>
            </button>
          )}
        </>
      )}
      {page === 'quality' && (
        <>
          {back('Quality')}
          {[...q.levels].reverse().map((l) => (
            <Choice key={l.index} on={q.level === l.index} onClick={() => (q.setLevel(l.index), onClose())}>
              {rungLabel(l)}
            </Choice>
          ))}
          <Choice on={q.level < 0} onClick={() => (q.setLevel(-1), onClose())}>
            Auto
          </Choice>
        </>
      )}
      {page === 'speed' && (
        <>
          {back('Speed')}
          {SPEEDS.map((r) => (
            <Choice key={r} on={s.rate === r} onClick={() => (setRate(r), onClose())}>
              {speedLabel(r)}
            </Choice>
          ))}
        </>
      )}
      {page === 'captions' && (
        <>
          {back('Captions')}
          <Choice on={caption < 0} onClick={() => (setCaption(-1), onClose())}>
            Off
          </Choice>
          {captions.map((c, i) => (
            <Choice key={c.id || i} on={caption === i} onClick={() => (setCaption(i), onClose())}>
              {c.label}
            </Choice>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * OurTube's own controls over the video: the seek bar in chapters, play, volume, time and chapter, captions,
 * settings, theater and fullscreen. They hide while the video plays and the pointer rests.
 */
export function PlayerControls({ videoRef, boxRef, videoKey, q, chapters = [], segments = [], captions = [], live = false, theater, onToggleTheater }) {
  const [shown, setShown] = useState(true);
  const [menu, setMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [caption, setCaptionState] = useState(-1);
  const hideTimer = useRef(null);
  const s = useMediaState(videoRef, videoKey, shown);
  const visible = shown || s.paused || menu || dragging;

  // Volume and mute are remembered between videos.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const v = Number(getPref('volume'));
    if (Number.isFinite(v) && v >= 0 && v <= 1) el.volume = v;
    if (getPref('muted') === 'on') el.muted = true;
    let t;
    const save = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        setPref('volume', String(Math.round(el.volume * 100) / 100));
        setPref('muted', el.muted ? 'on' : 'off');
      }, 400);
    };
    el.addEventListener('volumechange', save);
    return () => {
      clearTimeout(t);
      el.removeEventListener('volumechange', save);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey]);

  // Which caption track is showing (the <track default> one when captions are on).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const sync = () => setCaptionState([...el.textTracks].findIndex((t) => t.mode === 'showing'));
    sync();
    el.textTracks.addEventListener?.('change', sync);
    el.textTracks.addEventListener?.('addtrack', sync);
    return () => {
      el.textTracks.removeEventListener?.('change', sync);
      el.textTracks.removeEventListener?.('addtrack', sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, captions.length]);

  // Show on movement; hide after a rest while playing, or when the pointer leaves.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const poke = () => {
      setShown(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setShown(false), HIDE_AFTER);
    };
    const leave = () => {
      clearTimeout(hideTimer.current);
      setShown(false);
    };
    box.addEventListener('pointermove', poke);
    box.addEventListener('pointerdown', poke);
    box.addEventListener('pointerleave', leave);
    document.addEventListener('keydown', poke);
    return () => {
      clearTimeout(hideTimer.current);
      box.removeEventListener('pointermove', poke);
      box.removeEventListener('pointerdown', poke);
      box.removeEventListener('pointerleave', leave);
      document.removeEventListener('keydown', poke);
    };
  }, [boxRef]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [boxRef]);
  useEffect(() => {
    boxRef.current?.classList.toggle('pc-idle', !visible);
  }, [visible, boxRef]);

  const el = () => videoRef.current;
  const toggle = () => {
    const v = el();
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  };
  const seek = (t, scrubbing = false) => {
    const v = el();
    if (!v) return;
    if (scrubbing && v.fastSeek) v.fastSeek(t);
    else v.currentTime = t;
  };
  const toggleFullscreen = () => {
    const box = boxRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (box?.requestFullscreen) box.requestFullscreen().catch(() => {});
    else el()?.webkitEnterFullscreen?.(); // iPhone: only the video itself can go full screen
  };
  const setVolume = (v) => {
    const m = el();
    if (!m) return;
    m.volume = v;
    m.muted = v === 0;
  };
  const toggleMute = () => {
    const m = el();
    if (!m) return;
    if (m.muted || m.volume === 0) {
      m.muted = false;
      if (m.volume === 0) m.volume = 0.5;
    } else m.muted = true;
  };
  const setCaption = (i) => {
    const m = el();
    if (!m) return;
    [...m.textTracks].forEach((t, j) => (t.mode = j === i ? 'showing' : 'disabled'));
    setCaptionState(i);
    setPref('captions', i >= 0 ? 'on' : 'off');
  };
  const goLive = () => {
    const m = el();
    if (m?.seekable.length) m.currentTime = m.seekable.end(m.seekable.length - 1) - 1;
    m?.play().catch(() => {});
  };

  const chapter = chapters.length ? chapters.findLast((c) => s.time >= c.start) : null;
  const vol = s.muted ? 0 : s.volume;
  const atLiveEdge = live && el()?.seekable.length && el().seekable.end(el().seekable.length - 1) - s.time < 8;

  return (
    <>
      <div
        className="pc-surface"
        onClick={(e) => {
          if (e.pointerType === 'touch' && !visible) return;
          toggle();
        }}
        onDoubleClick={toggleFullscreen}
      />
      {s.waiting && <div className="pc-spinner" />}
      {(!s.started || s.ended) && s.paused && (
        <button className="pc-big-play" onClick={toggle} aria-label="Play">
          <Icon name={s.ended ? 'refresh' : 'play'} size={44} />
        </button>
      )}
      <div className={`pc-bar ${visible ? '' : 'pc-hide'}`}>
        {!live && <SeekBar s={s} chapters={chapters} segments={segments} onSeek={seek} onDrag={setDragging} />}
        <div className="pc-row-buttons">
          <button className="pc-btn" onClick={toggle} aria-label={s.paused ? 'Play' : 'Pause'} title={s.paused ? 'Play (k)' : 'Pause (k)'}>
            <Icon name={s.paused ? 'play' : 'pause'} />
          </button>
          <div className="pc-volume">
            <button className="pc-btn" onClick={toggleMute} aria-label={vol === 0 ? 'Unmute' : 'Mute'} title={vol === 0 ? 'Unmute (m)' : 'Mute (m)'}>
              <Icon name={vol === 0 ? 'volume_off' : vol < 0.5 ? 'volume_down' : 'volume'} />
            </button>
            <input
              type="range"
              className="pc-slider"
              min="0"
              max="1"
              step="0.02"
              value={vol}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Volume"
              style={{ '--fill': `${vol * 100}%` }}
            />
          </div>
          {live ? (
            <button className={`pc-live ${atLiveEdge ? 'at-edge' : ''}`} onClick={goLive} title="Jump to live">
              <span className="pc-live-dot" /> LIVE
            </button>
          ) : (
            <div className="pc-time">
              <span>
                {formatDuration(s.time)}
                {Number.isFinite(s.duration) && <span className="pc-time-total"> / {formatDuration(s.duration)}</span>}
              </span>
              {chapter?.title && <span className="pc-chapter ellipsis">· {chapter.title}</span>}
            </div>
          )}
          <span className="pc-spacer" />
          {captions.length > 0 && (
            <button
              className={`pc-btn ${caption >= 0 ? 'pc-on' : ''}`}
              onClick={() => setCaption(caption >= 0 ? -1 : 0)}
              aria-label="Captions"
              title={caption >= 0 ? 'Captions off' : 'Captions on'}
            >
              <Icon name="subtitles" />
            </button>
          )}
          <div className="pc-gear-wrap">
            <button className={`pc-btn pc-gear ${menu ? 'pc-turned' : ''}`} onClick={() => setMenu((m) => !m)} aria-label="Settings" title="Settings">
              <Icon name="settings" />
            </button>
            {menu && <SettingsMenu q={q} s={s} captions={captions} caption={caption} setCaption={setCaption} setRate={(r) => (el().playbackRate = r)}
                onClose={() => setMenu(false)}
                maxHeight={Math.max(120, (boxRef.current?.clientHeight || 400) - 64)}
              />}
          </div>
          {onToggleTheater && !fullscreen && (
            <button className="pc-btn" onClick={onToggleTheater} aria-label="Theater mode" title={theater ? 'Default view (t)' : 'Theater mode (t)'}>
              <Icon name="theater" />
            </button>
          )}
          <button className="pc-btn" onClick={toggleFullscreen} aria-label="Fullscreen" title={fullscreen ? 'Exit full screen (f)' : 'Full screen (f)'}>
            <Icon name={fullscreen ? 'fullscreen_exit' : 'fullscreen'} />
          </button>
        </div>
      </div>
    </>
  );
}
