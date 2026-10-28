import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { copyText } from '../util.js';

/** A channel's fediverse handles, for following it from Mastodon, PeerTube and friends. */
export function FediverseHandles({ username }) {
  const { site } = useAuth();
  const toast = useToast();
  if (!site.activitypub || !site.ap_host) return null;
  const handles = [
    [`@${username}_channel@${site.ap_host}`, 'Channel (PeerTube, Mastodon)'],
    [`@${username}@${site.ap_host}`, 'Account'],
  ];
  return (
    <div className="fedi-handles">
      <h2>On the fediverse</h2>
      <p className="hint">Follow from Mastodon, PeerTube or any other fediverse app by searching for one of these:</p>
      {handles.map(([h, label]) => (
        <div key={h} className="fedi-handle">
          <code>{h}</code>
          <span className="muted small">{label}</span>
          <button className="icon-btn" title="Copy" onClick={async () => toast((await copyText(h)) ? 'Copied' : h)}>
            <Icon name="link" />
          </button>
        </div>
      ))}
      <RemoteFollow handle={handles[1][0]} />
      <p className="hint small">
        <Link to="/help/fediverse">Following from Mastodon and PeerTube</Link>
      </p>
    </div>
  );
}

const SERVER_KEY = 'cliptube.fediverse_server';

