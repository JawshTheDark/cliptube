import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { usePaged } from '../util.js';

export function Subscriptions() {
  const [channels, setChannels] = useState(null);
  const { items, hasMore, loading, loadMore } = usePaged('/me/feed');
  useTitle('Subscriptions');

  useEffect(() => {
    api('/me/subscriptions')
      .then((r) => setChannels(r.channels))
      .catch(() => setChannels([]));
  }, []);

  return (
    <>
      <h1 className="page-title">Subscriptions</h1>
      {channels && channels.length > 0 && (
        <div className="channel-row">
          {channels.map((c) => (
            <Link key={c.id} to={`/c/${c.username}`}>
              <Avatar user={c} size={56} />
              <span className="ellipsis">{c.display_name}</span>
            </Link>
          ))}
        </div>
      )}
      {!loading && items.length === 0 ? (
        <Empty icon="subscriptions" title="Don't miss new videos">
          <p>Subscribe to channels and their newest clips show up here.</p>
        </Empty>
      ) : (
        <VideoGrid videos={items} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </>
  );
}

function SimpleList({ title, icon, url, emptyTitle, emptyText, onClear }) {
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  useTitle(title);

  useEffect(() => {
    api(url)
      .then((r) => setVideos(r.videos))
      .catch(setError);
  }, [url]);

  return (
    <>
      <div className="page-title">
        <Icon name={icon} /> {title}
        {onClear && videos?.length > 0 && (
          <button className="btn btn-ghost" onClick={async () => (await onClear()) && setVideos([])}>
            <Icon name="delete" /> Clear all
          </button>
        )}
      </div>
      {error && <div className="error page-pad">{error.message}</div>}
      {videos === null ? <div className="spinner" /> : videos.length === 0 ? (
        <Empty icon={icon} title={emptyTitle}>
          <p>{emptyText}</p>
        </Empty>
      ) : (
        <VideoGrid videos={videos} />
      )}
    </>
  );
}

export function Liked() {
  return <SimpleList title="Liked videos" icon="thumb_up" url="/me/liked" emptyTitle="No liked videos yet" emptyText="Videos you like show up here." />;
}

export function History() {
  const toast = useToast();
  const clear = async () => {
    if (!window.confirm('Clear your entire watch history?')) return false;
    try {
      await api('/me/history', { method: 'DELETE' });
      toast('Watch history cleared');
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  };
  return <SimpleList title="Watch history" icon="history" url="/me/history" emptyTitle="Nothing watched yet" emptyText="Videos you watch show up here, with your place saved so you can pick up where you left off." onClear={clear} />;
}
