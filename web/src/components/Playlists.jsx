import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { plural, usePref } from '../util.js';

const VIS_ICON = { public: 'public', unlisted: 'link', private: 'lock' };
const VIS_LABEL = { public: 'Public', unlisted: 'Unlisted', private: 'Private' };

/** "Save to…": tick the playlists a video belongs in (Watch later first), or start a new one with it. */
export function SaveDialog({ videoKey, onClose }) {
  const toast = useToast();
  const [lists, setLists] = useState(null);
  const [busy, setBusy] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('public');
  const load = () =>
    api(`/playlists/mine?has=${encodeURIComponent(videoKey)}`)
      .then((r) => setLists(r.playlists))
      .catch((e) => {
        toast(e.message);
        setLists([]);
      });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey]);

  const toggle = async (p) => {
    setBusy(p.id);
    try {
      if (p.contains) await api(`/playlists/${p.id}/items/${p.contains}`, { method: 'DELETE' });
      else await api(`/playlists/${p.id}/items`, { method: 'POST', body: { ref: videoKey } });
      toast(p.contains ? `Removed from ${p.title}` : `Saved to ${p.title}`);
      await load();
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };
  const create = async (e) => {
    e.preventDefault();
    setBusy('new');
    try {
      const r = await api('/playlists', { method: 'POST', body: { title: name.trim(), visibility, ref: videoKey } });
      toast(`Saved to ${r.playlist.title}`);
      setCreating(false);
      setName('');
      await load();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal save-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Save to a playlist">
        <h2>Save to…</h2>
        {lists === null ? (
          <div className="spinner" />
        ) : (
          <div className="save-lists">
            {lists.map((p) => (
              <label key={p.id} className="save-row">
                <input type="checkbox" checked={!!p.contains} disabled={!!busy} onChange={() => toggle(p)} />
                <span className="save-title">{p.title}</span>
                <Icon name={p.kind === 'watch_later' ? 'watch_later' : VIS_ICON[p.visibility]} size={16} className="muted" title={VIS_LABEL[p.visibility]} />
              </label>
            ))}
          </div>
        )}
        {creating ? (
          <form onSubmit={create} className="save-new">
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Playlist name" maxLength={100} aria-label="Playlist name" />
            <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Who can see it">
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
            <button className="btn btn-primary" disabled={!name.trim() || !!busy}>
              Create
            </button>
          </form>
        ) : (
          <button className="btn top-gap" onClick={() => setCreating(true)}>
            <Icon name="add" /> New playlist
          </button>
        )}
        <div className="row-actions modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** A playlist as a card (the Playlists page and channel tabs). */
export function PlaylistCard({ p }) {
  const href = p.item_count && p.first_url ? `${p.first_url}?list=${p.id}` : `/playlist/${p.id}`;
  return (
    <article className="card grid playlist-card">
      <Link to={href} className="thumb" aria-label={`Play ${p.title}`}>
        {p.thumbnail_url ? (
          <img src={p.thumbnail_url} alt="" loading="lazy" />
        ) : (
          <div className="thumb-placeholder">
            <Icon name={p.kind === 'watch_later' ? 'watch_later' : 'playlist'} size={40} />
          </div>
        )}
        <span className="playlist-count">
          <Icon name="playlist" size={16} /> {p.item_count}
        </span>
      </Link>
      <div className="card-body">
        <div className="card-text">
          <Link to={`/playlist/${p.id}`} className="card-title">
            {p.title}
          </Link>
          <div className="card-meta">
            <span>
              {p.kind !== 'watch_later' && <Icon name={VIS_ICON[p.visibility]} size={13} className="inline-icon" />} {VIS_LABEL[p.visibility]}
            </span>
            <Link to={`/playlist/${p.id}`}>View full playlist</Link>
          </div>
        </div>
      </div>
    </article>
  );
}

const shuffleKey = (id) => `playlist-order-${id}`;

/** A shuffled order of item ids, kept for this tab so going back and forth stays in the same order. */
function shuffledOrder(listId, ids) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(shuffleKey(listId)) || 'null');
    if (Array.isArray(saved) && saved.length === ids.length && ids.every((x) => saved.includes(x))) return saved;
  } catch {}
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  try {
    sessionStorage.setItem(shuffleKey(listId), JSON.stringify(order));
  } catch {}
  return order;
}

