import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { TimeField } from './ClipDialog.jsx';
import { SEGMENT_KINDS } from './WatchExtras.jsx';
import { formatPrecise } from '../util.js';

/** Uploader tools on the video details page: captions, skippable segments, community suggestions. */
export function CaptionsManager({ video }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [file, setFile] = useState(null);
  const [lang, setLang] = useState('en');
  const [label, setLabel] = useState('');
  const load = useCallback(() => api(`/videos/${video.id}/captions`).then((r) => setList(r.captions)).catch(() => setList([])), [video.id]);
  useEffect(() => {
    load();
  }, [load]);
  const upload = async (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('lang', lang.trim());
    fd.append('label', label.trim());
    fd.append('file', file);
    try {
      await api(`/videos/${video.id}/captions`, { method: 'POST', body: fd });
      setFile(null);
      setLabel('');
      e.target.reset();
      load();
      toast('Captions added');
    } catch (err) {
      toast(err.message);
    }
  };
  const act = async (c, method, body) => {
    try {
      await api(`/videos/${video.id}/captions/${c.id}`, { method, body });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel manage">
      <h2>
        <Icon name="subtitles" /> Captions
      </h2>
      {list?.map((c) => (
        <div key={c.id} className="manage-row">
          <span className="grow">
            <b>{c.label}</b> <span className="muted">({c.lang})</span>
            {c.status === 'pending' && <span className="badge warn">Suggested{c.submitted_by ? ` by @${c.submitted_by}` : ''}</span>}
          </span>
          <a className="btn btn-sm btn-ghost" href={c.url} target="_blank" rel="noopener noreferrer">
            View
          </a>
          {c.status === 'pending' && (
            <button className="btn btn-sm approve" onClick={() => act(c, 'PATCH', { status: 'published' })}>
              Publish
            </button>
          )}
          <button className="icon-btn" title="Delete" onClick={() => window.confirm(`Delete the ${c.label} captions?`) && act(c, 'DELETE')}>
            <Icon name="delete" />
          </button>
        </div>
      ))}
      {list?.length === 0 && <p className="muted">No captions yet.</p>}
      <form onSubmit={upload} className="field-row align-end top-gap">
        <div className="field grow">
          <label>WebVTT or SRT file</label>
          <input type="file" accept=".vtt,.srt,text/vtt" onChange={(e) => setFile(e.target.files[0] || null)} required />
        </div>
        <div className="field narrow">
          <label>Language</label>
          <input className="input" value={lang} onChange={(e) => setLang(e.target.value)} required />
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="English" />
        </div>
        <div className="field">
          <button className="btn" disabled={!file}>
            Add
          </button>
        </div>
      </form>
    </section>
  );
}

export function SegmentsManager({ video, videoRef }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [kind, setKind] = useState('intro');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(video.duration || 0, 10));
  const load = useCallback(() => api(`/videos/${video.id}/segments`).then((r) => setList(r.segments)).catch(() => setList([])), [video.id]);
  useEffect(() => {
    load();
  }, [load]);
  const clamp = (x) => Math.max(0, Math.min(video.duration || 0, Math.round(x * 10) / 10));
  const now = () => videoRef.current?.currentTime || 0;
  const add = async (e) => {
    e.preventDefault();
    try {
      await api(`/videos/${video.id}/segments`, { method: 'POST', body: { kind, start, end } });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const act = async (s, method, body) => {
    try {
      await api(`/videos/${video.id}/segments/${s.id}`, { method, body });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel manage">
      <h2>
        <Icon name="skip" /> Skippable parts
      </h2>
      <p className="hint">Mark sponsor reads, intros, outros and recaps. Each viewer chooses whether to skip them automatically, get a Skip button, or see them.</p>
      {list?.map((s) => (
        <div key={s.id} className="manage-row">
          <span className="grow">
            <b>{s.label}</b> <span className="muted">{formatPrecise(s.start)} – {formatPrecise(s.end)}</span>
            {s.status === 'pending' && <span className="badge warn">Suggested</span>}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={() => videoRef.current && ((videoRef.current.currentTime = s.start), videoRef.current.play().catch(() => {}))}>
            Play
          </button>
          {s.status === 'pending' && (
            <button className="btn btn-sm approve" onClick={() => act(s, 'PATCH', { status: 'published' })}>
              Accept
            </button>
          )}
          <button className="icon-btn" title="Delete" onClick={() => act(s, 'DELETE')}>
            <Icon name="delete" />
          </button>
        </div>
      ))}
      <form onSubmit={add} className="top-gap">
        <div className="field-row">
          <div className="field">
            <label>Kind</label>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {SEGMENT_KINDS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field" />
        </div>
        <div className="field-row">
          <TimeField label="Start" value={start} onChange={(x) => setStart(clamp(x))} onNow={() => setStart(clamp(now()))} />
          <TimeField label="End" value={end} onChange={(x) => setEnd(clamp(x))} onNow={() => setEnd(clamp(now()))} />
        </div>
        <button className="btn" disabled={end - start < 1}>
          Add part
        </button>
      </form>
    </section>
  );
}

export function SuggestionsManager({ video, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const load = useCallback(() => api(`/videos/${video.id}/suggestions`).then(setData).catch(() => {}), [video.id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data || (!data.titles.length && !data.thumbnails.length)) return null;
  const act = async (url, method, msg) => {
    try {
      setData(await api(url, { method }));
      if (msg) toast(msg);
      onChanged?.();
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel manage">
      <h2>
        <Icon name="edit" /> Community suggestions
      </h2>
      <p className="hint">Titles and thumbnails viewers suggested. Viewers who opt in see the most-voted one; you can use one as your own.</p>
      {data.titles.map((s) => (
        <div key={s.id} className="manage-row">
          <span className="grow">
            {s.title} <span className="muted">· {s.votes} vote{s.votes === 1 ? '' : 's'}</span>
          </span>
          <button className="btn btn-sm" onClick={() => act(`/suggestions/titles/${s.id}/adopt`, 'POST', 'Title updated')}>
            Use this
          </button>
          <button className="icon-btn" title="Remove" onClick={() => act(`/suggestions/titles/${s.id}`, 'DELETE')}>
            <Icon name="delete" />
          </button>
        </div>
      ))}
      <div className="sugg-thumbs">
        {data.thumbnails.map((s) => (
          <div key={s.id} className="sugg-thumb">
            <img src={s.url} alt="" />
            <div className="row-actions">
              <span className="muted small">{s.votes} vote{s.votes === 1 ? '' : 's'}</span>
              <button className="btn btn-sm" onClick={() => act(`/suggestions/thumbnails/${s.id}/adopt`, 'POST', 'Thumbnail updated')}>
                Use this
              </button>
              <button className="icon-btn" title="Remove" onClick={() => act(`/suggestions/thumbnails/${s.id}`, 'DELETE')}>
                <Icon name="delete" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
