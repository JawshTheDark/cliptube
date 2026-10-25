import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, uploadWithProgress } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { GameField } from '../components/GameField.jsx';
import { formatBytes, copyText, VISIBILITY_HELP } from '../util.js';

const VIDEO_RE = /\.(mp4|mkv|mov|webm|avi|m4v|ts|wmv|flv|mpg|mpeg|3gp|mts|m2ts)$/i;

function titleFromFilename(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export default function Upload() {
  const { site } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const nextKey = useRef(1);
  const itemsRef = useRef(items);
  const aborters = useRef({});
  itemsRef.current = items;
  useTitle('Upload');

  const update = useCallback((key, patch) => {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)));
  }, []);

  const addFiles = (files) => {
    const accepted = [];
    const rejected = [];
    for (const f of Array.from(files)) (VIDEO_RE.test(f.name) ? accepted : rejected).push(f);
    if (rejected.length) toast(`Skipped ${rejected.length} file${rejected.length > 1 ? 's' : ''} that ${rejected.length > 1 ? 'are' : 'is'} not a video`);
    const tooBig = accepted.filter((f) => f.size > site.max_upload_mb * 1024 * 1024);
    if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(', ')} exceeds the ${site.max_upload_mb} MB limit`);
    const ok = accepted.filter((f) => !tooBig.includes(f));
    setItems((list) => [
      ...list,
      ...ok.map((file) => ({
        key: nextKey.current++,
        file,
        title: titleFromFilename(file.name) || 'Untitled clip',
        description: '',
        tags: '',
        visibility: 'public',
        game: '',
        allow_clips: false,
        progress: 0,
        status: 'waiting', // waiting | uploading | processing | ready | failed
        video: null,
        error: null,
        dirty: false,
        saving: false,
      })),
    ]);
  };

  const saveDetails = useCallback(
    async (key) => {
      const it = itemsRef.current.find((x) => x.key === key);
      if (!it?.video) return;
      update(key, { saving: true });
      try {
        const { video } = await api(`/videos/${it.video.id}`, {
          method: 'PATCH',
          body: { title: it.title, description: it.description, tags: it.tags, visibility: it.visibility, game: it.game, allow_clips: it.allow_clips },
        });
        update(key, { video, dirty: false, saving: false });
        toast('Details saved');
      } catch (e) {
        update(key, { saving: false });
        toast(e.message);
      }
    },
    [update, toast],
  );

  const startUpload = useCallback(
    (key) => {
      const it = itemsRef.current.find((x) => x.key === key);
      if (!it) return;
      const fd = new FormData();
      fd.append('title', it.title);
      fd.append('description', it.description);
      fd.append('tags', it.tags);
      fd.append('visibility', it.visibility);
      fd.append('game', it.game);
      fd.append('allow_clips', it.allow_clips ? 'true' : 'false');
      fd.append('file', it.file);
      update(key, { status: 'uploading', progress: 0, error: null });
      const { promise, abort } = uploadWithProgress('/videos', fd, (loaded, total) => update(key, { progress: Math.round((loaded / total) * 100) }));
      aborters.current[key] = abort;
      promise
        .then(async ({ video }) => {
          update(key, { status: video.status === 'ready' ? 'ready' : 'processing', video, progress: 100 });
          const cur = itemsRef.current.find((x) => x.key === key);
          if (cur?.dirty) await saveDetails(key);
        })
        .catch((e) => update(key, { status: 'failed', error: e.message }))
        .finally(() => delete aborters.current[key]);
    },
    [update, saveDetails],
  );

  // Upload one file at a time.
  useEffect(() => {
    if (items.some((it) => it.status === 'uploading')) return;
    const next = items.find((it) => it.status === 'waiting');
    if (next) startUpload(next.key);
  }, [items, startUpload]);

  // Poll processing status.
  const pending = items.some((it) => it.video && (it.status === 'processing' || it.status === 'queued'));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      for (const it of itemsRef.current) {
        if (!it.video || it.status === 'ready' || it.status === 'failed' || it.status === 'uploading') continue;
        try {
          const { video } = await api(`/videos/${it.video.id}`);
          update(it.key, { video, status: video.status === 'ready' ? 'ready' : video.status === 'failed' ? 'failed' : 'processing', error: video.error });
        } catch {
          /* ignore transient errors */
        }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [pending, update]);

  // Warn before leaving mid-upload.
  const uploading = items.some((it) => it.status === 'uploading' || it.status === 'waiting');
  useEffect(() => {
    if (!uploading) return;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [uploading]);

  const cancel = (key) => {
    aborters.current[key]?.();
    setItems((list) => list.filter((it) => it.key !== key));
  };
  const remove = (key) => setItems((list) => list.filter((it) => it.key !== key));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Upload videos</h1>
        {items.length > 0 && (
          <button className="btn" onClick={() => inputRef.current.click()}>
            <Icon name="add" /> Add more
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mkv,.ts,.m2ts,.mts"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {items.length === 0 && (
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <div className="big-icon">
            <Icon name="upload" />
          </div>
          <h2>Drag and drop video files to upload</h2>
          <p>Your clips start uploading right away. You can fill in the details while they upload.</p>
          <button className="btn btn-primary" type="button">
            Select files
          </button>
          <p className="hint">MP4, MKV, MOV, WEBM and most other formats. Up to {site.max_upload_mb.toLocaleString()} MB per file.</p>
        </div>
      )}

      {items.map((it) => (
        <UploadItem key={it.key} it={it} onChange={(patch) => update(it.key, { ...patch, dirty: true })} onSave={() => saveDetails(it.key)} onCancel={() => cancel(it.key)} onRemove={() => remove(it.key)} />
      ))}

      {items.length > 0 && items.every((it) => it.status === 'ready' || it.status === 'failed') && (
        <p className="muted center">
          All done. <Link to="/studio">Open Studio</Link> to manage your videos.
        </p>
      )}
    </div>
  );
}

function UploadItem({ it, onChange, onSave, onCancel, onRemove }) {
  const toast = useToast();
  const v = it.video;
  const link = v ? `${window.location.origin}/watch/${v.id}` : null;

  let statusText;
  let pct = it.progress;
  let barClass = '';
  switch (it.status) {
    case 'waiting':
      statusText = 'Waiting to upload…';
      pct = 0;
      break;
    case 'uploading':
      statusText = `Uploading ${it.progress}%`;
      break;
    case 'processing':
      statusText = v?.status === 'queued' ? 'Queued for processing…' : `Processing ${v?.progress ?? 0}%`;
      pct = v?.progress ?? 0;
      break;
    case 'ready':
      statusText = 'Ready to watch';
      pct = 100;
      barClass = 'done';
      break;
    default:
      statusText = 'Failed';
      pct = 100;
      barClass = 'failed';
  }

  return (
    <div className="upload-item">
      <div className="upload-form">
        <div className="field">
          <label>Title (required)</label>
          <input className="input" value={it.title} maxLength={120} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea className="textarea" value={it.description} rows={4} placeholder="Tell viewers about your clip" onChange={(e) => onChange({ description: e.target.value })} />
        </div>
        <div className="field">
          <label>Tags</label>
          <input className="input" value={it.tags} placeholder="valorant, ace, clutch" onChange={(e) => onChange({ tags: e.target.value })} />
          <span className="hint">Separate tags with commas. Tags become the filter chips on the home page.</span>
        </div>
        <GameField value={it.game} onChange={(game) => onChange({ game })} />
        <div className="field">
          <label>Visibility</label>
          <select className="select" value={it.visibility} onChange={(e) => onChange({ visibility: e.target.value })}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
          <span className="hint">{VISIBILITY_HELP[it.visibility]}</span>
        </div>
        <label className="checkbox field">
          <input type="checkbox" checked={it.allow_clips} onChange={(e) => onChange({ allow_clips: e.target.checked })} />
          <span>
            Let others clip this video
            <br />
            <span className="hint">Signed-in viewers can cut their own clips from it. Clips link back here.</span>
          </span>
        </label>
        <div className="row-actions">
          <button className="btn btn-primary" disabled={!v || !it.dirty || it.saving} onClick={onSave}>
            {it.saving ? 'Saving…' : v ? (it.dirty ? 'Save details' : 'Saved') : 'Save details'}
          </button>
          {!v && it.dirty && <span className="hint">Changes are applied when the upload finishes.</span>}
          {v && (
            <Link to={`/watch/${v.id}`} className="btn">
              View
            </Link>
          )}
          {(it.status === 'uploading' || it.status === 'waiting') && (
            <button className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          {(it.status === 'ready' || it.status === 'failed') && (
            <button className="btn btn-ghost" onClick={onRemove}>
              Remove from list
            </button>
          )}
        </div>
      </div>
      <div className="upload-status">
        <div className="thumbbox">
          {v?.thumbnail_url ? <img src={v.thumbnail_url} alt="" /> : <Icon name={it.status === 'failed' ? 'warning' : 'video'} size={40} />}
        </div>
        <div className="status-line">
          <span>{statusText}</span>
          <span>{formatBytes(it.file.size)}</span>
        </div>
        <div className={`progress ${barClass}`}>
          <div style={{ width: `${pct}%` }} />
        </div>
        {it.error && <div className="error">{it.error}</div>}
        {link && (
          <div className="link-row">
            <span className="muted">Link</span>
            <a href={link}>{link}</a>
            <button
              className="btn btn-sm"
              onClick={async () => {
                toast((await copyText(link)) ? 'Link copied' : 'Could not copy');
              }}
            >
              Copy
            </button>
          </div>
        )}
        <div className="kv">
          <span className="muted">File</span>
          <span className="ellipsis" title={it.file.name}>
            {it.file.name}
          </span>
        </div>
      </div>
    </div>
  );
}
