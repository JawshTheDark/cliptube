import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { formatBytes, formatPrecise, parseTimestamp } from '../util.js';

const LIMITS = { clip: 600, gif: 15, mp4: 60 };
const MINIMUM = { clip: 1, gif: 0.5, mp4: 0.5 };

/** The `len` seconds that end at `t` (or the first `len` seconds when `t` is near the start). */
export function rangeBefore(t, duration, len = 30) {
  const end = t > 1 ? Math.min(duration, t) : Math.min(duration, len);
  return { start: Math.max(0, end - len), end };
}

export function TimeField({ label, value, onChange, onNow }) {
  const [text, setText] = useState(formatPrecise(value));
  useEffect(() => setText(formatPrecise(value)), [value]);
  const commit = () => {
    const v = parseTimestamp(text.trim());
    if (v === null || !Number.isFinite(v)) setText(formatPrecise(value));
    else onChange(v);
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div className="time-field">
        <button type="button" className="icon-btn" title="Back 0.1s" onClick={() => onChange(value - 0.1)}>
          −
        </button>
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          aria-label={label}
        />
        <button type="button" className="icon-btn" title="Forward 0.1s" onClick={() => onChange(value + 0.1)}>
          +
        </button>
        {onNow && (
          <button type="button" className="btn btn-sm" onClick={onNow} title="Use the current playback position">
            Now
          </button>
        )}
      </div>
    </div>
  );
}

