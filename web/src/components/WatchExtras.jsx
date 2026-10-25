import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { TimeField } from './ClipDialog.jsx';
import { formatBytes } from '../util.js';

export const SEGMENT_KINDS = [
  ['sponsor', 'Sponsor'],
  ['intro', 'Intro'],
  ['outro', 'Outro'],
  ['recap', 'Recap'],
  ['selfpromo', 'Self-promotion'],
];

function useEscape(onClose) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
}

function Modal({ title, onClose, children, wide = false }) {
  useEscape(onClose);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h2>
          {title}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </h2>
        {children}
      </div>
    </div>
  );
}

/** "Support" button with the uploader's tip and support links. */
export function SupportLinks({ links }) {
  if (!links?.length) return null;
  return (
    <details className="more-menu">
      <summary className="btn" title="Support this channel">
        <Icon name="heart" /> Support
      </summary>
      <div className="menu">
        {links.map((l) => (
          <a key={l.url} className="menu-item" href={l.url} target="_blank" rel="noopener noreferrer nofollow">
            <Icon name="open" /> {l.label}
          </a>
        ))}
      </div>
    </details>
  );
}

/** Download: the processed MP4, and the original file when the viewer may have it. */
export function DownloadMenu({ video }) {
  if (!video.video_url) return null;
  const mp4 = `${video.video_url}${video.video_url.includes('?') ? '&' : '?'}download`;
  const o = video.original_download;
  if (!o) {
    return (
      <a className="btn" href={mp4}>
        <Icon name="download" /> Download
      </a>
    );
  }
  return (
    <details className="more-menu">
      <summary className="btn">
        <Icon name="download" /> Download
      </summary>
      <div className="menu">
        <a className="menu-item" href={mp4}>
          <Icon name="video" /> MP4 for any player
        </a>
        <a className="menu-item" href={o.url}>
          <Icon name="download" /> {o.upload ? 'Original upload' : 'Full quality'} ({formatBytes(o.size)})
        </a>
      </div>
    </details>
  );
}

