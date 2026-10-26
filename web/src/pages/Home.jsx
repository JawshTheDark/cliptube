import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoCard, VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
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

/** The newest Shorts in a row of their own, between rows of landscape videos. */
function ShortsShelf({ videos, to }) {
  return (
    <section className="shorts-shelf">
      <div className="shelf-head">
        <h2>
          <Icon name="shorts" /> Shorts
        </h2>
        <Link to={to}>See all</Link>
      </div>
      <div className="shorts-row">
        {videos.map((v) => (
          <VideoCard key={v.id} video={v} variant="short" />
        ))}
      </div>
    </section>
  );
}

const SHELF_AFTER = 8; // landscape videos above the Shorts shelf

export default function Home({ trending = false }) {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') || '';
  const feed = params.get('feed') || 'latest'; // latest | foryou | videos | vertical (Shorts)
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
  // Everything, newest first, keeps Shorts on a shelf of their own instead of in the grid.
  const shelf = !trending && !forYou && !tag && feed === 'latest' && sort === 'new' && hideVertical !== 'on';
  const url = useMemo(() => {
    if (forYou) return `/feed/for-you?hide_watched=${hideWatched === 'on' ? 1 : 0}`;
    const landscape = feed === 'videos' || shelf || (hideVertical === 'on' && !tag);
    const shape = feed === 'vertical' ? '&shape=vertical' : landscape ? '&shape=landscape' : '';
    return `/videos?sort=${sort}&scope=${scope}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${shape}`;
  }, [forYou, hideWatched, feed, hideVertical, sort, tag, scope, shelf]);
  const [shorts, setShorts] = useState([]);
  useEffect(() => {
    if (!shelf) {
      setShorts([]);
      return;
    }
    let dead = false;
    api(`/videos?sort=new&scope=${scope}&shape=vertical&limit=12`)
      .then((r) => !dead && setShorts(r.videos))
      .catch(() => !dead && setShorts([]));
    return () => {
      dead = true;
    };
  }, [shelf, scope]);
  const { items, hasMore, loading, error, loadMore } = usePaged(url);
  const visible = items.filter((v) => !hidden.has(v.id));
  useTitle(trending ? 'Trending' : tag ? `#${tag}` : forYou ? 'For you' : null);

  const chip = (active, label, next) => (
    <button className={`chip ${active ? 'active' : ''}`} onClick={() => setParams(next)}>
      {label}
    </button>
  );

  // Videos or Shorts stays picked while choosing a scope, a sort or a tag.
  const format = forYou ? 'all' : feed === 'videos' ? 'videos' : feed === 'vertical' ? 'shorts' : 'all';
  const keep = format === 'all' ? {} : { feed };
  const local = networked && scope === 'local' ? { scope: 'local' } : {};
  const formatButton = (key, label, next) => (
    <button className={format === key ? 'active' : ''} aria-pressed={format === key} onClick={() => setParams(next)}>
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
          <div className="format-switch" role="group" aria-label="Show">
            {formatButton('all', 'Everything', local)}
            {formatButton('videos', 'Videos', { feed: 'videos', ...local })}
            {formatButton('shorts', 'Shorts', { feed: 'vertical', ...local })}
          </div>
          <span className="chips-divider" />
          {chip(!tag && !forYou && sort === 'new' && (!networked || scope !== 'local'), 'All', keep)}
          {networked && chip(!tag && !forYou && sort === 'new' && scope === 'local', 'This site', { scope: 'local', ...keep })}
          {user && chip(forYou, 'For you', { feed: 'foryou' })}
          {chip(!tag && !forYou && sort === 'top', 'Top rated', networked ? { sort: 'top', scope, ...keep } : { sort: 'top', ...keep })}
          {tags.map((t) => (
            <span key={t.tag}>{chip(tag === t.tag, t.tag, { tag: t.tag, ...keep })}</span>
          ))}
        </div>
      )}

      {!trending && !tag && <LiveNow />}

      {forYou && (
        <div className="feed-note">
          <span>
            <Icon name="info" /> Picked for you from channels you follow and games and tags you like. Every video says why. The <b>All</b> tab stays newest-first.
          </span>
          <label className="checkbox">
            <input type="checkbox" checked={hideWatched === 'on'} onChange={(e) => setHideWatched(e.target.checked ? 'on' : 'off')} /> Hide watched
          </label>
        </div>
      )}

      {error && <div className="error page-pad">{error.message}</div>}

      {!loading && visible.length === 0 && !shorts.length ? (
        <Empty title={tag ? `No videos tagged #${tag}` : forYou ? 'Nothing picked yet' : feed === 'vertical' ? 'No Shorts yet' : 'No videos yet'}>
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
            <p>Like a few videos and subscribe to some channels, and this fills up.</p>
          ) : user ? (
            <p>
              <Link to="/upload" className="btn btn-accent">
                <Icon name="upload" /> Upload a video
              </Link>
            </p>
          ) : (
            <p>
              <Link to="/login" className="btn btn-outline">
                Sign in
              </Link>{' '}
              to upload the first video.
            </p>
          )}
        </Empty>
      ) : format === 'shorts' ? (
        <VideoGrid videos={visible} variant="short" />
      ) : shorts.length ? (
        <>
          <VideoGrid videos={visible.slice(0, SHELF_AFTER)} />
          <ShortsShelf videos={shorts} to={`/?feed=vertical${local.scope ? '&scope=local' : ''}`} />
          {visible.length > SHELF_AFTER && <VideoGrid videos={visible.slice(SHELF_AFTER)} />}
        </>
      ) : (
        <VideoGrid videos={visible} renderExtra={forYou ? (v) => <FeedControls video={v} onHide={(id) => setHidden((s) => new Set(s).add(id))} /> : null} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </>
  );
}
