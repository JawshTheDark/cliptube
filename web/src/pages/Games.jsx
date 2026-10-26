import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { Empty, InfiniteScroll, VideoGrid } from '../components/VideoCard.jsx';
import { plural, usePaged } from '../util.js';
import { FeedButton } from '../components/FeedLink.jsx';

function Cover({ game, size = 'md' }) {
  if (game.artwork_url) return <img className={`game-cover ${size}`} src={game.artwork_url} alt="" loading="lazy" />;
  // No cover: the title logo on a plain tile, or the short name.
  return (
    <div className={`game-cover ${size} placeholder`}>
      {game.logo_url ? <img className="game-cover-logo" src={game.logo_url} alt="" loading="lazy" /> : <span>{(game.short_name || game.name).slice(0, 4)}</span>}
    </div>
  );
}

/** "Artwork from SteamGridDB by …", with the artists' names. */
function ArtCredit({ game }) {
  const c = game.credits;
  if (!c) return null;
  const authors = [...new Set(Object.values(c).map((x) => x?.author).filter(Boolean))];
  if (!Object.values(c).some((x) => x?.source === 'SteamGridDB')) return null;
  return (
    <p className="hint small art-credit">
      Artwork from{' '}
      <a href={game.sgdb_id ? `https://www.steamgriddb.com/game/${game.sgdb_id}` : 'https://www.steamgriddb.com'} target="_blank" rel="noopener noreferrer">
        SteamGridDB
      </a>
      {authors.length ? ` by ${authors.join(', ')}` : ''}
    </p>
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
          <p>Moderators add games, and videos can then be filed under them.</p>
        </Empty>
      ) : (
        <div className="game-grid">
          {games.map((g) => (
            <Link key={g.id} to={`/g/${g.id}`} className="game-tile">
              <Cover game={g} />
              <div className="game-tile-name">{g.name}</div>
              <div className="muted small">{plural(g.video_count + g.network_count, 'video')}</div>
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
      <div className={`game-head ${game.hero_url ? 'with-hero' : ''}`} style={game.hero_url ? { '--hero': `url("${game.hero_url}")` } : undefined}>
        <Cover game={game} size="lg" />
        <div className="game-head-text">
          <h1>
            {game.logo_url ? (
              <>
                <img className="game-logo" src={game.logo_url} alt="" />
                <span className="sr-only">{game.name}</span>
              </>
            ) : (
              game.name
            )}{' '}
            {!game.remote_only && <FeedButton href={`/feeds/game/${game.id}.atom`} title={`${game.name} videos`} />}
          </h1>
          <div className="muted">
            {plural(total, 'video')}
            {site.federation && game.network_count > 0 && ` · ${game.network_count} from other servers`}
          </div>
          {game.remote_only && <p className="hint">This game comes from other servers in the network.</p>}
          <ArtCredit game={game} />
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
        <Empty icon="game" title="No videos yet">
          <p>Pick this game when you upload a video.</p>
        </Empty>
      ) : (
        <VideoGrid videos={items} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </div>
  );
}
