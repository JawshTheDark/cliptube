import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Player } from '../components/Player.jsx';
import { Comments } from '../components/Comments.jsx';
import { VideoCard, Empty } from '../components/VideoCard.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { Description } from './Watch.jsx';
import { ReportButton } from '../components/ReportDialog.jsx';
import { compact, formatDate, copyText } from '../util.js';

/**
 * Watch page for a video hosted on another instance in the network. The file streams straight
 * from its origin; likes, comments and subscriptions are sent to (and stored on) that instance.
 */
export default function RemoteWatch() {
  const { peerId, remoteId } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const videoRef = useRef(null);
  const [data, setData] = useState(null);
  const [channel, setChannel] = useState({ subscriber_count: null });
  const [error, setError] = useState(null);
  const [theater, setTheater] = useState(() => localStorage.getItem('theater') === '1');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    setData(null);
    setError(null);
    setExpanded(false);
    window.scrollTo(0, 0);
    api(`/network/videos/${peerId}/${encodeURIComponent(remoteId)}`)
      .then((r) => {
        if (dead) return;
        setData(r);
        // Count the view on the instance that hosts it (anonymous, like an embed).
        fetch(`${r.video.remote.peer_url}/api/videos/${encodeURIComponent(r.video.remote.remote_id)}/view`, { method: 'POST', mode: 'no-cors' }).catch(() => {});
        api(`/network/channels/${peerId}/${encodeURIComponent(r.video.uploader.username)}`)
          .then((c) => !dead && setChannel(c))
          .catch(() => {});
      })
      .catch((e) => !dead && setError(e));
    return () => {
      dead = true;
    };
  }, [peerId, remoteId]);

  useTitle(data?.video.title);

  const toggleTheater = useCallback(() => {
    setTheater((t) => {
      localStorage.setItem('theater', t ? '0' : '1');
      return !t;
    });
  }, []);

  if (error) {
    return (
      <Empty icon="warning" title="This video isn't available">
        <p>It may have been removed from its instance, or that instance is no longer in the network.</p>
        <Link to="/network" className="btn">
          Back to the network
        </Link>
      </Empty>
    );
  }
  if (!data) return <div className="spinner" />;

  const video = data.video;
  const u = video.uploader;
  const r = video.remote;
  const can = data.interactions;
  const requireLogin = () => nav('/login', { state: { from: `/n/${peerId}/${remoteId}` } });

  const like = async (value) => {
    if (!user) return requireLogin();
    const next = data.my_like === value ? 0 : value;
    setBusy(true);
    try {
      const res = await api(`/network/videos/${peerId}/${encodeURIComponent(remoteId)}/like`, { method: 'POST', body: { value: next } });
      setData((d) => ({ ...d, my_like: res.my_like, video: { ...d.video, likes: res.likes } }));
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSub = async () => {
    if (!user) return requireLogin();
    setBusy(true);
    try {
      const res = await api(`/network/channels/${peerId}/${encodeURIComponent(u.username)}/subscribe`, { method: data.subscribed ? 'DELETE' : 'POST' });
      setData((d) => ({ ...d, subscribed: res.subscribed }));
      if (res.subscriber_count !== null && res.subscriber_count !== undefined) setChannel((c) => ({ ...c, subscriber_count: res.subscriber_count }));
      toast(res.subscribed ? `Subscribed to ${u.display_name}` : 'Subscription removed');
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const hide = async () => {
    const where = data.role === 'hub' ? 'from the whole network' : 'on this site';
    if (!window.confirm(`Hide "${video.title}" ${where}?`)) return;
    try {
      await api(`/admin/network/videos/${peerId}/${encodeURIComponent(remoteId)}`, { method: 'PATCH', body: { hidden: true } });
      toast('Video hidden');
      nav('/network');
    } catch (e) {
      toast(e.message);
    }
  };

  const block = async () => {
    const reason = window.prompt(`Block ${r.peer_name}? Its videos disappear from this site and its people can't like or comment here. Reason (optional):`, '');
    if (reason === null) return;
    try {
      await api(`/admin/network/instances/${peerId}`, { method: 'PATCH', body: { blocked: true, reason } });
      toast(`Blocked ${r.peer_name}`);
      nav('/network');
    } catch (e) {
      toast(e.message);
    }
  };

  const seek = (secs) => {
    const el = videoRef.current;
    if (!el || secs == null) return;
    el.currentTime = secs;
    el.play?.().catch?.(() => {});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className={`watch ${theater ? 'theater' : ''}`}>
      <div className="player-wrap">
        <Player video={video} videoRef={videoRef} theater={theater} onToggleTheater={toggleTheater} />
      </div>

      <div className="watch-body">
        <h1 className="watch-title">{video.title}</h1>
        {video.game && (
          <div className="watch-subline">
            <Link to={`/g/${video.game.id}`} className="game-chip">
              <Icon name="game" /> {video.game.name}
            </Link>
          </div>
        )}
        <div className="watch-row">
          <div className="watch-channel">
            <a href={u.url || r.peer_url} target="_blank" rel="noopener noreferrer">
              <Avatar user={u} size={40} />
            </a>
            <div className="watch-channel-text">
              <a href={u.url || r.peer_url} target="_blank" rel="noopener noreferrer" className="name">
                {u.display_name}
              </a>
              <div className="subs">
                <Icon name="public" className="inline-icon" /> {r.peer_name}
                {channel.subscriber_count !== null && ` · ${compact(channel.subscriber_count)} subscriber${channel.subscriber_count === 1 ? '' : 's'}`}
              </div>
            </div>
            {can.subscriptions && (
              <button className={`btn ${data.subscribed ? '' : 'btn-primary'}`} onClick={toggleSub} disabled={busy}>
                {data.subscribed ? 'Subscribed' : 'Subscribe'}
              </button>
            )}
          </div>
          <div className="watch-actions">
            {can.likes ? (
              <div className="pill-group">
                <button className={`btn ${data.my_like === 1 ? 'active' : ''}`} onClick={() => like(1)} disabled={busy} title="I like this">
                  <Icon name="thumb_up" />
                  {compact(video.likes)}
                </button>
                <button className={`btn ${data.my_like === -1 ? 'active' : ''}`} onClick={() => like(-1)} disabled={busy} title="I dislike this">
                  <Icon name="thumb_down" />
                </button>
              </div>
            ) : (
              <span className="btn" title="Likes between instances are turned off">
                <Icon name="thumb_up" /> {compact(video.likes)}
              </span>
            )}
            <button className="btn" onClick={async () => toast((await copyText(r.watch_url)) ? 'Link copied' : 'Could not copy the link')} title="Copy the link to the original video">
              <Icon name="share" /> Share
            </button>
            <a className="btn btn-icon" href={r.watch_url} target="_blank" rel="noopener noreferrer" title={`Open on ${r.peer_url}`}>
              <Icon name="open" />
            </a>
            <Link className="btn btn-icon" to={`/compare?a=n:${peerId}:${encodeURIComponent(remoteId)}`} title="Compare side by side with another clip">
              <Icon name="compare" />
            </Link>
            <ReportButton target={{ type: 'remote_video', id: `${peerId}:${remoteId}`, label: video.title }} className="btn btn-icon" iconOnly />
            <button className={`btn btn-icon ${theater ? 'active' : ''}`} onClick={toggleTheater} title="Theater mode (t)">
              <Icon name="theater" />
            </button>
            {data.can_moderate && (
              <details className="more-menu">
                <summary className="btn btn-icon" title="Admin">
                  <Icon name="shield" />
                </summary>
                <div className="menu">
                  <button className="menu-item" onClick={hide}>
                    <Icon name="close" /> {data.role === 'hub' ? 'Hide from the network' : 'Hide on this site'}
                  </button>
                  <button className="menu-item" onClick={block}>
                    <Icon name="lock" /> Block {r.peer_name}
                  </button>
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

        <div className="remote-note">
          <Icon name="public" />
          <div>
            Hosted on{' '}
            <a href={r.peer_url} target="_blank" rel="noopener noreferrer">
              {r.peer_name}
            </a>
            . Your likes, comments and subscriptions go to that instance, and its people see them too.{' '}
            <a href={r.watch_url} target="_blank" rel="noopener noreferrer">
              Open the original
            </a>
            .
          </div>
        </div>

        {can.comments ? (
          <Comments
            base={`/network/videos/${peerId}/${encodeURIComponent(remoteId)}`}
            reportTarget={(c) => ({
              type: 'remote_comment',
              id: `${peerId}:${remoteId}:${c.id}`,
              label: `"${c.body.slice(0, 120)}" by @${c.author.username}`,
              extra: { comment_excerpt: c.body.slice(0, 200), comment_author: c.author.username },
            })}
          />
        ) : (
          <p className="muted top-gap">Comments between instances are turned off on this network.</p>
        )}
      </div>

      <aside className="watch-secondary">
        {data.related.length > 0 && <div className="side-heading">More from {r.peer_name}</div>}
        {data.related.map((v) => (
          <VideoCard key={v.id} video={v} variant="compact" />
        ))}
      </aside>
    </div>
  );
}
