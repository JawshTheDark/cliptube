import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { GameField } from '../components/GameField.jsx';
import { Empty } from '../components/VideoCard.jsx';
import { StatusBadge } from './Studio.jsx';
import { copyText, formatBytes, formatDuration, VISIBILITY_HELP } from '../util.js';

export default function EditVideo() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [video, setVideo] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const thumbRef = useRef(null);
  const { site } = useAuth();

  const toForm = (v) => ({
    title: v.title,
    description: v.description,
    tags: v.tags.join(', '),
    visibility: v.visibility,
    federate: v.federate,
    comment_mode: v.comment_mode || 'inherit',
    game: v.game?.name || '',
    allow_clips: !!v.allow_clips,
  });
  const load = useCallback(
    () =>
      api(`/videos/${id}`)
        .then((r) => {
          setVideo(r.video);
          setForm((f) => f || toForm(r.video));
        })
        .catch(setError),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  const status = video?.status === 'ready' && (video?.render_status === 'queued' || video?.render_status === 'rendering') ? 'rendering' : video?.status;
  useEffect(() => {
    if (!status || status === 'ready' || status === 'failed') return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [status, load]);

  useTitle(video ? `Edit · ${video.title}` : 'Edit video');

  if (error) return <Empty icon="warning" title={error.message} />;
  if (!video || !form) return <div className="spinner" />;
  if (!video.can_edit) return <Empty icon="lock" title="You can't edit this video" />;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty =
    form.title !== video.title ||
    form.description !== video.description ||
    form.visibility !== video.visibility ||
    form.tags !== video.tags.join(', ') ||
    form.federate !== video.federate ||
    form.comment_mode !== (video.comment_mode || 'inherit') ||
    form.game !== (video.game?.name || '') ||
    form.allow_clips !== !!video.allow_clips;

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/videos/${id}`, { method: 'PATCH', body: form });
      setVideo(r.video);
      setForm(toForm(r.video));
      toast('Changes saved');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const uploadThumb = async (file) => {
    const fd = new FormData();
    fd.append('thumbnail', file);
    setBusy(true);
    try {
      const r = await api(`/videos/${id}/thumbnail`, { method: 'POST', body: fd });
      setVideo(r.video);
      toast('Thumbnail updated');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!window.confirm(`Delete "${video.title}"?\n\nThis permanently removes the video and its comments.`)) return;
    try {
      await api(`/videos/${id}`, { method: 'DELETE' });
      toast('Video deleted');
      nav('/studio');
    } catch (err) {
      toast(err.message);
    }
  };

  const link = `${window.location.origin}/watch/${video.id}`;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>
          <Link to="/studio" className="icon-btn" title="Back to Studio">
            <Icon name="back" />
          </Link>
          Video details
        </h1>
        <div className="row-actions">
          <Link to={`/watch/${video.id}`} className="btn">
            <Icon name="play" /> View
          </Link>
          {video.status === 'ready' && (
            <Link to={`/studio/editor/${video.id}`} className="btn">
              <Icon name="cut" /> Open editor
            </Link>
          )}
          <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="edit-grid">
        <form onSubmit={save} className="edit-form">
          <div className="field">
            <label>Title (required)</label>
            <input className="input" value={form.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <textarea className="textarea" rows={8} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Tell viewers about your clip. Timestamps like 1:23 become clickable." />
          </div>
          <div className="field">
            <label>Tags</label>
            <input className="input" value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="valorant, ace, clutch" />
            <span className="hint">Separate with commas.</span>
          </div>
          <GameField value={form.game} onChange={(game) => set({ game })} />
          <div className="field">
            <label>Visibility</label>
            <select className="select" value={form.visibility} onChange={(e) => set({ visibility: e.target.value })}>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
            <span className="hint">{VISIBILITY_HELP[form.visibility]}</span>
          </div>
          <div className="field">
            <label>Comments</label>
            <select className="select" value={form.comment_mode} onChange={(e) => set({ comment_mode: e.target.value })}>
              <option value="inherit">Use my default (Settings)</option>
              <option value="open">Publish right away</option>
              <option value="hold_all">Hold all for review</option>
              <option value="off">Turn comments off</option>
            </select>
          </div>
          <label className="checkbox field">
            <input type="checkbox" checked={form.allow_clips} onChange={(e) => set({ allow_clips: e.target.checked })} />
            <span>
              Let others clip this video
              <br />
              <span className="hint">Signed-in viewers can cut their own clips from it, and every clip links back here.</span>
            </span>
          </label>
          {video.source && (
            <p className="hint">
              <Icon name="cut" size={14} /> Clipped from <Link to={`/watch/${video.source.id}`}>{video.source.title || 'another video'}</Link>.
            </p>
          )}
          {site.federation && (
            <label className="checkbox field">
              <input type="checkbox" checked={form.federate} onChange={(e) => set({ federate: e.target.checked })} disabled={form.visibility !== 'public'} />
              <span>
                Share with the network
                <br />
                <span className="hint">Only public videos are shared with other instances. Turn this off to keep a public clip on this site only.</span>
              </span>
            </label>
          )}
          {video.edited && (
            <p className="hint">
              <Icon name="cut" size={14} /> This video has been edited. <Link to={`/studio/editor/${video.id}`}>Open the editor</Link> to change or revert the edit.
            </p>
          )}
        </form>

        <aside className="edit-side">
          <div className="edit-preview">
            {video.status === 'ready' ? (
              <video src={video.video_url} poster={video.thumbnail_url || undefined} controls preload="metadata" />
            ) : (
              <div className="processing-panel small">
                <StatusBadge video={video} />
                {video.error && <p className="error">{video.error}</p>}
              </div>
            )}
            <div className="link-row">
              <span className="muted">Link</span>
              <a href={link}>{link}</a>
              <button className="btn btn-sm" onClick={async () => toast((await copyText(link)) ? 'Link copied' : 'Could not copy')}>
                Copy
              </button>
            </div>
            <div className="kv">
              <span className="muted">Original file</span>
              <span className="ellipsis">{video.original_name || '—'}</span>
            </div>
            <div className="kv">
              <span className="muted">Size</span>
              <span>{formatBytes(video.size_bytes)}</span>
            </div>
            <div className="kv">
              <span className="muted">Resolution</span>
              <span>{video.width && video.height ? `${video.width}×${video.height}` : '—'}</span>
            </div>
            <div className="kv">
              <span className="muted">Duration</span>
              <span>{video.duration ? formatDuration(video.duration) : '—'}</span>
            </div>
          </div>

          <div className="edit-thumb">
            <h3>Thumbnail</h3>
            <div className="thumb">{video.thumbnail_url ? <img src={video.thumbnail_url} alt="" /> : <div className="thumb-placeholder">No thumbnail yet</div>}</div>
            <button className="btn" onClick={() => thumbRef.current.click()} disabled={busy}>
              <Icon name="image" /> Upload custom thumbnail
            </button>
            <input
              ref={thumbRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                if (e.target.files[0]) uploadThumb(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </div>

          <div className="danger-zone">
            <button className="btn btn-danger" onClick={del}>
              <Icon name="delete" /> Delete video
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
