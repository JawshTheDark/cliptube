import { Fragment, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { Icon } from '../components/Icons.jsx';
import { softwareName } from '../components/ServerTag.jsx';
import { usePaged } from '../util.js';

/** Videos from the other instances in this site's network. */
export default function Network() {
  const { site, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const peer = params.get('peer') || '';
  const sort = params.get('sort') || 'new';
  const url = useMemo(() => `/videos?scope=network&sort=${sort}${peer ? `&peer=${peer}` : ''}`, [peer, sort]);
  const { items, hasMore, loading, loadMore } = usePaged(url);
  const net = site.network || {};
  useTitle(net.name || 'Network');

  // OurTube servers in the network first, then the fediverse servers followed from here.
  const all = site.network_peers || [];
  const peers = [...all.filter((p) => p.software === 'ourtube'), ...all.filter((p) => p.software !== 'ourtube')];
  const firstFediverse = peers.find((p) => p.software !== 'ourtube');
  const current = peers.find((p) => String(p.id) === peer);

  if (!site.federation) {
    return (
      <Empty icon="public" title={net.role === 'member' ? 'Waiting for the network' : 'Not part of a network'}>
        <p>
          {net.role === 'member'
            ? "This site has asked to join a network and is waiting for the hub's approval."
            : 'This site is not connected to other OurTube servers.'}
        </p>
        {user?.is_admin && (
          <Link to="/admin/network" className="btn btn-primary">
            Network settings
          </Link>
        )}
      </Empty>
    );
  }

  return (
    <>
      <h1 className="page-title">
        <Icon name="public" /> {net.name || 'Network'}
      </h1>
      <p className="page-sub">
        Videos from the other OurTube servers in the network, and from the fediverse servers and channels followed here. Each one is still
        hosted and streamed by its own server.
      </p>
      {net.announcement && <div className="announce page-pad">{net.announcement}</div>}
      <div className="chips">
        <button className={`chip ${!peer && sort === 'new' ? 'active' : ''}`} onClick={() => setParams({})}>
          All instances
        </button>
        <button className={`chip ${!peer && sort === 'views' ? 'active' : ''}`} onClick={() => setParams({ sort: 'views' })}>
          Most viewed
        </button>
        {peers.map((p) => (
          <Fragment key={p.id}>
            {p === firstFediverse && <span className="chips-label">Fediverse</span>}
            <button
              className={`chip ${peer === String(p.id) ? 'active' : ''}`}
              onClick={() => setParams({ peer: String(p.id) })}
              title={`${p.url}${p.software ? ` (${softwareName(p.software)})` : ''}`}
            >
              {p.name}
            </button>
          </Fragment>
        ))}
      </div>
      {current && (
        <p className="page-sub">
          Showing clips from{' '}
          <a href={current.url} target="_blank" rel="noopener noreferrer">
            {current.url}
          </a>
        </p>
      )}
      {!loading && items.length === 0 ? (
        <Empty icon="public" title="No clips from other instances yet">
          <p>New clips show up here after the next sync.</p>
        </Empty>
      ) : (
        <VideoGrid videos={items} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </>
  );
}
