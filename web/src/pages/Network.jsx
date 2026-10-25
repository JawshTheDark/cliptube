import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth, useTitle } from '../auth.jsx';
import { VideoGrid, InfiniteScroll, Empty } from '../components/VideoCard.jsx';
import { Icon } from '../components/Icons.jsx';
import { usePaged } from '../util.js';

/** Videos from federated instances this site follows. */
export default function Network() {
  const { site, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const peer = params.get('peer') || '';
  const sort = params.get('sort') || 'new';
  const url = useMemo(() => `/videos?scope=network&sort=${sort}${peer ? `&peer=${peer}` : ''}`, [peer, sort]);
  const { items, hasMore, loading, loadMore } = usePaged(url);
  useTitle('Network');

  const peers = site.network_peers || [];
  const current = peers.find((p) => String(p.id) === peer);

  if (!site.federation) {
    return (
      <Empty icon="public" title="Federation is turned off">
        <p>This site is not connected to other ClipTube instances.</p>
        {user?.is_admin && (
          <Link to="/admin/federation" className="btn btn-primary">
            Set up federation
          </Link>
        )}
      </Empty>
    );
  }

  return (
    <>
      <h1 className="page-title">
        <Icon name="public" /> Network
      </h1>
      <p className="page-sub">
        Clips from other ClipTube instances. Each one is still hosted and streamed by its own server.
      </p>
      <div className="chips">
        <button className={`chip ${!peer && sort === 'new' ? 'active' : ''}`} onClick={() => setParams({})}>
          All instances
        </button>
        <button className={`chip ${!peer && sort === 'views' ? 'active' : ''}`} onClick={() => setParams({ sort: 'views' })}>
          Most viewed
        </button>
        {peers.map((p) => (
          <button key={p.id} className={`chip ${peer === String(p.id) ? 'active' : ''}`} onClick={() => setParams({ peer: String(p.id) })} title={p.url}>
            {p.name}
          </button>
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
        <Empty icon="public" title={peers.length ? 'No clips from the network yet' : 'Not following any instances yet'}>
          {peers.length ? (
            <p>New clips show up here after the next sync, every ten minutes.</p>
          ) : user?.is_admin ? (
            <Link to="/admin/federation" className="btn btn-primary">
              Follow an instance
            </Link>
          ) : (
            <p>Ask the admin to connect this site to other instances.</p>
          )}
        </Empty>
      ) : (
        <VideoGrid videos={items} />
      )}
      <InfiniteScroll hasMore={hasMore} loading={loading} onMore={loadMore} />
    </>
  );
}
