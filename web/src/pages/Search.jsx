import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoCard, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { usePaged } from '../util.js';

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const sort = params.get('sort') || 'new';
  const { site } = useAuth();
  const networked = site.federation && (site.network_peers || []).length > 0;
  const scope = networked ? params.get('scope') || 'all' : 'local';
  const url = useMemo(() => `/videos?q=${encodeURIComponent(q)}&sort=${sort}&scope=${scope}`, [q, sort, scope]);
  const { items, hasMore, loading, loadMore } = usePaged(url);
  useTitle(q || 'Search');

  return (
    <div className="results">
      <div className="results-head">
        <h1>Results for “{q}”</h1>
        {networked && (
          <select className="select select-inline" value={scope} onChange={(e) => setParams({ q, sort, scope: e.target.value })} aria-label="Where to search">
            <option value="all">Everywhere</option>
            <option value="local">This site</option>
            <option value="network">Network only</option>
          </select>
        )}
        <select className="select select-inline" value={sort} onChange={(e) => setParams({ q, sort: e.target.value, scope })} aria-label="Sort by">
          <option value="new">Upload date</option>
          <option value="views">View count</option>
          <option value="top">Rating</option>
        </select>
      </div>
      {!loading && items.length === 0 ? (
        <Empty icon="search" title="No results found">
          <p>Try different keywords, or search for a tag or channel name.</p>
        </Empty>
      ) : (
        <div className="list">
          {items.map((v) => (
            <VideoCard key={v.id} video={v} variant="list" />
          ))}
        </div>
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </div>
  );
}