/**
 * The playlist a video is being watched from (?list=): Up next, with shuffle, loop and autoplay. When the
 * video ends, the next one starts.
 */
export function PlaylistPanel({ listId, currentKey, shuffle: shuffleParam = false }) {
  const nav = useNavigate();
  const [p, setP] = useState(null);
  const [shuffle, setShuffle] = useState(shuffleParam);
  const [loop, setLoop] = usePref('playlist_loop');
  const [autoplay, setAutoplay] = usePref('playlist_autoplay');
  const autoOn = autoplay !== 'off';
  useEffect(() => {
    let dead = false;
    api(`/playlists/${listId}`)
      .then((r) => !dead && setP(r.playlist))
      .catch(() => !dead && setP(false));
    return () => {
      dead = true;
    };
  }, [listId]);

  const items = useMemo(() => {
    if (!p) return [];
    const ok = p.items.filter((it) => it.available);
    if (!shuffle) return ok;
    const byId = new Map(ok.map((it) => [it.id, it]));
    return shuffledOrder(listId, ok.map((it) => it.id)).map((id) => byId.get(id)).filter(Boolean);
  }, [p, shuffle, listId]);
  const index = items.findIndex((it) => it.ref === currentKey);
  const next = index >= 0 && index + 1 < items.length ? items[index + 1] : loop === 'on' && items.length ? items[0] : null;
  const link = (it) => `${it.url}?list=${listId}${shuffle ? '&shuffle=1' : ''}`;

  // When the video ends, play the next one. 'ended' doesn't bubble, but a capturing listener still hears it.
  useEffect(() => {
    if (!next || !autoOn) return undefined;
    const onEnded = (e) => {
      if (e.target?.tagName === 'VIDEO' && e.target.closest('.player-wrap')) nav(link(next));
    };
    document.addEventListener('ended', onEnded, true);
    return () => document.removeEventListener('ended', onEnded, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.id, autoOn, shuffle]);

  if (p === false) return null;
  if (!p) return <div className="playlist-panel spinner" />;
  return (
    <div className="playlist-panel">
      <div className="playlist-panel-head">
        <div>
          <Link to={`/playlist/${p.id}`} className="playlist-panel-title">
            {p.title}
          </Link>
          <div className="muted small">
            {p.owner?.display_name} · {index >= 0 ? `${index + 1} / ${items.length}` : plural(items.length, 'video')}
          </div>
        </div>
        <div className="playlist-panel-tools">
          <button className={`icon-btn ${shuffle ? 'active' : ''}`} title="Shuffle" onClick={() => setShuffle((x) => !x)}>
            <Icon name="shuffle" />
          </button>
          <button className={`icon-btn ${loop === 'on' ? 'active' : ''}`} title="Loop the playlist" onClick={() => setLoop(loop === 'on' ? 'off' : 'on')}>
            <Icon name="loop" />
          </button>
          <button className={`icon-btn ${autoOn ? 'active' : ''}`} title={autoOn ? 'Autoplay is on' : 'Autoplay is off'} onClick={() => setAutoplay(autoOn ? 'off' : 'on')}>
            <Icon name="skip" />
          </button>
        </div>
      </div>
      <ol className="playlist-panel-items">
        {items.map((it, i) => (
          <li key={it.id} className={i === index ? 'current' : ''}>
            <Link to={link(it)} className="playlist-row">
              <span className="playlist-row-n">{i === index ? '▶' : i + 1}</span>
              <span className="playlist-row-thumb">{it.thumbnail_url ? <img src={it.thumbnail_url} alt="" loading="lazy" /> : <Icon name="video" />}</span>
              <span className="playlist-row-text">
                <span className="playlist-row-title">{it.title}</span>
                <span className="muted small">{it.video?.uploader?.display_name}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
