import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { Empty } from '../components/VideoCard.jsx';
import { Timeline, PAD } from '../components/Timeline.jsx';
import { formatDuration } from '../util.js';

const MIN_SEG = 0.1;
const MAX_PPS = 400;
const FADE = 0.75;
let segSeq = 0;
const sid = () => `s${++segSeq}`;

function fromServer(edit, duration) {
  if (!edit) return { segments: [{ id: sid(), start: 0, end: duration }], volume: 1, muted: false, fade_in: 0, fade_out: 0 };
  return {
    segments: edit.segments.map((s) => ({ id: sid(), start: s.start, end: s.end })),
    volume: edit.volume ?? 1,
    muted: !!edit.muted,
    fade_in: edit.fade_in || 0,
    fade_out: edit.fade_out || 0,
  };
}

function payload(doc) {
  return {
    segments: doc.segments.map((s) => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 })),
    volume: doc.volume,
    muted: doc.muted,
    fade_in: doc.fade_in,
    fade_out: doc.fade_out,
  };
}

const sameDoc = (a, b) => JSON.stringify(payload(a)) === JSON.stringify(payload(b));
const outLength = (doc) => doc.segments.reduce((n, s) => n + (s.end - s.start), 0);

export function preciseTime(t) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Position of source time `t` in the edited output (cut parts removed). */
function outputTime(doc, t) {
  let acc = 0;
  for (const s of doc.segments) {
    if (t >= s.end) acc += s.end - s.start;
    else {
      if (t > s.start) acc += t - s.start;
      break;
    }
  }
  return acc;
}