/** "Follow from your own server": opens the follow page on the viewer's Mastodon (or similar) server. */
function RemoteFollow({ handle }) {
  const [server, setServer] = useState(() => {
    try {
      return localStorage.getItem(SERVER_KEY) || '';
    } catch {
      return '';
    }
  });
  const go = (e) => {
    e.preventDefault();
    const host = server.trim().replace(/^https?:\/\//, '').replace(/^@?[^@\s]+@/, '').replace(/\/.*$/, '');
    if (!host) return;
    try {
      localStorage.setItem(SERVER_KEY, host);
    } catch {}
    window.open(`https://${host}/authorize_interaction?uri=${encodeURIComponent(handle)}`, '_blank', 'noopener');
  };
  return (
    <form className="follow-form top-gap" onSubmit={go}>
      <input className="input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="Your server, like mastodon.social" aria-label="Your fediverse server" />
      <button className="btn" disabled={!server.trim()}>
        Follow from there
      </button>
    </form>
  );
}

const STATUS = { pending: ['warn', 'Waiting for them to accept'], accepted: ['ok', 'Following'], rejected: ['err', 'They declined'] };

/** Follow fediverse channels and accounts by handle or link; their videos join your subscriptions. */
export function FediverseFollow() {
  const { site } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get('follow') || '');
  const [preview, setPreview] = useState(null);
  const [follows, setFollows] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/fediverse/follows').then((r) => setFollows(r.follows)).catch(() => setFollows([]));
  const find = async (query) => {
    setBusy(true);
    setPreview(null);
    try {
      setPreview((await api(`/fediverse/lookup?q=${encodeURIComponent(query.trim())}`)).actor);
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (site.activitypub) load();
  }, [site.activitypub]);
  // Arriving from a "Follow" button on another fediverse server (/authorize_interaction).
  useEffect(() => {
    const incoming = params.get('follow');
    if (!site.activitypub || !incoming) return;
    find(incoming);
    params.delete('follow');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.activitypub]);
  if (!site.activitypub) return null;
  const lookup = (e) => {
    e.preventDefault();
    find(q);
  };
  const follow = async (handle) => {
    setBusy(true);
    try {
      await api('/fediverse/follow', { method: 'POST', body: { handle } });
      toast('Follow request sent');
      setPreview(null);
      setQ('');
      load();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const unfollow = async (a) => {
    if (!window.confirm(`Stop following ${a.handle}?`)) return;
    try {
      await api('/fediverse/follow', { method: 'DELETE', body: { actor: a.id } });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel fedi-follow">
      <h2>
        <Icon name="public" /> Follow from the fediverse
      </h2>
      <p className="hint">PeerTube channels and Mastodon accounts: their new videos show up in your subscriptions, and you can like and comment on them here.</p>
      <form className="follow-form" onSubmit={lookup}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="@channel@peertube.example or a link" aria-label="Handle or link" />
        <button className="btn" disabled={busy || !q.trim()}>
          Look up
        </button>
      </form>
      {preview && (
        <div className="fedi-preview">
          <Avatar user={{ display_name: preview.name, avatar_url: preview.icon_url }} size={48} />
          <div className="grow">
            <div className="fed-name">{preview.name}</div>
            <div className="muted small">
              {preview.handle} · {preview.type === 'Group' ? 'Channel' : preview.type === 'Person' ? 'Account' : preview.type}
            </div>
          </div>
          {preview.status ? (
            <span className={`badge ${STATUS[preview.status]?.[0] || ''}`}>{STATUS[preview.status]?.[1]}</span>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => follow(preview.id)}>
              Follow
            </button>
          )}
        </div>
      )}
      {follows?.length > 0 && (
        <div className="fed-list top-gap">
          {follows.map((a) => (
            <div key={a.id} className="fed-item">
              <Avatar user={{ display_name: a.name, avatar_url: a.icon_url }} size={32} />
              <div className="fed-main">
                <div className="fed-name">
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.name}
                  </a>
                  <span className={`badge ${STATUS[a.status]?.[0] || ''}`}>{STATUS[a.status]?.[1] || a.status}</span>
                </div>
                <div className="fed-sub">{a.handle}</div>
              </div>
              <button className="icon-btn" title="Unfollow" onClick={() => unfollow(a)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Admin: ActivityPub on or off, and following whole servers (the way PeerTube servers mirror each other). */
// PeerTube's video categories, which servers in its directory list as their topics.
const PEERTUBE_TOPICS = [
  [7, 'Gaming'], [12, 'How to'], [15, 'Science & tech'], [9, 'Comedy'], [2, 'Films'], [6, 'Travel'], [1, 'Music'], [4, 'Art'],
  [13, 'Education'], [16, 'Animals'], [18, 'Food'], [5, 'Sports'], [3, 'Vehicles'], [10, 'Entertainment'], [8, 'People'],
  [17, 'Kids'], [11, 'News & politics'], [14, 'Activism'],
];
const TOPIC_NAME = Object.fromEntries(PEERTUBE_TOPICS);
const DIRECTORY_LANGUAGES = [['', 'Any language'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese']];

/** Finds PeerTube servers in joinpeertube.org's directory and follows them, a click each. */
function PeerTubeDirectory({ enabled, onFollowed }) {
  const toast = useToast();
  const [filters, setFilters] = useState({ search: '', language: 'en', categories: [], sort: '-totalLocalVideos', nsfw: false });
  const [search, setSearch] = useState('');
  const [result, setResult] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    const q = new URLSearchParams({ page: String(page), sort: filters.sort, language: filters.language, search: filters.search, categories: filters.categories.join(',') });
    if (filters.nsfw) q.set('nsfw', 'show');
    api(`/admin/fediverse/directory?${q}`)
      .then((r) => !dead && setResult((prev) => (page > 1 && prev ? { ...r, servers: [...prev.servers, ...r.servers] } : r)))
      .catch((e) => !dead && toast(e.message))
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
    };
  }, [filters, page, toast]);

  const set = (patch) => {
    setPage(1);
    setFilters((f) => ({ ...f, ...patch }));
  };
  const toggleTopic = (id) => set({ categories: filters.categories.includes(id) ? filters.categories.filter((c) => c !== id) : [...filters.categories, id] });
  const follow = async (srv) => {
    setBusy(srv.host);
    try {
      onFollowed(await api('/admin/fediverse/follow', { method: 'POST', body: { server: srv.host } }));
      setResult((r) => ({ ...r, servers: r.servers.map((x) => (x.host === srv.host ? { ...x, following: 'pending' } : x)) }));
      toast(`Asked to follow ${srv.name}`);
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pt-directory top-gap">
      <form
        className="follow-form"
        onSubmit={(e) => {
          e.preventDefault();
          set({ search: search.trim() });
        }}
      >
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search servers by name or description" aria-label="Search servers" />
        <button className="btn">Search</button>
      </form>
      <div className="pt-filters">
        <select className="select select-inline" value={filters.language} onChange={(e) => set({ language: e.target.value })} aria-label="Language">
          {DIRECTORY_LANGUAGES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select className="select select-inline" value={filters.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
          <option value="-totalLocalVideos">Most videos</option>
          <option value="-totalInstanceFollowers">Most followed</option>
          <option value="-totalUsers">Most people</option>
          <option value="-createdAt">Newest</option>
        </select>
        <label className="check-row">
          <input type="checkbox" checked={filters.nsfw} onChange={(e) => set({ nsfw: e.target.checked })} /> Include servers that show NSFW
        </label>
      </div>
      <div className="pt-topics">
        {PEERTUBE_TOPICS.map(([id, label]) => (
          <button key={id} type="button" className={`chip ${filters.categories.includes(id) ? 'active' : ''}`} onClick={() => toggleTopic(id)}>
            {label}
          </button>
        ))}
      </div>
      {result && (
        <p className="hint">
          {result.total.toLocaleString()} {result.total === 1 ? 'server' : 'servers'} in the directory match. Videos marked sensitive stay out either way.
        </p>
      )}
      <div className="pt-list">
        {result?.servers.map((srv) => (
          <div key={srv.host} className="pt-server">
            {srv.avatar_url ? <img className="pt-avatar" src={srv.avatar_url} alt="" loading="lazy" /> : <span className="pt-avatar pt-avatar-empty" />}
            <div className="pt-main">
              <div className="pt-name">
                <b>{srv.name}</b>{' '}
                <a href={`https://${srv.host}`} target="_blank" rel="noopener noreferrer" className="muted">
                  {srv.host}
                </a>
              </div>
              {srv.description && <div className="pt-desc">{srv.description}</div>}
              <div className="pt-meta muted">
                {srv.videos.toLocaleString()} videos
                {srv.languages.length > 0 && ` · ${srv.languages.join(', ')}`}
                {srv.categories.length > 0 && ` · ${srv.categories.map((c) => TOPIC_NAME[c]).filter(Boolean).slice(0, 4).join(', ')}`}
                {srv.nsfw_policy === 'display' && ' · shows NSFW'}
              </div>
            </div>
            {srv.blocked ? (
              <span className="badge err">Blocked</span>
            ) : srv.following ? (
              <span className={`badge ${STATUS[srv.following]?.[0] || ''}`} title={STATUS[srv.following]?.[1]}>
                {{ accepted: 'Following', pending: 'Waiting', rejected: 'Declined' }[srv.following] || srv.following}
              </span>
            ) : (
              <button className="btn btn-sm" disabled={!enabled || busy === srv.host} onClick={() => follow(srv)}>
                Follow
              </button>
            )}
          </div>
        ))}
        {loading && <div className="spinner" />}
      </div>
      {result && !loading && result.servers.length < result.total && (
        <button className="btn btn-ghost top-gap" onClick={() => setPage((p) => p + 1)}>
          Show more
        </button>
      )}
    </div>
  );
}

export function FediverseAdmin() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const load = () => api('/admin/fediverse').then(setS).catch((e) => toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!s) return null;
  const run = async (fn, msg) => {
    setBusy(true);
    try {
      setS(await fn());
      if (msg) toast(msg);
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card-panel">
      <h2>
        <Icon name="public" /> Fediverse (ActivityPub)
      </h2>
      <p className="hint">
        Lets Mastodon, PeerTube and other fediverse servers follow channels here, watch and comment on videos, and lets people here follow channels there.
        Blocked instances above are blocked here too.
      </p>
      <label className="toggle-row">
        <span className="toggle-text">
          <b>Speak ActivityPub</b>
          <span className="hint">{s.enabled ? `This server is ${s.instance_handle}.` : 'Off: this site is invisible to the fediverse.'}</span>
        </span>
        <input type="checkbox" className="switch" checked={s.enabled} disabled={busy} onChange={(e) => run(() => api('/admin/fediverse', { method: 'PATCH', body: { enabled: e.target.checked } }))} />
      </label>
      {s.enabled && !s.public_url_set && <div className="notice warn-box">Set the Public URL under Overview, so fediverse servers can reach this site at a stable https:// address.</div>}
      <div className="kv">
        <span className="muted">Fediverse followers</span>
        <span>
          {s.followers.channels} of channels, {s.followers.instance} of this server
        </span>
      </div>
      <div className="kv">
        <span className="muted">Videos from the fediverse</span>
        <span>{s.videos}</span>
      </div>
      <h3 className="sub-h">Follow a whole server</h3>
      <p className="hint">Brings in every public video of a PeerTube server, the way PeerTube servers follow each other.</p>
      <form
        className="follow-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api('/admin/fediverse/follow', { method: 'POST', body: { server } }), 'Follow request sent').then(() => setServer(''));
        }}
      >
        <input className="input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="peertube.example" aria-label="Server address" />
        <button className="btn" disabled={busy || !server.trim() || !s.enabled}>
          Follow
        </button>
      </form>
      <button className="btn btn-ghost top-gap" onClick={() => setBrowsing((b) => !b)}>
        <Icon name="search" /> {browsing ? 'Close the PeerTube directory' : 'Browse the PeerTube directory'}
      </button>
      {browsing && <PeerTubeDirectory enabled={s.enabled} onFollowed={setS} />}
      {s.servers.length > 0 && (
        <div className="fed-list top-gap">
          {s.servers.map((a) => (
            <div key={a.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  {a.name} <span className={`badge ${STATUS[a.status]?.[0] || ''}`}>{STATUS[a.status]?.[1] || a.status}</span>
                </div>
                <div className="fed-sub">{a.handle}</div>
              </div>
              <button className="icon-btn" title="Unfollow" disabled={busy} onClick={() => run(() => api('/admin/fediverse/follow', { method: 'DELETE', body: { actor: a.id } }))}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
