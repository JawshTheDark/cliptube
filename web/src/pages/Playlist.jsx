import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { Empty } from '../components/VideoCard.jsx';
import { PlaylistCard } from '../components/Playlists.jsx';
import { FeedButton } from '../components/FeedLink.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDuration, plural } from '../util.js';
import { useStartParty } from './Party.jsx';

const VIS = { public: ['public', 'Public'], unlisted: ['link', 'Unlisted'], private: ['lock', 'Private'] };

/** One playlist: play it in order or shuffled, and (for its owner) rename, reorder, remove and delete. */
export default function Playlist() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', visibility: 'public' });
  const [drag, setDrag] = useState(null);
  const [busy, setBusy] = useState(false);
  const startParty = useStartParty();
  const load = () =>
    api(`/playlists/${id}`)
      .then((r) => setP(r.playlist))
      .catch((e) => setError(e));
  useEffect(() => {
    setP(null);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id]);
  useTitle(p?.title);

  if (error) return <Empty icon="playlist" title="This playlist doesn't exist, or it's private" />;
  if (!p) return <div className="spinner" />;

  const own = p.is_owner;
  const playable = p.items.filter((it) => it.available);
  const total = playable.reduce((s, it) => s + (it.video?.duration || 0), 0);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/playlists/${p.id}`, { method: 'PATCH', body: form });
      setP(r.playlist);
      setEditing(false);
      toast('Playlist saved');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (it) => {
    try {
      await api(`/playlists/${p.id}/items/${it.id}`, { method: 'DELETE' });
      setP((x) => ({ ...x, items: x.items.filter((y) => y.id !== it.id), item_count: x.item_count - 1 }));
    } catch (e) {
      toast(e.message);
    }
  };
  const order = async (items) => {
    setP((x) => ({ ...x, items }));
    try {
      const r = await api(`/playlists/${p.id}/order`, { method: 'PUT', body: { item_ids: items.map((it) => it.id) } });
      setP(r.playlist);
    } catch (e) {
      toast(e.message);
      load();
    }
  };
  const move = (from, to) => {
    if (to < 0 || to >= p.items.length || from === to) return;
    const items = [...p.items];
    const [it] = items.splice(from, 1);
    items.splice(to, 0, it);
    order(items);
  };
  const del = async () => {
    if (!window.confirm(`Delete the playlist "${p.title}"? The videos stay where they are.`)) return;
    try {
      await api(`/playlists/${p.id}`, { method: 'DELETE' });
      toast('Playlist deleted');
      nav('/playlists');
    } catch (e) {
      toast(e.message);
    }
  };
  const [visIcon, visLabel] = VIS[p.visibility] || VIS.public;
  const first = playable[0];

  return (
    <div className="playlist-page">
      <section className="playlist-hero">
        <div className="playlist-hero-thumb">{p.thumbnail_url ? <img src={p.thumbnail_url} alt="" /> : <Icon name="playlist" size={56} />}</div>
        {editing ? (
          <form className="playlist-edit" onSubmit={save}>
            {p.kind === 'user' && (
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={100} aria-label="Name" required />
            )}
            <textarea className="input" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description" aria-label="Description" />
            {p.kind === 'user' && (
              <select className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })} aria-label="Who can see it">
                <option value="public">Public: on your channel</option>
                <option value="unlisted">Unlisted: anyone with the link</option>
                <option value="private">Private: only you</option>
              </select>
            )}
            <div className="row-actions">
              <button className="btn btn-primary" disabled={busy}>
                Save
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="playlist-hero-text">
            <h1>{p.title}</h1>
            <div className="meta">
              {p.owner && <Link to={`/c/${p.owner.username}`}>{p.owner.display_name}</Link>}
              <span>•</span>
              <span>
                <Icon name={p.kind === 'watch_later' ? 'watch_later' : visIcon} size={14} className="inline-icon" /> {visLabel}
              </span>
              <span>•</span>
              <span>{plural(p.item_count, 'video')}</span>
              {total > 0 && (
                <>
                  <span>•</span>
                  <span>{formatDuration(total)}</span>
                </>
              )}
            </div>
            {p.description && <p className="pre">{p.description}</p>}
            <div className="actions">
              {first && (
                <Link className="btn btn-primary" to={`${first.url}?list=${p.id}`}>
                  <Icon name="play" /> Play all
                </Link>
              )}
              {playable.length > 1 && (
                <Link className="btn" to={`${playable[Math.floor(Math.random() * playable.length)].url}?list=${p.id}&shuffle=1`}>
                  <Icon name="shuffle" /> Shuffle
                </Link>
              )}
              {first && (
                <button className="btn" onClick={() => startParty({ playlist_id: p.id })} title="Watch the playlist with friends, in sync, with chat">
                  <Icon name="group" /> Watch together
                </button>
              )}
              {own && (
                <button
                  className="btn"
                  onClick={() => {
                    setForm({ title: p.title, description: p.description, visibility: p.visibility });
                    setEditing(true);
                  }}
                >
                  <Icon name="edit" /> Edit
                </button>
              )}
              {own && p.kind === 'user' && (
                <button className="btn btn-icon" onClick={del} title="Delete the playlist">
                  <Icon name="delete" />
                </button>
              )}
              {p.visibility !== 'private' && p.kind === 'user' && <FeedButton href={`/feeds/playlist/${p.id}.atom`} title={`${p.title} feed`} />}
            </div>
          </div>
        )}
      </section>

      {p.items.length === 0 ? (
        <Empty icon="playlist" title="No videos yet">
          <p className="muted">Use Save under any video to add it here.</p>
        </Empty>
      ) : (
        <ol className="playlist-items">
          {p.items.map((it, i) => (
            <li
              key={it.id}
              className={`playlist-item ${it.available ? '' : 'gone'} ${drag === i ? 'dragging' : ''}`}
              draggable={own}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => own && e.preventDefault()}
              onDrop={() => {
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              {own && (
                <span className="playlist-drag" title="Drag to reorder">
                  <Icon name="drag" />
                </span>
              )}
              <span className="playlist-row-n">{i + 1}</span>
              {it.available ? (
                <Link to={`${it.url}?list=${p.id}`} className="playlist-item-main">
                  <span className="playlist-item-thumb">
                    {it.thumbnail_url ? <img src={it.thumbnail_url} alt="" loading="lazy" /> : <Icon name="video" />}
                    {it.video?.duration ? <span className="duration">{formatDuration(it.video.duration)}</span> : null}
                  </span>
                  <span className="playlist-row-text">
                    <span className="playlist-row-title">{it.title}</span>
                    <span className="muted small">
                      {it.video?.uploader?.display_name}
                      {it.video?.remote ? ` · ${it.video.remote.peer_name || 'another site'}` : ''}
                    </span>
                  </span>
                </Link>
              ) : (
                <span className="playlist-item-main">
                  <span className="playlist-item-thumb">
                    <Icon name="video" />
                  </span>
                  <span className="playlist-row-text">
                    <span className="playlist-row-title">{it.title}</span>
                    <span className="muted small">No longer available</span>
                  </span>
                </span>
              )}
              {own && (
                <span className="playlist-item-tools">
                  <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <Icon name="arrow_up" />
                  </button>
                  <button className="icon-btn" title="Move down" disabled={i === p.items.length - 1} onClick={() => move(i, i + 1)}>
                    <Icon name="arrow_down" />
                  </button>
                  <button className="icon-btn" title="Remove from the playlist" onClick={() => remove(it)}>
                    <Icon name="close" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Your playlists, with Watch later first, and a way to start a new one. */
export function MyPlaylists() {
  const toast = useToast();
  const nav = useNavigate();
  const [lists, setLists] = useState(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('public');
  useTitle('Playlists');
  useEffect(() => {
    api('/playlists/mine')
      .then((r) => setLists(r.playlists))
      .catch((e) => {
        toast(e.message);
        setLists([]);
      });
  }, [toast]);
  const create = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/playlists', { method: 'POST', body: { title: name.trim(), visibility } });
      nav(`/playlist/${r.playlist.id}`);
    } catch (err) {
      toast(err.message);
    }
  };
  if (!lists) return <div className="spinner" />;
  return (
    <div className="page-wide">
      <h1 className="page-title">
        <Icon name="playlist" /> Playlists
      </h1>
      <form className="follow-form playlist-new" onSubmit={create}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New playlist name" maxLength={100} aria-label="New playlist name" />
        <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Who can see it">
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
        <button className="btn btn-primary" disabled={!name.trim()}>
          <Icon name="add" /> Create
        </button>
      </form>
      <div className="video-grid top-gap">
        {lists.map((p) => (
          <PlaylistCard key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}

/** /watch-later: opens your Watch later list. */
export function WatchLater() {
  const nav = useNavigate();
  useEffect(() => {
    api('/playlists/mine')
      .then((r) => {
        const wl = r.playlists.find((p) => p.kind === 'watch_later');
        if (wl) nav(`/playlist/${wl.id}`, { replace: true });
      })
      .catch(() => nav('/playlists', { replace: true }));
  }, [nav]);
  return <div className="spinner" />;
}