function CaptionDialog({ video, onClose }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [lang, setLang] = useState('en');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('lang', lang.trim());
    fd.append('label', label.trim());
    fd.append('file', file);
    setBusy(true);
    try {
      const r = await api(`/videos/${video.id}/captions`, { method: 'POST', body: fd });
      toast(r.caption.status === 'published' ? 'Captions added' : 'Thanks! The uploader reviews captions before they appear.');
      onClose();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add captions" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="hint">Upload a WebVTT (.vtt) or SubRip (.srt) file. Captions are written by people, never generated or machine-translated here.</p>
        <div className="field">
          <label>File</label>
          <input type="file" accept=".vtt,.srt,text/vtt" onChange={(e) => setFile(e.target.files[0] || null)} required />
        </div>
        <div className="field-row">
          <div className="field">
            <label>Language code</label>
            <input className="input" value={lang} onChange={(e) => setLang(e.target.value)} placeholder="en, es, pt-BR" required />
          </div>
          <div className="field">
            <label>Name in the menu</label>
            <input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="English" />
          </div>
        </div>
        <div className="row-actions modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !file}>
            Upload
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SegmentDialog({ video, videoRef, onClose }) {
  const toast = useToast();
  const t = videoRef.current?.currentTime || 0;
  const [kind, setKind] = useState('sponsor');
  const [start, setStart] = useState(Math.max(0, Math.round(t * 10) / 10));
  const [end, setEnd] = useState(Math.min(video.duration, Math.round((t + 10) * 10) / 10));
  const [busy, setBusy] = useState(false);
  const clamp = (x) => Math.max(0, Math.min(video.duration, Math.round(x * 10) / 10));
  const now = () => videoRef.current?.currentTime || 0;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/videos/${video.id}/segments`, { method: 'POST', body: { kind, start, end } });
      toast(r.segment.status === 'published' ? 'Segment added' : 'Thanks! The uploader reviews suggestions before they apply.');
      onClose();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Mark a skippable part" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label>What is it?</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {SEGMENT_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <TimeField label="Start" value={start} onChange={(x) => setStart(clamp(x))} onNow={() => setStart(clamp(now()))} />
          <TimeField label="End" value={end} onChange={(x) => setEnd(clamp(x))} onNow={() => setEnd(clamp(now()))} />
        </div>
        <p className="hint">Viewers choose in Settings whether marked parts are skipped automatically, offered as a Skip button, or left alone.</p>
        <div className="row-actions modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || end - start < 1}>
            {video.can_edit ? 'Add' : 'Suggest'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Community titles and thumbnails: suggest, vote, and (for the uploader) adopt. */
export function SuggestDialog({ video, videoRef, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/videos/${video.id}/suggestions`).then(setData).catch((e) => toast(e.message));
  }, [video.id, toast]);
  const run = async (fn, msg) => {
    setBusy(true);
    try {
      const r = await fn();
      setData(r);
      if (msg) toast(msg);
      return r;
    } catch (err) {
      toast(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const adopt = async (kind, id) => {
    if (await run(() => api(`/suggestions/${kind}/${id}/adopt`, { method: 'POST' }), 'Updated your video')) onChanged?.();
  };
  return (
    <Modal title="Better title or thumbnail" onClose={onClose} wide>
      <p className="hint">
        Suggest a plainer title or a frame that shows what really happens. Viewers who turn on community titles in Settings see the most-voted
        suggestion{data?.can_adopt ? '; you can also use one as the real title or thumbnail' : ''}.
      </p>
      <form
        className="follow-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api(`/videos/${video.id}/suggestions/titles`, { method: 'POST', body: { title } }), 'Title suggested').then((r) => r && setTitle(''));
        }}
      >
        <input className="input" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="A plainer title" aria-label="Suggested title" />
        <button className="btn" disabled={busy || title.trim().length < 3}>
          Suggest
        </button>
      </form>
      <button
        className="btn btn-sm top-gap"
        disabled={busy}
        onClick={() => run(() => api(`/videos/${video.id}/suggestions/thumbnails`, { method: 'POST', body: { time: videoRef.current?.currentTime || 0 } }), 'Frame suggested')}
      >
        <Icon name="image" /> Suggest the current frame as the thumbnail
      </button>
      {!data ? (
        <div className="spinner" />
      ) : (
        <>
          {data.titles.length > 0 && <h3 className="sub-h">Titles</h3>}
          {data.titles.map((s) => (
            <div key={s.id} className="sugg-row">
              <button className={`btn btn-sm ${s.voted ? 'active' : ''}`} disabled={busy} onClick={() => run(() => api(`/suggestions/titles/${s.id}/vote`, { method: 'POST' }))} title="Vote">
                <Icon name="thumb_up" /> {s.votes}
              </button>
              <span className="grow">{s.title}</span>
              {data.can_adopt && (
                <button className="btn btn-sm" disabled={busy} onClick={() => adopt('titles', s.id)}>
                  Use this
                </button>
              )}
            </div>
          ))}
          {data.thumbnails.length > 0 && <h3 className="sub-h">Thumbnails</h3>}
          <div className="sugg-thumbs">
            {data.thumbnails.map((s) => (
              <div key={s.id} className="sugg-thumb">
                <img src={s.url} alt="" />
                <div className="row-actions">
                  <button className={`btn btn-sm ${s.voted ? 'active' : ''}`} disabled={busy} onClick={() => run(() => api(`/suggestions/thumbnails/${s.id}/vote`, { method: 'POST' }))}>
                    <Icon name="thumb_up" /> {s.votes}
                  </button>
                  {data.can_adopt && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => adopt('thumbnails', s.id)}>
                      Use this
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/** "..." menu on the watch page: add captions, mark a skippable part, suggest a title or thumbnail. */
export function ContributeMenu({ video, videoRef, onChanged }) {
  const [open, setOpen] = useState(null);
  return (
    <>
      <details className="more-menu">
        <summary className="btn btn-icon" title="More">
          <Icon name="more" />
        </summary>
        <div className="menu">
          <button className="menu-item" onClick={() => setOpen('captions')}>
            <Icon name="subtitles" /> Add captions
          </button>
          <button className="menu-item" onClick={() => setOpen('segment')}>
            <Icon name="skip" /> Mark a skippable part
          </button>
          <button className="menu-item" onClick={() => setOpen('suggest')}>
            <Icon name="edit" /> Suggest a title or thumbnail
          </button>
        </div>
      </details>
      {open === 'captions' && <CaptionDialog video={video} onClose={() => setOpen(null)} />}
      {open === 'segment' && <SegmentDialog video={video} videoRef={videoRef} onClose={() => setOpen(null)} />}
      {open === 'suggest' && <SuggestDialog video={video} videoRef={videoRef} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </>
  );
}
