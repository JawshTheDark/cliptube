import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { useFeedLink } from '../components/FeedLink.jsx';
import { usePaged, usePref } from '../util.js';
import { LiveNow } from './Live.jsx';

/** "Not interested", "more of this game", "less of this channel" on For-you cards. */
function FeedControls({ video, onHide }) {
  const toast = useToast();
  const k = video.feed_keys;
  if (!k) return null;
  const set = async (kind, target, weight, msg, hide = false) => {
    try {
      await api('/feed/preferences', { method: 'PUT', body: { kind, target, weight } });
      toast(msg);
      if (hide) onHide(video.id);
    } catch (e) {
      toast(e.message);
    }
  };
  return (
    <details className="more-menu card-menu">
      <summary className="icon-btn" title="Tune this feed">
        <Icon name="more" />
      </summary>
      <div className="menu">
        <button className="menu-item" onClick={() => set('video', k.video, -9, "Got it, you won't see this one again", true)}>
          <Icon name="close" /> Not interested
        </button>
        {k.game && (
          <>
            <button className="menu-item" onClick={() => set('game', k.game, 1, `More ${video.game?.name || k.game} from now on`)}>
              <Icon name="thumb_up" /> More {video.game?.name || 'of this game'}
            </button>
            <button className="menu-item" onClick={() => set('game', k.game, -1, `Less ${video.game?.name || k.game} from now on`, true)}>
              <Icon name="thumb_down" /> Less {video.game?.name || 'of this game'}
            </button>
          </>
        )}
        <button className="menu-item" onClick={() => set('channel', k.channel, 1, `More from ${video.uploader.display_name}`)}>
          <Icon name="person" /> More from {video.uploader.display_name}
        </button>
        <button className="menu-item" onClick={() => set('channel', k.channel, -1, `Less from ${video.uploader.display_name}`, true)}>
          <Icon name="person" /> Less from {video.uploader.display_name}
        </button>
      </div>
    </details>
  );
}

export default function Home({ trending = false }) {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') || '';
  const feed = params.get('feed') || 'latest'; // latest | foryou | vertical
  const sort = trending ? 'views' : params.get('sort') || 'new';
  const { user, site } = useAuth();
  const networked = site.federation && (site.network_peers || []).length > 0;
  // In a network, Home mixes in clips from other instances unless "This site" is picked.
  const scope = networked ? params.get('scope') || 'all' : 'local';
  const [tags, setTags] = useState([]);
  // Set under Settings, Watching (kept off the home page so it doesn't break up the feed).
  const [hideVertical] = usePref('hide_vertical');
  const [hideWatched, setHideWatched] = usePref('hide_watched');
  const [hidden, setHidden] = useState(() => new Set());
  useFeedLink('/feeds/videos.atom', site.site_name);

  useEffect(() => {
    api('/videos/tags')
      .then((r) => setTags(r.tags))
      .catch(() => {});
  }, []);

  const forYou = feed === 'foryou' && !!user && !trending;
  const url = useMemo(() => {
    if (forYou) return `/feed/for-you?hide_watched=${hideWatched === 'on' ? 1 : 0}`;
    const shape = feed === 'vertical' ? '&shape=vertical' : hideVertical === 'on' && !tag ? '&shape=landscape' : '';
    return `/videos?sort=${sort}&scope=${scope}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${shape}`;
  }, [forYou, hideWatched, feed, hideVertical, sort, tag, scope]);
  const { items, hasMore, loading, error, loadMore } = usePaged(url);
  const visible = items.filter((v) => !hidden.has(v.id));
  useTitle(trending ? 'Trending' : tag ? `#${tag}` : forYou ? 'For you' : null);

  const chip = (active, label, next) => (
    <button className={`chip ${active ? 'active' : ''}`} onClick={() => setParams(next)}>
      {label}
    </button>
  );

  return (
    <>
      {trending ? (
        <h1 className="page-title">
          <Icon name="trending" /> Trending
        </h1>
      ) : (
        <div className="chips">
          {chip(!tag && feed === 'latest' && sort === 'new' && scope !== 'local', 'All', {})}
          {networked && chip(!tag && feed === 'latest' && scope === 'local' && sort === 'new', 'This site', { scope: 'local' })}
          {user && chip(forYou, 'For you', { feed: 'foryou' })}
          {chip(feed === 'vertical', 'Vertical', networked ? { feed: 'vertical', scope } : { feed: 'vertical' })}
          {chip(!tag && feed === 'latest' && sort === 'top', 'Top rated', networked ? { sort: 'top', scope } : { sort: 'top' })}
          {tags.map((t) => (
            <span key={t.tag}>{chip(tag === t.tag, t.tag, { tag: t.tag })}</span>
          ))}
        </div>
      )}

      {!trending && !tag && <LiveNow />}

      {forYou && (
        <div className="feed-note">
          <span>
            <Icon name="info" /> Picked for you from channels you follow and games and tags you like. Every clip says why. The <b>All</b> tab stays newest-first.
          </span>
          <label className="checkbox">
            <input type="checkbox" checked={hideWatched === 'on'} onChange={(e) => setHideWatched(e.target.checked ? 'on' : 'off')} /> Hide watched
          </label>
        </div>
      )}

      {error && <div className="error page-pad">{error.message}</div>}

      {!loading && visible.length === 0 ? (
        <Empty title={tag ? `No videos tagged #${tag}` : forYou ? 'Nothing picked yet' : feed === 'vertical' ? 'No vertical clips yet' : 'No videos yet'}>
          {site.needs_setup ? (
            <p>
              Create the first account to become the admin and start uploading.
              <br />
              <br />
              <Link to="/register" className="btn btn-primary">
                Get started
              </Link>
            </p>
          ) : forYou ? (
            <p>Like a few clips and subscribe to some channels, and this fills up.</p>
          ) : user ? (
            <p>
              <Link to="/upload" className="btn btn-primary">
                <Icon name="upload" /> Upload a clip
              </Link>
            </p>
          ) : (
            <p>
              <Link to="/login" className="btn btn-outline">
                Sign in
              </Link>{' '}
              to upload the first clip.
            </p>
          )}
        </Empty>
      ) : (
        <VideoGrid videos={visible} renderExtra={forYou ? (v) => <FeedControls video={v} onHide={(id) => setHidden((s) => new Set(s).add(id))} /> : null} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </>
  );
}
