import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { Icon } from '../components/Icons.jsx';
import { usePaged } from '../util.js';

export default function Home({ trending = false }) {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag') || '';
  const sort = trending ? 'views' : params.get('sort') || 'new';
  const { user, site } = useAuth();
  const networked = site.federation && (site.network_peers || []).length > 0;
  // In a network, Home mixes in clips from other instances unless "This site" is picked.
  const scope = networked ? params.get('scope') || 'all' : 'local';
  const [tags, setTags] = useState([]);

  useEffect(() => {
    api('/videos/tags')
      .then((r) => setTags(r.tags))
      .catch(() => {});
  }, []);

  const url = useMemo(() => `/videos?sort=${sort}&scope=${scope}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`, [sort, tag, scope]);
  const { items, hasMore, loading, error, loadMore } = usePaged(url);
  useTitle(trending ? 'Trending' : tag ? `#${tag}` : null);

  return (
    <>
      {trending ? (
        <h1 className="page-title">
          <Icon name="trending" /> Trending
        </h1>
      ) : (
        <div className="chips">
          <button className={`chip ${!tag && sort === 'new' && scope !== 'local' ? 'active' : ''}`} onClick={() => setParams({})}>
            All
          </button>
          {networked && (
            <button className={`chip ${!tag && scope === 'local' && sort === 'new' ? 'active' : ''}`} onClick={() => setParams({ scope: 'local' })}>
              This site
            </button>
          )}
          <button className={`chip ${!tag && sort === 'top' ? 'active' : ''}`} onClick={() => setParams(networked ? { sort: 'top', scope } : { sort: 'top' })}>
            Top rated
          </button>
          {tags.map((t) => (
            <button key={t.tag} className={`chip ${tag === t.tag ? 'active' : ''}`} onClick={() => setParams({ tag: t.tag })}>
              {t.tag}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error page-pad">{error.message}</div>}

      {!loading && items.length === 0 ? (
        <Empty title={tag ? `No videos tagged #${tag}` : 'No videos yet'}>
          {site.needs_setup ? (
            <p>
              Create the first account to become the admin and start uploading.
              <br />
              <br />
              <Link to="/register" className="btn btn-primary">
                Get started
              </Link>
            </p>
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
        <VideoGrid videos={items} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </>
  );
}