export default function Editor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const videoRef = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [doc, setDocState] = useState(null);
  const docRef = useRef(null);
  const [saved, setSaved] = useState(null);
  const hist = useRef({ past: [], future: [] });
  const [, setHistTick] = useState(0);
  const gesture = useRef(null);
  const [selected, setSelected] = useState(null);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [skipCuts, setSkipCuts] = useState(true);
  const skipRef = useRef(true);
  skipRef.current = skipCuts;
  const [peaks, setPeaks] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pps, setPps] = useState(50);
  const [fitPps, setFitPps] = useState(null);
  const audio = useRef(null);
  const renderPrev = useRef(null);
  const tlWidth = useRef(0);

  const duration = data?.duration || 0;
  const fps = data?.assets?.meta?.fps || data?.video?.fps || 30;
  useTitle(data ? `Editor · ${data.video.title}` : 'Editor');

  // ---- loading -----------------------------------------------------------------------

  const applyLoaded = useCallback((r) => {
    const d = fromServer(r.edit, r.duration);
    docRef.current = d;
    setDocState(d);
    setSaved(d);
    setSelected(d.segments[0].id);
    hist.current = { past: [], future: [] };
    setHistTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let dead = false;
    api(`/videos/${id}/editor`)
      .then((r) => {
        if (dead) return;
        setData(r);
        renderPrev.current = r.video.render_status;
        applyLoaded(r);
      })
      .catch((e) => !dead && setError(e));
    return () => {
      dead = true;
    };
  }, [id, applyLoaded]);

  const assetsStatus = data?.assets?.status;
  const renderStatus = data?.video?.render_status;
  useEffect(() => {
    if (!data || (assetsStatus !== 'building' && renderStatus !== 'queued' && renderStatus !== 'rendering')) return;
    const t = setInterval(async () => {
      try {
        const r = await api(`/videos/${id}/editor`);
        setData((d) => ({ ...d, assets: r.assets, video: r.video }));
      } catch {
        /* ignore transient errors */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [assetsStatus, renderStatus, id, data]);

  useEffect(() => {
    const prev = renderPrev.current;
    renderPrev.current = renderStatus;
    if ((prev === 'queued' || prev === 'rendering') && !renderStatus) toast('Your edit is live');
    if (prev !== 'failed' && renderStatus === 'failed') toast(`Rendering failed: ${data?.video?.render_error || 'unknown error'}`);
  }, [renderStatus, toast, data?.video?.render_error]);

  useEffect(() => {
    if (assetsStatus !== 'ready') return;
    api(`/videos/${id}/editor/waveform`)
      .then((w) => setPeaks({ ...w, max: w.peaks.reduce((m, x) => (x > m ? x : m), 1) }))
      .catch(() => setPeaks(null));
  }, [assetsStatus, id]);

  // ---- history ----------------------------------------------------------------------------

  const setDoc = useCallback((next, record = true) => {
    if (record) {
      hist.current.past.push(docRef.current);
      if (hist.current.past.length > 300) hist.current.past.shift();
      hist.current.future = [];
    }
    docRef.current = next;
    setDocState(next);
    setHistTick((n) => n + 1);
  }, []);

  const restore = useCallback((d) => {
    docRef.current = d;
    setDocState(d);
    setSelected((sel) => (d.segments.some((s) => s.id === sel) ? sel : d.segments[0].id));
    setHistTick((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    const h = hist.current;
    if (!h.past.length) return;
    h.future.push(docRef.current);
    restore(h.past.pop());
  }, [restore]);

  const redo = useCallback(() => {
    const h = hist.current;
    if (!h.future.length) return;
    h.past.push(docRef.current);
    restore(h.future.pop());
  }, [restore]);

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

  // ---- playback ---------------------------------------------------------------------------

  const seek = useCallback(
    (t) => {
      const el = videoRef.current;
      t = Math.max(0, Math.min(duration, t));
      playheadRef.current = t;
      setPlayhead(t);
      if (el) el.currentTime = t;
    },
    [duration],
  );

  // Drive the playhead and skip over cut parts while playing.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !doc) return undefined;
    let raf;
    let lastSet = 0;
    const tick = (now) => {
      const t = el.currentTime;
      if (!el.paused && skipRef.current && !el.seeking) {
        const segs = docRef.current.segments;
        const inside = segs.some((s) => t >= s.start - 0.02 && t < s.end);
        if (!inside) {
          const next = segs.find((s) => s.start > t - 0.02);
          if (next) el.currentTime = next.start;
          else {
            el.pause();
            el.currentTime = segs[segs.length - 1].end;
          }
        }
      }
      if (now - lastSet > 33 && Math.abs(t - playheadRef.current) > 0.0005) {
        lastSet = now;
        playheadRef.current = t;
        setPlayhead(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [doc === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureAudio = useCallback(() => {
    const el = videoRef.current;
    if (audio.current) {
      audio.current.ctx.resume?.();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const node = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      node.connect(gain).connect(ctx.destination);
      audio.current = { ctx, gain };
    } catch {
      audio.current = { ctx: null, gain: null };
    }
  }, []);

  // Preview volume, including boosts above 100% through Web Audio.
  useEffect(() => {
    if (!doc) return;
    const vol = doc.muted ? 0 : doc.volume;
    const g = audio.current?.gain;
    if (g) g.gain.value = vol;
    else if (videoRef.current) videoRef.current.volume = Math.min(1, vol);
  }, [doc?.muted, doc?.volume]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    if (skipRef.current) {
      const segs = docRef.current.segments;
      const t = el.currentTime;
      if (t >= segs[segs.length - 1].end - 0.05) el.currentTime = segs[0].start;
      else if (!segs.some((s) => t >= s.start && t < s.end)) {
        const next = segs.find((s) => s.start > t);
        if (next) el.currentTime = next.start;
      }
    }
    ensureAudio();
    el.play().catch(() => {});
  }, [ensureAudio]);

  // ---- edit operations ------------------------------------------------------------------

  const current = () => docRef.current;
  const selectedSeg = () => current().segments.find((s) => s.id === selected);

  const split = useCallback(() => {
    const d = docRef.current;
    const t = playheadRef.current;
    const s = d.segments.find((x) => t > x.start + MIN_SEG && t < x.end - MIN_SEG);
    if (!s) return toast('Put the playhead inside a part to split it');
    const right = { id: sid(), start: t, end: s.end };
    setDoc({ ...d, segments: d.segments.flatMap((x) => (x.id === s.id ? [{ ...s, end: t }, right] : [x])) });
    setSelected(right.id);
  }, [setDoc, toast]);

  const removeSelected = useCallback(() => {
    const d = docRef.current;
    const idx = d.segments.findIndex((s) => s.id === selected);
    if (idx < 0) return;
    if (d.segments.length === 1) return toast("You can't delete the only part. Trim it instead.");
    const segs = d.segments.filter((s) => s.id !== selected);
    setDoc({ ...d, segments: segs });
    setSelected(segs[Math.min(idx, segs.length - 1)].id);
  }, [selected, setDoc, toast]);

  const setEdge = useCallback(
    (edge) => {
      const d = docRef.current;
      const i = d.segments.findIndex((s) => s.id === selected);
      if (i < 0) return;
      const s = d.segments[i];
      const t = playheadRef.current;
      const lo = edge === 'start' ? (i > 0 ? d.segments[i - 1].end : 0) : s.start + MIN_SEG;
      const hi = edge === 'start' ? s.end - MIN_SEG : i < d.segments.length - 1 ? d.segments[i + 1].start : duration;
      if (t < lo - 1e-6 || t > hi + 1e-6) return toast(`Move the playhead inside part ${i + 1} first`);
      setDoc({ ...d, segments: d.segments.map((x) => (x.id === s.id ? { ...x, [edge]: t } : x)) });
    },
    [selected, duration, setDoc, toast],
  );

  const trim = useCallback(
    (segId, edge, t) => {
      const d = docRef.current;
      const i = d.segments.findIndex((s) => s.id === segId);
      const s = d.segments[i];
      if (edge === 'start') t = Math.max(i > 0 ? d.segments[i - 1].end : 0, Math.min(t, s.end - MIN_SEG));
      else t = Math.min(i < d.segments.length - 1 ? d.segments[i + 1].start : duration, Math.max(t, s.start + MIN_SEG));
      if (t === s[edge]) return;
      setDoc({ ...d, segments: d.segments.map((x) => (x.id === segId ? { ...x, [edge]: t } : x)) }, false);
      seek(t);
    },
    [duration, setDoc, seek],
  );

  const restoreGap = useCallback(
    (index) => {
      const d = docRef.current;
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
        segs[index - 1] = { ...before, end: duration };
        setSelected(before.id);
      }
      setDoc({ ...d, segments: segs });
    },
    [duration, setDoc],
  );

  const resetAll = () => {
    const d = fromServer(null, duration);
    setDoc(d);
    setSelected(d.segments[0].id);
  };

  // ---- zoom -------------------------------------------------------------------------------

  const minPps = fitPps || 1;
  const onResize = useCallback(
    (w) => {
      tlWidth.current = w;
      if (!duration) return;
      const fit = Math.max(0.01, (w - PAD * 2) / duration);
      setFitPps((old) => {
        if (old === null) setPps(fit);
        else setPps((p) => (Math.abs(p - old) < 1e-6 ? fit : Math.max(fit, p)));
        return fit;
      });
    },
    [duration],
  );
  const zoomTo = useCallback(
    (p) => setPps(Math.max(fitPps || 0.01, Math.min(MAX_PPS, p))),
    [fitPps],
  );
  const zoomBy = (f) => {
    document.querySelector('.tl-scroll')?.anchorOnPlayhead?.();
    zoomTo(pps * f);
  };
  const sliderVal = fitPps ? Math.round((Math.log(pps / fitPps) / Math.log(Math.max(1.0001, MAX_PPS / fitPps))) * 100) : 0;

  // ---- keyboard ---------------------------------------------------------------------------

  useEffect(() => {
    const h = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === 'z') {
        e.preventDefault();
        return e.shiftKey ? redo() : undo();
      }
      if (mod && k.toLowerCase() === 'y') {
        e.preventDefault();
        return redo();
      }
      if (mod || e.altKey) return;
      const el = videoRef.current;
      const frame = 1 / fps;
      switch (k) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          el?.pause();
          seek(playheadRef.current - (e.shiftKey ? 1 : frame));
          break;
        case 'ArrowRight':
          e.preventDefault();
          el?.pause();
          seek(playheadRef.current + (e.shiftKey ? 1 : frame));
          break;
        case 'j':
          seek(playheadRef.current - 5);
          break;
        case 'l':
          seek(playheadRef.current + 5);
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const edges = [0, duration, ...docRef.current.segments.flatMap((s) => [s.start, s.end])].sort((a, b) => a - b);
          const t = playheadRef.current;
          const target = k === 'ArrowUp' ? [...edges].reverse().find((x) => x < t - 0.01) : edges.find((x) => x > t + 0.01);
          if (target !== undefined) seek(target);
          break;
        }
        case 's':
          split();
          break;
        case 'Delete':
        case 'Backspace':
        case 'x':
          e.preventDefault();
          removeSelected();
          break;
        case 'i':
          setEdge('start');
          break;
        case 'o':
          setEdge('end');
          break;
        case 'Home':
          seek(0);
          break;
        case 'End':
          seek(duration);
          break;
        case '+':
        case '=':
          zoomBy(1.5);
          break;
        case '-':
        case '_':
          zoomBy(1 / 1.5);
          break;
        case '0':
          setPps(fitPps || pps);
          break;
        default:
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  });

  // ---- save / revert ----------------------------------------------------------------------

  const dirty = !!doc && !!saved && !sameDoc(doc, saved);
  useEffect(() => {
    if (!dirty) return;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/videos/${id}/edit`, { method: 'POST', body: payload(docRef.current) });
      setData((d) => ({ ...d, video: r.video, edit: r.edit }));
      setSaved(docRef.current);
      toast(r.video.render_status ? 'Saved. Rendering your edit now; the current version stays up until it finishes.' : 'Saved');
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (!window.confirm('Go back to the original upload? Your edit will be removed.')) return;
    setBusy(true);
    try {
      const r = await api(`/videos/${id}/edit`, { method: 'DELETE' });
      setData((d) => ({ ...d, video: r.video, edit: null }));
      applyLoaded({ edit: null, duration });
      toast('Reverted to the original');
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const useFrame = async () => {
    try {
      const r = await api(`/videos/${id}/thumbnail/frame`, { method: 'POST', body: { time: playheadRef.current } });
      setData((d) => ({ ...d, video: r.video }));
      toast('Thumbnail updated');
    } catch (e) {
      toast(e.message);
    }
  };

  const leave = () => {
    if (dirty && !window.confirm('You have unsaved changes. Leave the editor anyway?')) return;
    nav(`/studio/edit/${id}`);
  };

  // ---- render ---------------------------------------------------------------------------

  if (error) {
    return (
      <Empty icon="warning" title={error.message}>
        <Link to="/studio" className="btn">
          Back to Studio
        </Link>
      </Empty>
    );
  }
  if (!data || !doc) return <div className="spinner" />;

  const v = data.video;
  const segs = doc.segments;
  const sel = selectedSeg();
  const selIndex = segs.findIndex((s) => s.id === selected);
  const outLen = outLength(doc);
  const canUndo = hist.current.past.length > 0;
  const canRedo = hist.current.future.length > 0;
  const rendering = v.render_status === 'queued' || v.render_status === 'rendering';

  return (
    <div className="editor">
      <div className="ed-head">
        <button className="icon-btn" onClick={leave} title="Back to video details">
          <Icon name="back" />
        </button>
        <div className="ed-title">
          <div className="t">{v.title}</div>
          <div className="s">
            {rendering ? (
              <span className="badge warn">{v.render_status === 'queued' ? 'Waiting to render' : `Rendering ${v.render_progress}%`}</span>
            ) : v.render_status === 'failed' ? (
              <span className="badge err" title={v.render_error || ''}>
                <Icon name="warning" /> Render failed
              </span>
            ) : v.edited ? (
              <span className="badge ok">
                <Icon name="check" /> Edited version is live
              </span>
            ) : (
              <span className="muted">Original upload</span>
            )}
            {dirty && <span className="badge">Unsaved changes</span>}
          </div>
        </div>
        <div className="ed-head-actions">
          <button className="btn btn-icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
            <Icon name="undo" />
          </button>
          <button className="btn btn-icon" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
            <Icon name="redo" />
          </button>
          {(v.edited || rendering) && (
            <button className="btn" onClick={revert} disabled={busy}>
              Revert to original
            </button>
          )}
          <button className="btn" onClick={() => restore(saved)} disabled={!dirty || busy}>
            Discard
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="ed-main">
        <div className="ed-preview">
          <div className="ed-video" onClick={togglePlay}>
            <video
              ref={videoRef}
              src={data.source_url}
              poster={v.thumbnail_url || undefined}
              preload="auto"
              playsInline
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
            {!playing && (
              <div className="ed-bigplay">
                <Icon name="play" />
              </div>
            )}
          </div>
          <div className="ed-transport">
            <button className="icon-btn" onClick={() => seek(segs[0].start)} title="Go to start of edit">
              <Icon name="first" />
            </button>
            <button className="icon-btn ed-play" onClick={togglePlay} title="Play / pause (Space)">
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <button className="icon-btn" onClick={() => seek(segs[segs.length - 1].end)} title="Go to end of edit">
              <Icon name="last" />
            </button>
            <span className="ed-time">
              {preciseTime(playhead)} <span className="muted">/ {preciseTime(duration)}</span>
            </span>
            <span className="ed-time muted" title="Position in the edited video">
              out {preciseTime(outputTime(doc, playhead))}
            </span>
            <label className="checkbox ed-skip" title="Skip over cut parts while playing">
              <input type="checkbox" checked={skipCuts} onChange={(e) => setSkipCuts(e.target.checked)} /> Preview edit
            </label>
          </div>
        </div>

        <aside className="ed-side">
          <section>
            <h3>Result</h3>
            <div className="ed-stat">
              <span>Length</span>
              <b>{formatDuration(outLen)}</b>
            </div>
            <div className="ed-stat">
              <span>Cut out</span>
              <b>{formatDuration(Math.max(0, duration - outLen))}</b>
            </div>
            <div className="ed-stat">
              <span>Parts</span>
              <b>{segs.length}</b>
            </div>
          </section>

          <section>
            <h3>Audio</h3>
            <div className="ed-row">
              <button
                className={`icon-btn ${doc.muted ? 'active' : ''}`}
                onClick={() => setDoc({ ...doc, muted: !doc.muted })}
                title={doc.muted ? 'Unmute' : 'Mute (removes the audio track)'}
                disabled={data.assets.meta && !data.assets.meta.has_audio}
              >
                <Icon name={doc.muted ? 'volume_off' : 'volume'} />
              </button>
              <input
                type="range"
                min={0}
                max={300}
                step={5}
                value={Math.round(doc.volume * 100)}
                disabled={doc.muted}
                onPointerDown={beginGesture}
                onPointerUp={endGesture}
                onChange={(e) => setDoc({ ...doc, volume: Number(e.target.value) / 100 }, gesture.current === null)}
                className="ed-range"
              />
              <span className="ed-val">{doc.muted ? 'Muted' : `${Math.round(doc.volume * 100)}%`}</span>
            </div>
            {data.assets.meta && !data.assets.meta.has_audio && <p className="hint">This video has no audio track.</p>}
          </section>

          <section>
            <h3>Fades</h3>
            <label className="checkbox">
              <input type="checkbox" checked={doc.fade_in > 0} onChange={(e) => setDoc({ ...doc, fade_in: e.target.checked ? FADE : 0 })} /> Fade in from black
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={doc.fade_out > 0} onChange={(e) => setDoc({ ...doc, fade_out: e.target.checked ? FADE : 0 })} /> Fade out to black
            </label>
            <p className="hint">Fades apply to picture and sound in the rendered video.</p>
          </section>

          <section>
            <h3>Thumbnail</h3>
            <div className="ed-thumb">{v.thumbnail_url ? <img src={v.thumbnail_url} alt="" /> : <div className="thumb-placeholder">None</div>}</div>
            <button className="btn btn-sm" onClick={useFrame}>
              <Icon name="image" /> Use frame at {preciseTime(playhead)}
            </button>
          </section>

          <section>
            <h3>Parts</h3>
            <div className="ed-parts">
              {segs.map((s, i) => (
                <div
                  key={s.id}
                  className={`ed-part ${s.id === selected ? 'selected' : ''}`}
                  onClick={() => {
                    setSelected(s.id);
                    seek(s.start);
                  }}
                >
                  <span className="n">{i + 1}</span>
                  <span className="r">
                    {preciseTime(s.start)} – {preciseTime(s.end)}
                  </span>
                  <span className="d">{formatDuration(s.end - s.start)}</span>
                </div>
              ))}
            </div>
            <button className="btn btn-sm btn-ghost" onClick={resetAll}>
              Reset to full video
            </button>
          </section>

          <section className="ed-help">
            <h3>Shortcuts</h3>
            <p>
              <kbd>Space</kbd> play · <kbd>S</kbd> split · <kbd>Del</kbd> delete part · <kbd>I</kbd>/<kbd>O</kbd> set start/end · <kbd>←</kbd>
              <kbd>→</kbd> frame (<kbd>Shift</kbd> 1s) · <kbd>↑</kbd>
              <kbd>↓</kbd> jump to cut · <kbd>Ctrl</kbd>+wheel zoom · <kbd>Ctrl+Z</kbd> undo. Double-click a cut-out part to restore it.
            </p>
          </section>
        </aside>
      </div>

      <div className="ed-toolbar">
        <button className="btn" onClick={split} title="Split at playhead (S)">
          <Icon name="cut" /> Split
        </button>
        <button className="btn" onClick={removeSelected} disabled={segs.length < 2} title="Delete the selected part (Del)">
          <Icon name="delete" /> Delete part {selIndex >= 0 ? selIndex + 1 : ''}
        </button>
        <button className="btn" onClick={() => setEdge('start')} disabled={!sel} title="Set the selected part's start to the playhead (I)">
          Set start
        </button>
        <button className="btn" onClick={() => setEdge('end')} disabled={!sel} title="Set the selected part's end to the playhead (O)">
          Set end
        </button>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.5)} title="Zoom out (-)">
          <Icon name="zoom_out" />
        </button>
        <input
          type="range"
          className="ed-zoom"
          min={0}
          max={100}
          value={Math.max(0, Math.min(100, sliderVal))}
          onChange={(e) => {
            document.querySelector('.tl-scroll')?.anchorOnPlayhead?.();
            zoomTo(minPps * Math.pow(MAX_PPS / minPps, Number(e.target.value) / 100));
          }}
          aria-label="Zoom"
        />
        <button className="icon-btn" onClick={() => zoomBy(1.5)} title="Zoom in (+)">
          <Icon name="zoom_in" />
        </button>
        <button className="icon-btn" onClick={() => setPps(fitPps || pps)} title="Fit whole video (0)">
          <Icon name="fit" />
        </button>
      </div>

      <Timeline
        duration={duration}
        segments={segs}
        selectedId={selected}
        playhead={playhead}
        pps={pps}
        sprite={data.assets.status === 'ready' ? data.assets.meta.sprite : null}
        spriteUrl={data.sprite_url}
        peaks={peaks}
        follow={playing}
        onZoom={zoomTo}
        onResize={onResize}
        onSeek={seek}
        onSelect={setSelected}
        onTrimStart={beginGesture}
        onTrim={trim}
        onTrimEnd={endGesture}
        onRestoreGap={restoreGap}
      />
      {data.assets.status === 'building' && <div className="ed-note">Generating the filmstrip and waveform…</div>}
      {data.assets.status === 'failed' && <div className="ed-note err">Could not build the filmstrip: {data.assets.error}</div>}
    </div>
  );
}
