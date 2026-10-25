import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { useToast } from '../components/Toast.jsx';
import { plural, formatDate, usePaged } from '../util.js';
import { ReportButton } from '../components/ReportDialog.jsx';
import { SupportLinks } from '../components/WatchExtras.jsx';
import { FeedButton } from '../components/FeedLink.jsx';
import { FediverseHandles } from '../components/Fediverse.jsx';

const SORTS = [
  ['new', 'Latest'],
  ['views', 'Popular'],
  ['old', 'Oldest'],
];

export default function Channel() {
  const { username } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [channel, setChannel] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('videos');
  const [sort, setSort] = useState('new');

  useEffect(() => {
    let dead = false;
    setChannel(null);
    setError(null);
    api(`/users/${encodeURIComponent(username)}`)
      .then((r) => !dead && setChannel(r.channel))
      .catch((e) => !dead && setError(e));
    return () => {
      dead = true;
    };
  }, [username, user?.id]);

  const url = useMemo(() => `/users/${encodeURIComponent(username)}/videos?sort=${sort}`, [username, sort]);
  const { items, hasMore, loading, loadMore } = usePaged(url);
  useTitle(channel?.display_name);

  if (error) return <Empty icon="person" title="This channel doesn't exist" />;
  if (!channel) return <div className="spinner" />;

  const toggleSub = async () => {
    if (!user) return nav('/login', { state: { from: `/c/${username}` } });
    try {
      const r = await api(`/users/${encodeURIComponent(username)}/subscribe`, { method: channel.subscribed ? 'DELETE' : 'POST' });
      setChannel(r.channel);
      toast(r.channel.subscribed ? `Subscribed to ${r.channel.display_name}` : 'Subscription removed');
    } catch (e) {
      toast(e.message);
    }
  };

  return (
    <div className="channel">
      <div className="channel-banner" />
      <div className="channel-head">
        <Avatar user={channel} size={160} className="channel-avatar" />
        <div className="channel-info">
          <h1>{channel.display_name}</h1>
          <div className="meta">
            <span>@{channel.username}</span>
            <span>•</span>
            <span>{plural(channel.subscriber_count, 'subscriber')}</span>
            <span>•</span>
            <span>{plural(channel.video_count, 'video')}</span>
            <span>•</span>
            <span>{plural(channel.total_views, 'view')}</span>
          </div>
          {channel.bio && <p className="bio">{channel.bio}</p>}
          <div className="actions">
            {channel.is_self ? (
              <>
                <Link to="/settings" className="btn">
                  Customize channel
                </Link>
                <Link to="/studio" className="btn">
                  Manage videos
                </Link>
              </>
            ) : (
              <>
                <button className={`btn ${channel.subscribed ? '' : 'btn-primary'}`} onClick={toggleSub}>
                  {channel.subscribed ? 'Subscribed' : 'Subscribe'}
                </button>
                <ReportButton target={{ type: 'user', id: channel.id, label: `@${channel.username}` }} className="btn btn-icon" iconOnly />
              </>
            )}
            <SupportLinks links={channel.support_links} />
            <FeedButton href={`/feeds/channel/${channel.username}.atom`} title={`${channel.display_name} videos`} />
          </div>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'videos' ? 'active' : ''}`} onClick={() => setTab('videos')}>
          Videos
        </button>
        <button className={`tab ${tab === 'about' ? 'active' : ''}`} onClick={() => setTab('about')}>
          About
        </button>
      </div>

      {tab === 'videos' ? (
        <>
          <div className="chips">
            {SORTS.map(([k, label]) => (
              <button key={k} className={`chip ${sort === k ? 'active' : ''}`} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
          </div>
          {!loading && items.length === 0 ? (
            <Empty title="No videos yet">
              {channel.is_self && (
                <p>
                  <Link to="/upload" className="btn btn-primary">
                    Upload a clip
                  </Link>
                </p>
              )}
            </Empty>
          ) : (
            <VideoGrid videos={items} showChannel={false} />
          )}
          <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
        </>
      ) : (
        <div className="page about">
          <h2>Description</h2>
          <p className="pre">{channel.bio || 'Nothing here yet.'}</p>
          {channel.support_links?.length > 0 && (
            <>
              <h2>Support</h2>
              {channel.support_links.map((l) => (
                <p key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer nofollow">
                    {l.label}
                  </a>{' '}
                  <span className="muted small">{new URL(l.url).hostname}</span>
                </p>
              ))}
            </>
          )}
          <FediverseHandles username={channel.username} />
          <h2>Stats</h2>
          <p>Joined {formatDate(channel.created_at)}</p>
          <p>{channel.total_views.toLocaleString()} views</p>
          <p>{plural(channel.video_count, 'video')}</p>
        </div>
      )}
    </div>
  );
}
