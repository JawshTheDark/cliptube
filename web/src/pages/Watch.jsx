import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Player } from '../components/Player.jsx';
import { Comments } from '../components/Comments.jsx';
import { VideoCard, Empty } from '../components/VideoCard.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { ReportButton } from '../components/ReportDialog.jsx';
import { compact, formatDate, formatDuration, parseTimestamp, copyText, isAnonymous, timeAgo } from '../util.js';

/** Shown to the uploader and moderators when a video is hidden or removed. */
function ModerationBanner({ video, isOwner }) {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    api(`/videos/${video.id}/moderation`).then(setInfo).catch(() => {});
  }, [video.id, isOwner]);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/videos/${video.id}/counter-notice`, { method: 'POST', body: { statement, contact } });
      toast('Counter-notice sent. An admin will review it.');
      setOpen(false);
      setInfo((i) => ({ ...i, counter_notice: { status: 'pending', created_at: Date.now() } }));
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const removed = video.moderation_status === 'removed';
  const cn = info?.counter_notice;
  return (
    <div className={`mod-banner ${removed ? 'removed' : ''}`}>
      <Icon name="gavel" />
      <div>
        <b>{removed ? 'Removed by the moderators' : 'Hidden by the moderators'}</b>
        {video.moderation_reason && <div>Reason: {video.moderation_reason}</div>}
        <div className="muted">
          {removed
            ? "Nobody can watch it. The file is kept for a while in case the removal was a mistake."
            : 'Only you and the moderators can see it.'}
        </div>
        {isOwner && cn && (
          <div className="muted">
            {removed ? 'Counter-notice' : 'Appeal'} {cn.status === 'pending' ? 'sent' : cn.status} {timeAgo(cn.decided_at || cn.created_at)}.
          </div>
        )}
        {isOwner && (!cn || cn.status === 'rejected') && !open && (
          <button className="btn btn-sm top-gap" onClick={() => setOpen(true)}>
            {removed ? 'This was a mistake: send a counter-notice' : 'Ask the moderators to look again'}
          </button>
        )}
        {open && (
          <form onSubmit={send} className="top-gap">
            <div className="field">
              <label>Why the removal was a mistake</label>
              <textarea
                className="textarea"
                rows={4}
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                placeholder="For example: this is my own recording, or the use is covered by fair use because..."
                required
              />
            </div>
            <div className="field">
              <label>How to reach you</label>
              <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email address" />
            </div>
            <div className="row-actions">
              <button className="btn btn-primary" disabled={busy}>
                Send counter-notice
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Renders description text with clickable URLs and seekable timestamps. */
export function Description({ text, onSeek }) {
  const parts = [];
  const re = /(https?:\/\/[^\s<]+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) {
      const href = m[1];
      parts.push(
        <a key={m.index} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {href}
        </a>,
      );
    } else {
      const ts = m[2];
      parts.push(
        <button
          key={m.index}
          type="button"
          className="ts"
          onClick={(e) => {
            e.stopPropagation();
            onSeek(parseTimestamp(ts));
          }}
        >
          {ts}
        </button>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function ShareDialog({ video, videoRef, onClose }) {
  const toast = useToast();
  const [withTime, setWithTime] = useState(false);
  const [t] = useState(() => Math.floor(videoRef.current?.currentTime || 0));
  const url = `${window.location.origin}/watch/${video.id}${withTime && t > 0 ? `?t=${t}` : ''}`;

  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const copy = async () => {
    const ok = await copyText(url);
    toast(ok ? 'Link copied to clipboard' : 'Could not copy automatically, select the link and copy it');
    if (ok) onClose();
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share">
        <h2>
          Share
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </h2>
        <div className="share-row">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="btn btn-primary" onClick={copy}>
            Copy
          </button>
        </div>
        <label className="share-opts checkbox">
          <input type="checkbox" checked={withTime} onChange={(e) => setWithTime(e.target.checked)} /> Start at {formatDuration(t)}
        </label>
        <p className="hint">
          {video.visibility === 'private'
            ? 'This video is private: only you and admins can open the link.'
            : video.visibility === 'unlisted'
              ? 'This video is unlisted: anyone with the link can watch it, but it is hidden from the site.'
              : 'Paste the link in Discord or Slack and it shows the thumbnail with an inline player.'}
        </p>
      </div>
    </div>
  );
}

function ProcessingPanel({ video }) {
  if (video.status === 'failed') {
    return (
      <div className="processing-panel">
        <Icon name="warning" size={48} />
        <h2>Processing failed</h2>
        <p className="muted">{video.error}</p>
        {video.can_edit && (
          <Link to="/studio" className="btn">
            Open Studio to retry
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className="processing-panel">
      <div className="spinner inline" />
      <h2>{video.status === 'queued' ? 'Waiting in the processing queue' : `Processing ${video.progress}%`}</h2>
      <p className="muted">This page refreshes by itself. You can already share the link; it starts playing as soon as processing finishes.</p>
      <div className="progress">
        <div style={{ width: `${video.progress}%` }} />
      </div>
    </div>
  );
}

export default function Watch() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const videoRef = useRef(null);
  const [video, setVideo] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState(null);
  const [theater, setTheater] = useState(() => localStorage.getItem('theater') === '1');
  const [expanded, setExpanded] = useState(false);
  const [share, setShare] = useState(false);

  useEffect(() => {
    let dead = false;
    setVideo(null);
    setError(null);
    setExpanded(false);
    setRelated([]);
    window.scrollTo(0, 0);
    api(`/videos/${id}`)
      .then((r) => {
        if (dead) return;
        setVideo(r.video);
        return api(`/videos/${id}/view`, { method: 'POST', body: { anonymous: isAnonymous() } }).then((v) => !dead && setVideo((x) => (x ? { ...x, views: v.views } : x)));
      })
      .catch((e) => !dead && setError(e));
    api(`/videos/${id}/related`)
      .then((r) => !dead && setRelated(r.videos))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [id]);

  // Poll while the video is still being processed.
  const status = video?.status;
  useEffect(() => {
    if (!status || status === 'ready' || status === 'failed') return;
    const t = setInterval(() => api(`/videos/${id}`).then((r) => setVideo(r.video)).catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [status, id]);

  useTitle(video?.title);

  const requireLogin = () => nav('/login', { state: { from: `/watch/${id}` } });

  const like = async (value) => {
    if (!user) return requireLogin();
    const next = video.my_like === value ? 0 : value;
    try {
      const r = await api(`/videos/${id}/like`, { method: 'POST', body: { value: next } });
      setVideo((v) => ({ ...v, ...r }));
    } catch (e) {
      toast(e.message);
    }
  };

  const toggleSub = async () => {
    if (!user) return requireLogin();
    try {
      const r = await api(`/users/${video.uploader.username}/subscribe`, { method: video.subscribed ? 'DELETE' : 'POST' });
      setVideo((v) => ({ ...v, subscribed: r.channel.subscribed, uploader: { ...v.uploader, subscriber_count: r.channel.subscriber_count } }));
      toast(r.channel.subscribed ? `Subscribed to ${video.uploader.display_name}` : 'Subscription removed');
    } catch (e) {
      toast(e.message);
    }
  };

  const onProgress = useCallback(
    (pos) => {
      if (!user || isAnonymous()) return;
      api(`/videos/${id}/progress`, { method: 'POST', body: { position: pos } }).catch(() => {});
    },
    [id, user],
  );

  const moderate = async (action) => {
    const reason = action === 'restore' ? '' : window.prompt(`Reason to ${action} this video (shown to the uploader):`, '');
    if (reason === null) return;
    try {
      await api(`/mod/videos/${id}`, { method: 'POST', body: { action, reason } });
      const r = await api(`/videos/${id}`);
      setVideo(r.video);
      toast(action === 'restore' ? 'Video restored' : `Video ${action === 'hide' ? 'hidden' : 'removed'}`);
    } catch (e) {
      toast(e.message);
    }
  };

  const toggleTheater = useCallback(() => {
    setTheater((t) => {
      localStorage.setItem('theater', t ? '0' : '1');
      return !t;
    });
  }, []);

  const seek = (secs) => {
    const el = videoRef.current;
    if (!el || secs == null) return;
    el.currentTime = secs;
    el.play?.().catch?.(() => {});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (error) {
    return (
      <Empty icon="warning" title={error.status === 404 ? "This video isn't available" : error.message}>
        <p>It may be private, or it may have been deleted.</p>
        <Link to="/" className="btn">
          Back to home
        </Link>
      </Empty>
    );
  }
  if (!video) return <div className="spinner" />;

  const u = video.uploader;
  const isOwner = user?.id === u.id;
  const startAt = Number(params.get('t')) || video.resume_at || 0;

  return (
    <div className={`watch ${theater ? 'theater' : ''}`}>
      <div className="player-wrap">
        {video.status === 'ready' && video.video_url ? (
          <Player video={video} videoRef={videoRef} startAt={startAt} onProgress={onProgress} theater={theater} onToggleTheater={toggleTheater} />
        ) : video.status === 'ready' ? (
          <div className="player">
            <div className="processing-panel">
              <Icon name="gavel" size={48} />
              <h2>This video was removed</h2>
              <p className="muted">{video.moderation_reason || 'It broke the rules of this site.'}</p>
            </div>
          </div>
        ) : (
          <div className="player">
            <ProcessingPanel video={video} />
          </div>
        )}
      </div>

      <div className="watch-body">
        {video.moderation_status && <ModerationBanner video={video} isOwner={isOwner} onChanged={(v) => setVideo(v)} />}
        <h1 className="watch-title">{video.title}</h1>
        <div className="watch-row">
          <div className="watch-channel">
            <Link to={`/c/${u.username}`}>
              <Avatar user={u} size={40} />
            </Link>
            <div className="watch-channel-text">
              <Link to={`/c/${u.username}`} className="name">
                {u.display_name}
              </Link>
              <div className="subs">
                {compact(u.subscriber_count)} {u.subscriber_count === 1 ? 'subscriber' : 'subscribers'}
              </div>
            </div>
            {isOwner ? (
              <>
                <Link to={`/studio/edit/${video.id}`} className="btn">
                  <Icon name="edit" /> Details
                </Link>
                {video.status === 'ready' && (
                  <Link to={`/studio/editor/${video.id}`} className="btn">
                    <Icon name="cut" /> Editor
                  </Link>
                )}
              </>
            ) : (
              <button className={`btn ${video.subscribed ? '' : 'btn-primary'}`} onClick={toggleSub}>
                {video.subscribed ? 'Subscribed' : 'Subscribe'}
              </button>
            )}
          </div>
          <div className="watch-actions">
            <div className="pill-group">
              <button className={`btn ${video.my_like === 1 ? 'active' : ''}`} onClick={() => like(1)} title="I like this">
                <Icon name="thumb_up" />
                {compact(video.likes)}
              </button>
              <button className={`btn ${video.my_like === -1 ? 'active' : ''}`} onClick={() => like(-1)} title="I dislike this">
                <Icon name="thumb_down" />
              </button>
            </div>
            <button className="btn" onClick={() => setShare(true)}>
              <Icon name="share" /> Share
            </button>
            {video.video_url && (
              <a className="btn" href={`${video.video_url}${video.video_url.includes('?') ? '&' : '?'}download`}>
                <Icon name="download" /> Download
              </a>
            )}
            <button className={`btn btn-icon ${theater ? 'active' : ''}`} onClick={toggleTheater} title="Theater mode (t)">
              <Icon name="theater" />
            </button>
            {video.can_edit && !isOwner && (
              <Link to={`/studio/edit/${video.id}`} className="btn">
                <Icon name="edit" /> Edit
              </Link>
            )}
            {!isOwner && <ReportButton target={{ type: 'video', id: video.id, label: video.title }} className="btn btn-icon" iconOnly />}
            {video.can_moderate && (
              <details className="more-menu">
                <summary className="btn btn-icon" title="Moderator tools">
                  <Icon name="gavel" />
                </summary>
                <div className="menu">
                  {video.moderation_status ? (
                    <button className="menu-item" onClick={() => moderate('restore')}>
                      <Icon name="check" /> Restore video
                    </button>
                  ) : (
                    <button className="menu-item" onClick={() => moderate('hide')}>
                      <Icon name="lock" /> Hide from everyone else
                    </button>
                  )}
                  {video.moderation_status !== 'removed' && (
                    <button className="menu-item" onClick={() => moderate('remove')}>
                      <Icon name="delete" /> Remove (rule or copyright violation)
                    </button>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>

        <div className={`watch-desc ${expanded ? 'expanded' : ''}`} onClick={() => !expanded && setExpanded(true)}>
          <div className="desc-meta">
            <span>{video.views.toLocaleString()} views</span>
            <span>{formatDate(video.created_at)}</span>
            {video.tags.map((t) => (
              <Link key={t} to={`/?tag=${encodeURIComponent(t)}`} className="desc-tag" onClick={(e) => e.stopPropagation()}>
                #{t}
              </Link>
            ))}
          </div>
          <div className="desc-text">
            {video.description ? <Description text={video.description} onSeek={seek} /> : <span className="muted">No description</span>}
          </div>
          {expanded && (
            <p className="desc-legal muted">
              Something wrong with this video?{' '}
              <Link to="/legal" onClick={(e) => e.stopPropagation()}>
                Rules, copyright and contact
              </Link>
            </p>
          )}
          <button
            className="expand"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => !x);
            }}
          >
            {expanded ? 'Show less' : '...more'}
          </button>
        </div>

        <Comments
          base={`/videos/${video.id}`}
          initialCount={video.comment_count}
          isOwner={isOwner}
          reportTarget={(c) => ({ type: 'comment', id: c.id, label: `"${c.body.slice(0, 120)}" by @${c.author.username}` })}
        />
      </div>

      <aside className="watch-secondary">
        {related.map((v) => (
          <VideoCard key={v.id} video={v} variant="compact" />
        ))}
        {related.length === 0 && <p className="muted side-note">More clips will show up here as they get uploaded.</p>}
      </aside>

      {share && <ShareDialog video={video} videoRef={videoRef} onClose={() => setShare(false)} />}
    </div>
  );
}
