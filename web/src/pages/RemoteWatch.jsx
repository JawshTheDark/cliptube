import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Player } from '../components/Player.jsx';
import { VideoCard, Empty } from '../components/VideoCard.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { Description } from './Watch.jsx';
import { compact, formatDate, copyText } from '../util.js';

/** Watch page for a video hosted on a federated instance. The file streams straight from its origin. */
export default function RemoteWatch() {
  const { peerId, remoteId } = useParams();
  const toast = useToast();
  const videoRef = useRef(null);
  const [video, setVideo] = useState(null);
  const [related, setRelated] = useState([]);
  const [error, setError] = useState(null);
  const [theater, setTheater] = useState(() => localStorage.getItem('theater') === '1');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let dead = false;
    setVideo(null);
    setError(null);
    setExpanded(false);
    window.scrollTo(0, 0);
    api(`/network/videos/${peerId}/${encodeURIComponent(remoteId)}`)
      .then((r) => {
        if (dead) return;
        setVideo(r.video);
        setRelated(r.related);
        // Count the view on the instance that hosts it (anonymous, like an embed).
        fetch(`${r.video.remote.peer_url}/api/videos/${encodeURIComponent(r.video.remote.remote_id)}/view`, { method: 'POST', mode: 'no-cors' }).catch(() => {});
      })
      .catch((e) => !dead && setError(e));
    return () => {
      dead = true;
    };
  }, [peerId, remoteId]);

  useTitle(video?.title);

  const toggleTheater = useCallback(() => {
    setTheater((t) => {
      localStorage.setItem('theater', t ? '0' : '1');
      return !t;
    });
  }, []);

  if (error) {
    return (
      <Empty icon="warning" title="This video isn't available">
        <p>It may have been removed from its instance, or this site stopped following that instance.</p>
        <Link to="/network" className="btn">
          Back to the network
        </Link>
      </Empty>
    );
  }
  if (!video) return <div className="spinner" />;

  const u = video.uploader;
  const r = video.remote;
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
        <Player video={{ ...video, id: video.id }} videoRef={videoRef} theater={theater} onToggleTheater={toggleTheater} />
      </div>

      <div className="watch-body">
        <h1 className="watch-title">{video.title}</h1>
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
              </div>
            </div>
          </div>
          <div className="watch-actions">
            <a className="btn" href={r.watch_url} target="_blank" rel="noopener noreferrer" title="Like, comment and subscribe on the instance that hosts this video">
              <Icon name="thumb_up" /> {compact(video.likes)} · Like or comment on {r.peer_name}
            </a>
            <button
              className="btn"
              onClick={async () => toast((await copyText(r.watch_url)) ? 'Link copied' : 'Could not copy the link')}
              title="Copy the link to the original video"
            >
              <Icon name="share" /> Share
            </button>
            <a className="btn btn-icon" href={r.watch_url} target="_blank" rel="noopener noreferrer" title={`Open on ${r.peer_url}`}>
              <Icon name="open" />
            </a>
            <button className={`btn btn-icon ${theater ? 'active' : ''}`} onClick={toggleTheater} title="Theater mode (t)">
              <Icon name="theater" />
            </button>
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
            This clip is hosted on{' '}
            <a href={r.peer_url} target="_blank" rel="noopener noreferrer">
              {r.peer_name}
            </a>{' '}
            and streams from there. Comments, likes and subscriptions live on that instance.{' '}
            <a href={r.watch_url} target="_blank" rel="noopener noreferrer">
              Open the original
            </a>
            .
          </div>
        </div>
      </div>

      <aside className="watch-secondary">
        {related.length > 0 && <div className="side-heading">More from {r.peer_name}</div>}
        {related.map((v) => (
          <VideoCard key={v.id} video={v} variant="compact" />
        ))}
      </aside>
    </div>
  );
}
