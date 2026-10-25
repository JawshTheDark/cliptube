import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';
import { compact, formatDuration, timeAgo } from '../util.js';

/**
 * variant: 'grid' (home / channel), 'compact' (watch sidebar), 'list' (search results)
 */
export function VideoCard({ video: v, variant = 'grid', showChannel = true }) {
  const [preview, setPreview] = useState(false);
  const timer = useRef(null);
  const u = v.uploader;

  const enter = () => {
    if (!v.video_url) return;
    timer.current = setTimeout(() => setPreview(true), 650);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setPreview(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const watched = v.position > 5 && v.duration ? Math.min(100, (v.position / v.duration) * 100) : 0;
  const remote = v.remote;
  const watchUrl = remote ? `/n/${remote.peer_id}/${remote.remote_id}` : `/watch/${v.id}`;
  const channelUrl = remote ? u.url || remote.peer_url : `/c/${u.username}`;
  // Remote channels live on their own instance, so link out instead of routing.
  const ChannelLink = ({ className, children }) =>
    remote ? (
      <a href={channelUrl} className={className} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <Link to={channelUrl} className={className}>
        {children}
      </Link>
    );

  return (
    <article className={`card ${variant}`}>
      <Link to={watchUrl} className="thumb" onMouseEnter={enter} onMouseLeave={leave} aria-label={v.title}>
        {v.thumbnail_url ? (
          <img src={v.thumbnail_url} alt="" loading="lazy" />
        ) : (
          <div className="thumb-placeholder">
            <Icon name="video" size={40} />
          </div>
        )}
        {preview && (
          <video
            src={v.video_url}
            ref={(el) => {
              if (el) el.muted = true;
            }}
            muted
            autoPlay
            loop
            playsInline
            preload="none"
          />
        )}
        {v.duration > 0 && <span className="duration">{formatDuration(v.duration)}</span>}
        {watched > 0 && (
          <div className="watched">
            <div style={{ width: `${watched}%` }} />
          </div>
        )}
      </Link>
      <div className="card-body">
        {variant === 'grid' && (
          <ChannelLink className="card-avatar">
            <Avatar user={u} size={36} />
          </ChannelLink>
        )}
        <div className="card-text">
          <Link to={watchUrl} className="card-title" title={v.title}>
            {v.title}
          </Link>
          {variant === 'list' && (
            <div className="card-meta">
              {compact(v.views)} {v.views === 1 ? 'view' : 'views'} • {timeAgo(v.created_at)}
            </div>
          )}
          {showChannel && (
            <ChannelLink className="card-channel">
              {variant === 'list' && <Avatar user={u} size={24} />}
              {u.display_name}
            </ChannelLink>
          )}
          {remote && (
            <span className="card-instance" title={`Hosted on ${remote.peer_url}`}>
              <Icon name="public" /> {remote.peer_name}
            </span>
          )}
          {variant !== 'list' && (
            <div className="card-meta">
              {compact(v.views)} {v.views === 1 ? 'view' : 'views'} • {timeAgo(v.created_at)}
              {v.visibility !== 'public' && <span className="card-badge">{v.visibility}</span>}
            </div>
          )}
          {variant === 'list' && v.description && <div className="card-desc">{v.description}</div>}
        </div>
      </div>
    </article>
  );
}

export function VideoGrid({ videos, showChannel = true }) {
  return (
    <div className="video-grid">
      {videos.map((v) => (
        <VideoCard key={v.id} video={v} showChannel={showChannel} />
      ))}
    </div>
  );
}

/** Invisible sentinel that triggers onMore when scrolled into view. */
export function InfiniteScroll({ hasMore, loading, onMore }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading) onMore();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onMore]);
  return (
    <div ref={ref} className="infinite-sentinel">
      {loading && <div className="spinner" />}
    </div>
  );
}

export function Empty({ icon = 'video', title, children }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}