function ExportStatus({ job }) {
  if (job.status === 'failed') return <div className="error">Export failed: {job.error}</div>;
  if (job.status !== 'ready') {
    return (
      <div className="notice">
        Exporting {job.format.toUpperCase()}… {job.progress || 0}%
        <div className="meter">
          <div className="meter-fill" style={{ width: `${job.progress || 0}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="notice clip-ready">
      <span>
        Your {job.format.toUpperCase()} is ready ({formatBytes(job.size_bytes)}). The link works for a day.
      </span>
      <a className="btn btn-primary" href={job.download_url} download>
        <Icon name="download" /> Download
      </a>
    </div>
  );
}

/**
 * Clip a moment: make a new video from a range, or export the range as a GIF or MP4.
 * `from` is "published" (the watch page) or "source" (the editor, which works on the unedited upload).
 */
export function ClipDialog({ video, videoRef, duration, from = 'published', canClip = true, initial, onClose }) {
  const toast = useToast();
  const current = () => videoRef.current?.currentTime || 0;
  const [range, setRange] = useState(() => initial || rangeBefore(current(), duration));
  const [tab, setTab] = useState(canClip ? 'clip' : 'gif');
  const [title, setTitle] = useState(`${video.title} (clip)`.slice(0, 120));
  const [visibility, setVisibility] = useState(video.visibility === 'private' ? 'private' : 'public');
  const [mode, setMode] = useState('exact');
  const [width, setWidth] = useState(480);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [job, setJob] = useState(null);

  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed') return;
    const t = setTimeout(async () => {
      try {
        setJob((await api(`/exports/${job.id}`)).export);
      } catch (e) {
        setJob((j) => ({ ...j, status: 'failed', error: e.message }));
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [job]);

  const clamp = (t) => Math.max(0, Math.min(duration, Math.round(t * 100) / 100));
  const setStart = (t) => setRange((r) => ({ ...r, start: clamp(t) }));
  const setEnd = (t) => setRange((r) => ({ ...r, end: clamp(t) }));
  const len = range.end - range.start;
  const tooLong = len > LIMITS[tab] + 0.01;
  const tooShort = len < MINIMUM[tab];

  const preview = () => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = range.start;
    el.play().catch(() => {});
    const stop = () => {
      if (el.currentTime >= range.end) {
        el.pause();
        el.removeEventListener('timeupdate', stop);
      }
    };
    el.addEventListener('timeupdate', stop);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (tab === 'clip') {
        const r = await api(`/videos/${video.id}/clip`, {
          method: 'POST',
          body: { start: range.start, end: range.end, title, visibility, mode, from: from === 'source' ? 'source' : undefined },
        });
        setMade(r.video);
      } else {
        const r = await api(`/videos/${video.id}/exports`, { method: 'POST', body: { format: tab, start: range.start, end: range.end, width, muted } });
        setJob(r.export);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (t) => {
    setTab(t);
    setJob(null);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal modal-wide clip-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} role="dialog" aria-label="Clip">
        <h2>
          <span>
            <Icon name="cut" /> Clip a moment
          </span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </h2>
        <div className="tabs flat-tabs">
          <button type="button" className={`tab ${tab === 'clip' ? 'active' : ''}`} onClick={() => switchTab('clip')} disabled={!canClip} title={canClip ? '' : "The uploader hasn't allowed clips of this video"}>
            New video
          </button>
          <button type="button" className={`tab ${tab === 'gif' ? 'active' : ''}`} onClick={() => switchTab('gif')} disabled={from === 'source'}>
            GIF
          </button>
          <button type="button" className={`tab ${tab === 'mp4' ? 'active' : ''}`} onClick={() => switchTab('mp4')} disabled={from === 'source'}>
            MP4 download
          </button>
        </div>

        <div className="field-row clip-range">
          <TimeField label="Start" value={range.start} onChange={setStart} onNow={() => setStart(current())} />
          <TimeField label="End" value={range.end} onChange={setEnd} onNow={() => setEnd(current())} />
        </div>
        <div className="clip-quick">
          <span className={tooLong || tooShort ? 'clip-len bad' : 'clip-len'}>{formatPrecise(Math.max(0, len))} long</span>
          {[10, 30, 60].map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setRange(rangeBefore(current(), duration, s))}>
              Last {s}s
            </button>
          ))}
          <button type="button" className="btn btn-sm" onClick={preview}>
            <Icon name="play" /> Preview
          </button>
        </div>
        {tooLong && <div className="error">{tab === 'clip' ? 'Clips' : `${tab.toUpperCase()} exports`} can be up to {LIMITS[tab] >= 60 ? `${LIMITS[tab] / 60} min` : `${LIMITS[tab]} s`} long.</div>}
        {tooShort && <div className="error">Pick at least {MINIMUM[tab]} s.</div>}

        {tab === 'clip' &&
          (made ? (
            <div className="notice clip-ready">
              <span>Your clip is being made. It shows up in your Studio and plays as soon as it's ready.</span>
              <Link className="btn btn-primary" to={`/watch/${made.id}`} onClick={onClose}>
                Open clip
              </Link>
            </div>
          ) : (
            <>
              <div className="field">
                <label>Title</label>
                <input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Visibility</label>
                  <select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    <option value="public">Public</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="private">Private</option>
                  </select>
                </div>
                <div className="field">
                  <label>Cut</label>
                  <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="exact">Exact (re-encodes if needed)</option>
                    <option value="fast">Fast (starts at the nearest keyframe)</option>
                  </select>
                </div>
              </div>
              <p className="hint">
                {mode === 'fast'
                  ? 'Fast clips copy the video without re-encoding, so they keep full quality and are ready almost instantly, but may start a few seconds early.'
                  : 'Exact clips start right where you chose. They are copied without re-encoding when the start falls on a keyframe.'}{' '}
                The clip links back to this video.
              </p>
            </>
          ))}
        {tab === 'gif' && (
          <div className="field">
            <label>Width</label>
            <select className="select" value={width} onChange={(e) => setWidth(Number(e.target.value))}>
              <option value={320}>320 px (smallest)</option>
              <option value={480}>480 px</option>
              <option value={640}>640 px (largest)</option>
            </select>
            <span className="hint">15 frames a second with an optimised palette. Up to 15 seconds.</span>
          </div>
        )}
        {tab === 'mp4' && (
          <label className="checkbox field">
            <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} /> Without sound
            <span className="hint"> · up to 720p and 60 seconds</span>
          </label>
        )}
        {job && <ExportStatus job={job} />}

        <div className="row-actions modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" disabled={busy || tooLong || tooShort || (tab === 'clip' && !!made) || (job && job.status !== 'ready' && job.status !== 'failed')}>
            {tab === 'clip' ? 'Make clip' : `Export ${tab.toUpperCase()}`}
          </button>
        </div>
      </form>
    </div>
  );
}
