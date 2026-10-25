import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { copyText, formatPrecise, urlSeconds } from '../util.js';

const SIDES = ['a', 'b'];
const FRAME = 1 / 60;

/** "abc123" is a video here; "n:3:abc123" is video abc123 on network instance 3. */
async function loadRef(ref) {
  const m = /^n:(\d+):(.+)$/.exec(ref);
  if (m) {
    const { video } = await api(`/network/videos/${m[1]}/${encodeURIComponent(m[2])}`);
    return { title: video.title, src: video.video_url, poster: video.thumbnail_url, duration: video.duration, by: video.uploader?.display_name, host: video.remote?.peer_name, link: `/n/${m[1]}/${m[2]}` };
  }
  const { video } = await api(`/videos/${encodeURIComponent(ref)}`);
  if (!video.video_url) throw new Error("This video can't be played");
  return { title: video.title, src: video.video_url, poster: video.thumbnail_url, duration: video.duration, by: video.uploader.display_name, link: `/watch/${ref}` };
}

function Picker({ onPick, onCancel }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api(`/videos?scope=all&limit=12${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
        .then((r) => setResults(r.videos))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="cmp-picker">
      <div className="row-actions">
        <input className="input grow" placeholder="Search for a clip" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {onCancel && (
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div className="cmp-results">
        {results === null && <div className="spinner" />}
        {results?.length === 0 && <p className="muted">Nothing found.</p>}
        {results?.map((v) => (
          <button key={v.id} className="cmp-result" onClick={() => onPick(v.remote ? `n:${v.remote.peer_id}:${v.remote.remote_id}` : v.id)}>
            {v.thumbnail_url ? <img src={v.thumbnail_url} alt="" /> : <span className="cmp-thumb" />}
            <span className="cmp-result-text">
              <span className="ellipsis">{v.title}</span>
              <span className="muted small ellipsis">
                {v.uploader.display_name}
                {v.remote ? ` · ${v.remote.peer_name}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Two clips on one transport. Each side has a start point (where it is at the shared time 0), so the
 * same moment lines up; while playing, side B follows side A with small speed nudges or a seek.
 */
export default function Compare() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const refs = { a: params.get('a') || '', b: params.get('b') || '' };
  const [info, setInfo] = useState({ a: null, b: null });
  const [errors, setErrors] = useState({});
  const [start, setStart] = useState(() => ({ a: Number(params.get('sa')) || 0, b: Number(params.get('sb')) || 0 }));
  const [audio, setAudio] = useState('a');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [t, setT] = useState(0);
  const [picking, setPicking] = useState(null);
  const a = useRef(null);
  const b = useRef(null);
  const els = { a, b };
  const startRef = useRef(start);
  startRef.current = start;
  useTitle('Compare clips');

  useEffect(() => {
    for (const k of SIDES) {
      if (!refs[k]) {
        setInfo((s) => ({ ...s, [k]: null }));
        continue;
      }
      setErrors((x) => ({ ...x, [k]: null }));
      loadRef(refs[k])
        .then((v) => setInfo((s) => ({ ...s, [k]: v })))
        .catch((e) => setErrors((x) => ({ ...x, [k]: e.message })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.a, refs.b]);

  const dur = (k) => els[k].current?.duration || info[k]?.duration || 0;
  const length = Math.max(0, Math.min(dur('a') - start.a, dur('b') - start.b));
  const ready = info.a && info.b;

  const seekAll = useCallback((time) => {
    const s = startRef.current;
    for (const k of SIDES) {
      const el = els[k].current;
      if (el) el.currentTime = Math.max(0, Math.min((el.duration || 0) - 0.01, s[k] + time));
    }
    setT(time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = () => {
    for (const k of SIDES) els[k].current?.pause();
    setPlaying(false);
  };
  const play = () => {
    if (!ready) return;
    if (t >= length - 0.05) seekAll(0);
    for (const k of SIDES) {
      const el = els[k].current;
      if (el) {
        el.playbackRate = speed;
        el.play().catch(() => {});
      }
    }
    setPlaying(true);
  };
  const toggle = () => (playing ? pause() : play());

  // Keep B on A's clock while playing.
  useEffect(() => {
    if (!playing) return;
    let raf;
    let lastUi = 0;
    const tick = (now) => {
      const A = a.current;
      const B = b.current;
      if (A && B) {
        const s = startRef.current;
        const time = A.currentTime - s.a;
        const target = s.b + time;
        const drift = B.currentTime - target;
        if (Math.abs(drift) > 0.2) B.currentTime = target;
        else if (Math.abs(drift) > 0.03) B.playbackRate = speed * (drift > 0 ? 0.94 : 1.06);
        else B.playbackRate = speed;
        if (now - lastUi > 100) {
          lastUi = now;
          setT(time);
        }
        const len = Math.min(A.duration - s.a, B.duration - s.b);
        if (time >= len - 0.02 || A.ended || B.ended) {
          A.pause();
          B.pause();
          setPlaying(false);
          setT(Math.max(0, len));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  useEffect(() => {
    for (const k of SIDES) if (els[k].current) els[k].current.playbackRate = speed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  const nudge = (k, d) => {
    pause();
    setStart((s) => {
      const next = { ...s, [k]: Math.max(0, Math.min(dur(k) - 0.1, Math.round((s[k] + d) * 1000) / 1000)) };
      startRef.current = next;
      const el = els[k].current;
      if (el) el.currentTime = next[k] + t;
      return next;
    });
  };
  const step = (d) => {
    pause();
    seekAll(Math.max(0, Math.min(length, t + d)));
  };

  // Space plays, , and . step a frame, like the watch page.
  useEffect(() => {
    const h = (e) => {
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        toggle();
      } else if (e.key === ',') step(-FRAME);
      else if (e.key === '.') step(FRAME);
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  });

  const pick = (k, ref) => {
    pause();
    setPicking(null);
    setStart((s) => ({ ...s, [k]: 0 }));
    setT(0);
    const next = new URLSearchParams(params);
    next.set(k, ref);
    next.delete(`s${k}`);
    setParams(next, { replace: true });
  };
  const swap = () => {
    pause();
    const next = new URLSearchParams();
    if (refs.b) next.set('a', refs.b);
    if (refs.a) next.set('b', refs.a);
    setStart({ a: start.b, b: start.a });
    setParams(next, { replace: true });
  };
  const share = async () => {
    const q = new URLSearchParams({ a: refs.a, b: refs.b, sa: urlSeconds(start.a), sb: urlSeconds(start.b) });
    const url = `${window.location.origin}/compare?${q}`;
    toast((await copyText(url)) ? 'Link copied, lined up as it is now' : url);
  };

  return (
    <div className="page page-wide compare">
      <div className="page-head">
        <h1>
          <Icon name="compare" /> Compare clips
        </h1>
        <div className="row-actions">
          <button className="btn" onClick={swap} disabled={!refs.a && !refs.b}>
            Swap sides
          </button>
          <button className="btn" onClick={share} disabled={!ready}>
            <Icon name="share" /> Copy link
          </button>
        </div>
      </div>

      <div className="cmp-grid">
        {SIDES.map((k) => (
          <div key={k} className="cmp-side">
            {picking === k || !refs[k] ? (
              <Picker onPick={(ref) => pick(k, ref)} onCancel={refs[k] ? () => setPicking(null) : null} />
            ) : errors[k] ? (
              <div className="processing-panel small">
                <p className="error">{errors[k]}</p>
                <button className="btn" onClick={() => setPicking(k)}>
                  Pick another
                </button>
              </div>
            ) : (
              <>
                <div className={`cmp-video ${audio === k ? 'has-audio' : ''}`} onClick={toggle}>
                  {info[k] ? (
                    <video
                      ref={els[k]}
                      src={info[k].src}
                      poster={info[k].poster || undefined}
                      muted={audio !== k}
                      playsInline
                      preload="auto"
                      onLoadedMetadata={(e) => {
                        e.currentTarget.currentTime = startRef.current[k] + t;
                      }}
                    />
                  ) : (
                    <div className="spinner" />
                  )}
                  <span className="cmp-label">{k.toUpperCase()}</span>
                </div>
                {info[k] && (
                  <div className="cmp-meta">
                    <div className="ellipsis">
                      <Link to={info[k].link}>{info[k].title}</Link>
                      <span className="muted">
                        {' '}
                        · {info[k].by}
                        {info[k].host ? ` · ${info[k].host}` : ''}
                      </span>
                    </div>
                    <button className="btn btn-sm btn-ghost" onClick={() => setPicking(k)}>
                      Change
                    </button>
                  </div>
                )}
                <div className="cmp-align">
                  <span className="muted small">Starts at {formatPrecise(start[k])}</span>
                  <span className="row-actions">
                    <button className="btn btn-sm" onClick={() => nudge(k, -1)} title="Start 1 second earlier">
                      −1s
                    </button>
                    <button className="btn btn-sm" onClick={() => nudge(k, -0.1)} title="Start 0.1 second earlier">
                      −0.1
                    </button>
                    <button className="btn btn-sm" onClick={() => nudge(k, -FRAME)} title="Start one frame earlier">
                      −1f
                    </button>
                    <button className="btn btn-sm" onClick={() => nudge(k, FRAME)} title="Start one frame later">
                      +1f
                    </button>
                    <button className="btn btn-sm" onClick={() => nudge(k, 0.1)} title="Start 0.1 second later">
                      +0.1
                    </button>
                    <button className="btn btn-sm" onClick={() => nudge(k, 1)} title="Start 1 second later">
                      +1s
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className={`cmp-transport ${ready ? '' : 'disabled'}`}>
        <button className="icon-btn" onClick={() => step(-FRAME)} title="Back one frame (,)" disabled={!ready}>
          <Icon name="back" />
        </button>
        <button className="icon-btn cmp-play" onClick={toggle} title="Play / pause (Space)" disabled={!ready}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button className="icon-btn flip" onClick={() => step(FRAME)} title="Forward one frame (.)" disabled={!ready}>
          <Icon name="back" />
        </button>
        <input
          type="range"
          className="cmp-seek"
          min={0}
          max={Math.max(0.01, length)}
          step={0.01}
          value={Math.min(t, length)}
          disabled={!ready}
          onChange={(e) => {
            pause();
            seekAll(Number(e.target.value));
          }}
        />
        <span className="ed-time">
          {formatPrecise(t)} <span className="muted">/ {formatPrecise(length)}</span>
        </span>
        <select className="select select-inline" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Speed">
          {[0.1, 0.25, 0.5, 1].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <select className="select select-inline" value={audio} onChange={(e) => setAudio(e.target.value)} title="Sound">
          <option value="a">Sound from A</option>
          <option value="b">Sound from B</option>
          <option value="off">No sound</option>
        </select>
      </div>
      <p className="hint">
        Line up the same moment with each side's start buttons, then play both together. Space plays and pauses; , and . step one frame.
      </p>
    </div>
  );
}
