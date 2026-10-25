import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { Empty } from '../components/VideoCard.jsx';
import { formatDate, formatDuration } from '../util.js';

export function VisibilityBadge({ value }) {
  const icon = { public: 'public', unlisted: 'link', private: 'lock' }[value] || 'public';
  return (
    <span className="badge">
      <Icon name={icon} /> {value[0].toUpperCase() + value.slice(1)}
    </span>
  );
}

export function StatusBadge({ video }) {
  if (video.moderation_status) {
    return (
      <span className="badge err" title={video.moderation_reason || ''}>
        <Icon name="gavel" /> {video.moderation_status === 'removed' ? 'Removed' : 'Hidden'} by moderators
      </span>
    );
  }
  if (video.status === 'ready' && (video.render_status === 'queued' || video.render_status === 'rendering')) {
    return <span className="badge warn">Rendering edit {video.render_progress || 0}%</span>;
  }
  if (video.status === 'ready' && video.render_status === 'failed') {
    return (
      <span className="badge err" title={video.render_error || ''}>
        <Icon name="warning" /> Edit failed
      </span>
    );
  }
  switch (video.status) {
    case 'ready':
      return (
        <span className="badge ok">
          <Icon name="check" /> Ready
        </span>
      );
    case 'failed':
      return (
        <span className="badge err" title={video.error || ''}>
          <Icon name="warning" /> Failed
        </span>
      );
    case 'processing':
      return <span className="badge warn">Processing {video.progress}%</span>;
    default:
      return <span className="badge warn">Queued</span>;
  }
}

export default function Studio() {
  const toast = useToast();
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [held, setHeld] = useState(0);
  useTitle('Studio');

  const load = useCallback(() => api('/me/videos').then((r) => setVideos(r.videos)).catch(setError), []);
  useEffect(() => {
    load();
    api('/me/comments/held')
      .then((r) => setHeld(r.comments.length))
      .catch(() => {});
  }, [load]);

  const busy = videos?.some((v) => v.status === 'queued' || v.status === 'processing' || v.render_status === 'queued' || v.render_status === 'rendering');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const del = async (v) => {
    if (!window.confirm(`Delete "${v.title}"?\n\nThis permanently removes the video and its comments.`)) return;
    try {
      await api(`/videos/${v.id}`, { method: 'DELETE' });
      setVideos((list) => list.filter((x) => x.id !== v.id));
      toast('Video deleted');
    } catch (e) {
      toast(e.message);
    }
  };

  const retry = async (v) => {
    try {
      const r = await api(`/videos/${v.id}/retry`, { method: 'POST' });
      setVideos((list) => list.map((x) => (x.id === v.id ? { ...x, ...r.video } : x)));
      toast('Processing restarted');
    } catch (e) {
      toast(e.message);
    }
  };

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>Your videos</h1>
        <div className="row-actions">
          <Link to="/studio/analytics" className="btn btn-ghost">
            <Icon name="chart" /> Analytics
          </Link>
          <Link to="/studio/comments" className="btn btn-ghost">
            <Icon name="comment" /> Comments to review
            {held > 0 && <span className="tab-count">{held}</span>}
          </Link>
          <Link to="/upload" className="btn btn-primary">
            <Icon name="upload" /> Upload
          </Link>
        </div>
      </div>
      {error && <div className="error">{error.message}</div>}
      {videos === null ? (
        <div className="spinner" />
      ) : videos.length === 0 ? (
        <Empty title="No videos yet">
          <p>
            <Link to="/upload" className="btn btn-primary">
              Upload your first clip
            </Link>
          </p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Video</th>
                <th>Visibility</th>
                <th>Status</th>
                <th>Date</th>
                <th>Views</th>
                <th>Likes</th>
                <th>Comments</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {videos.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div className="studio-video">
                      <Link to={v.status === 'ready' ? `/watch/${v.id}` : `/studio/edit/${v.id}`} className="thumb">
                        {v.thumbnail_url ? (
                          <img src={v.thumbnail_url} alt="" />
                        ) : (
                          <div className="thumb-placeholder">
                            <Icon name="video" />
                          </div>
                        )}
                        {v.duration > 0 && <span className="duration">{formatDuration(v.duration)}</span>}
                      </Link>
                      <div className="studio-text">
                        <Link to={`/studio/edit/${v.id}`} className="t">
                          {v.title}
                        </Link>
                        <div className="d">{v.description || 'Add a description'}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {v.draft ? (
                      <Link to={`/studio/edit/${v.id}`} className="badge warn" title="Not published yet: save its details to publish it">
                        Draft
                      </Link>
                    ) : (
                      <VisibilityBadge value={v.visibility} />
                    )}
                  </td>
                  <td>
                    <StatusBadge video={v} />
                  </td>
                  <td>{formatDate(v.created_at)}</td>
                  <td>{v.views.toLocaleString()}</td>
                  <td>{v.likes}</td>
                  <td>{v.comment_count}</td>
                  <td>
                    <div className="row-actions">
                      <Link className="icon-btn" to={`/studio/edit/${v.id}`} title="Edit details">
                        <Icon name="edit" />
                      </Link>
                      <Link className="icon-btn" to={`/studio/analytics/${v.id}`} title="Analytics">
                        <Icon name="chart" />
                      </Link>
                      {v.status === 'ready' && (
                        <Link className="icon-btn" to={`/studio/editor/${v.id}`} title="Open the timeline editor">
                          <Icon name="cut" />
                        </Link>
                      )}
                      {(v.status === 'failed' || v.render_status === 'failed') && (
                        <button className="icon-btn" onClick={() => retry(v)} title="Retry processing">
                          <Icon name="refresh" />
                        </button>
                      )}
                      <button className="icon-btn" onClick={() => del(v)} title="Delete">
                        <Icon name="delete" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
