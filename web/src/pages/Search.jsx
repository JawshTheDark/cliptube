import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoCard, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { loadGames } from '../components/GameField.jsx';
import { usePaged } from '../util.js';

const FILTERS = [
  ['sort', 'Sort', [['', 'Relevance'], ['new', 'Upload date'], ['views', 'View count']]],
  ['duration', 'Length', [['', 'Any length'], ['short', 'Under a minute'], ['medium', '1 to 20 minutes'], ['long', 'Over 20 minutes']]],
  ['date', 'Uploaded', [['', 'Any time'], ['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']]],
  ['shape', 'Shape', [['', 'Any shape'], ['landscape', 'Landscape'], ['vertical', 'Vertical']]],
];

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const { site } = useAuth();
  const [games, setGames] = useState([]);
  const networked = site.federation && (site.network_peers || []).length > 0;
  useEffect(() => {
    loadGames().then(setGames);
  }, []);
  const query = useMemo(() => {
    const p = new URLSearchParams({ q });
    for (const k of ['sort', 'duration', 'date', 'shape', 'game', 'where']) if (params.get(k)) p.set(k, params.get(k));
    return p.toString();
  }, [q, params]);
  const { items, hasMore, loading, error, loadMore } = usePaged(`/search?${query}`);
  useTitle(q || 'Search');
  const set = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  return (
    <div className="results">
      <div className="results-head">
        <h1>{q ? `Results for “${q}”` : 'Search'}</h1>
      </div>
      <div className="search-filters">
        {FILTERS.map(([k, label, opts]) => (
          <select key={k} className="select select-inline" value={params.get(k) || ''} onChange={(e) => set(k, e.target.value)} aria-label={label}>
            {opts.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ))}
        {games.length > 0 && (
          <select className="select select-inline" value={params.get('game') || ''} onChange={(e) => set('game', e.target.value)} aria-label="Game">
            <option value="">Any game</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        {networked && (
          <select className="select select-inline" value={params.get('where') || ''} onChange={(e) => set('where', e.target.value)} aria-label="Where">
            <option value="">Everywhere</option>
            <option value="local">This site</option>
            <option value="network">Other instances</option>
            {(site.network_peers || []).map((p) => (
              <option key={p.id} value={`peer:${p.id}`}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="hint search-hint">Put words in "quotes" to match an exact phrase.</p>
      {error && <div className="error page-pad">{error.message}</div>}
      {!loading && items.length === 0 ? (
        <Empty icon="search" title="No results found">
          <p>Try different words, fewer filters, or search for a game, tag or channel name.</p>
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
