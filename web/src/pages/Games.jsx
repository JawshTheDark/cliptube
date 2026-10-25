import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { Empty, InfiniteScroll, VideoGrid } from '../components/VideoCard.jsx';
import { plural, usePaged } from '../util.js';
import { FeedButton } from '../components/FeedLink.jsx';

function Cover({ game, size = 'md' }) {
  return game.artwork_url ? (
    <img className={`game-cover ${size}`} src={game.artwork_url} alt="" loading="lazy" />
  ) : (
    <div className={`game-cover ${size} placeholder`}>
      <span>{(game.short_name || game.name).slice(0, 4)}</span>
    </div>
  );
}

export function Games() {
  const { user } = useAuth();
  const [games, setGames] = useState(null);
  useTitle('Games');
  useEffect(() => {
    api('/games')
      .then((r) => setGames(r.games))
      .catch(() => setGames([]));
  }, []);
  if (!games) return <div className="spinner" />;
  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>
          <Icon name="game" /> Games
        </h1>
        {user?.is_moderator && (
          <Link to="/admin/games" className="btn">
            Manage games
          </Link>
        )}
      </div>
      {games.length === 0 ? (
        <Empty icon="game" title="No games yet">
          <p>Moderators add games, and clips can then be filed under them.</p>
        </Empty>
      ) : (
        <div className="game-grid">
          {games.map((g) => (
            <Link key={g.id} to={`/g/${g.id}`} className="game-tile">
              <Cover game={g} />
              <div className="game-tile-name">{g.name}</div>
              <div className="muted small">{plural(g.video_count + g.network_count, 'clip')}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function GamePage() {
  const { id } = useParams();
  const { site } = useAuth();
  const [game, setGame] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState('new');
  const scope = site.federation ? 'all' : 'local';
  const { items, hasMore, loading, loadMore } = usePaged(`/videos?game=${encodeURIComponent(id)}&scope=${scope}&sort=${sort}`);
  useTitle(game?.name || 'Game');
  useEffect(() => {
    setGame(null);
    setError(null);
    api(`/games/${encodeURIComponent(id)}`)
      .then((r) => setGame(r.game))
      .catch(setError);
  }, [id]);
  if (error) return <Empty icon="warning" title="Game not found" />;
  if (!game) return <div className="spinner" />;
  const total = game.video_count + (site.federation ? game.network_count : 0);
  return (
    <div className="page page-wide">
      <div className="game-head">
        <Cover game={game} size="lg" />
        <div>
          <h1>
            {game.name} {!game.remote_only && <FeedButton href={`/feeds/game/${game.id}.atom`} title={`${game.name} clips`} />}
          </h1>
          <div className="muted">
            {plural(total, 'clip')}
            {site.federation && game.network_count > 0 && ` · ${game.network_count} from other instances`}
          </div>
          {game.remote_only && <p className="hint">This game comes from other instances in the network.</p>}
          <div className="chips flat top-gap">
            {[
              ['new', 'Newest'],
              ['views', 'Most viewed'],
              ['top', 'Top rated'],
            ].map(([k, label]) => (
              <button key={k} className={`chip ${sort === k ? 'active' : ''}`} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!loading && items.length === 0 ? (
        <Empty icon="game" title="No clips yet">
          <p>Pick this game when you upload a clip.</p>
        </Empty>
      ) : (
        <VideoGrid videos={items} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </div>
  );
}
