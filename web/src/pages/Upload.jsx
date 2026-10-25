import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, sendInPieces } from '../api.js';
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
        uploadId: null, // the upload in pieces, to resume after a failure
        retrying: false,
        video: null,
        error: null,
        dirty: false,
        saving: false,
      })),
    ]);
  };

  // Saving the details is what publishes a clip; until then it waits as a draft only you can see.
  const saveDetails = useCallback(
    async (key, { publish = true } = {}) => {
      const it = itemsRef.current.find((x) => x.key === key);
      if (!it?.video) return;
      update(key, { saving: true });
      try {
        const { video } = await api(`/videos/${it.video.id}`, {
          method: 'PATCH',
          body: { title: it.title, description: it.description, tags: it.tags, visibility: it.visibility, game: it.game, allow_clips: it.allow_clips, publish },
        });
        update(key, { video, dirty: false, saving: false });
        if (publish) toast(it.visibility === 'private' ? 'Details saved' : 'Details saved and published');
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
      update(key, { status: 'uploading', error: null, retrying: false });
      // In pieces, so proxies that cap a request's size let it through and a dropped connection only costs a piece.
      const send = sendInPieces(it.file, {
        resume: it.uploadId,
        onStart: (uploadId) => update(key, { uploadId }),
        onProgress: (sent, total) => update(key, { progress: Math.floor((sent / total) * 100) }),
        onRetry: (n) => update(key, { retrying: n > 0 }),
      });
      aborters.current[key] = send.abort;
      send.promise
        .then((uploadId) => {
          const cur = itemsRef.current.find((x) => x.key === key) || it;
          return api('/videos', {
            method: 'POST',
            body: { upload_id: uploadId, title: cur.title, description: cur.description, tags: cur.tags, visibility: cur.visibility, game: cur.game, allow_clips: cur.allow_clips, draft: true },
          });
        })
        .then(async ({ video }) => {
          update(key, { status: video.status === 'ready' ? 'ready' : 'processing', video, progress: 100, uploadId: null });
          // Details typed during the upload are kept, but the clip stays a draft until Save details.
          const cur = itemsRef.current.find((x) => x.key === key);
          if (cur?.dirty) await saveDetails(key, { publish: false });
        })
        .catch((e) => update(key, { status: 'failed', error: e.message, retrying: false }))
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
  const remove = (key) => {
    const it = itemsRef.current.find((x) => x.key === key);
    if (it?.uploadId && !it.video) api(`/uploads/${it.uploadId}`, { method: 'DELETE' }).catch(() => {});
    setItems((list) => list.filter((x) => x.key !== key));
  };

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
        <UploadItem
          key={it.key}
          it={it}
          onChange={(patch) => update(it.key, { ...patch, dirty: true })}
          onSave={() => saveDetails(it.key)}
          onCancel={() => cancel(it.key)}
          onRemove={() => remove(it.key)}
          onRetry={() => update(it.key, { status: 'waiting', error: null })}
        />
      ))}

      {items.length > 0 && items.every((it) => it.status === 'ready' || it.status === 'failed') && (
        <p className="muted center">
          {items.some((it) => it.video?.draft) ? (
            <>Click Save details on each clip to publish it.</>
          ) : (
            <>
              All done. <Link to="/studio">Open Studio</Link> to manage your videos.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function UploadItem({ it, onChange, onSave, onCancel, onRemove, onRetry }) {
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
      statusText = it.retrying ? `Connection lost at ${it.progress}%, trying again…` : `Uploading ${it.progress}%`;
      break;
    case 'processing':
      statusText = v?.status === 'queued' ? 'Queued for processing…' : `Processing ${v?.progress ?? 0}%`;
      pct = v?.progress ?? 0;
      break;
    case 'ready':
      statusText = v?.draft ? 'Ready, not published yet' : 'Ready to watch';
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
          <button className="btn btn-primary" disabled={!v || (!it.dirty && !v.draft) || it.saving} onClick={onSave}>
            {it.saving ? 'Saving…' : v && !it.dirty && !v.draft ? 'Saved' : 'Save details'}
          </button>
          {(!v || v.draft) && <span className="hint">Nothing is published until you click Save details.</span>}
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
          {it.status === 'failed' && !v && (
            <button className="btn" onClick={onRetry}>
              Try again
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
