import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';

const KINDS = [
  ['cover', 'Cover'],
  ['logo', 'Title logo'],
  ['hero', 'Banner'],
];
const LABEL = Object.fromEntries(KINDS);

/** Pick a game's cover, title logo or banner from SteamGridDB. */
export function SteamGridPicker({ game, onClose, onChange }) {
  const toast = useToast();
  const [q, setQ] = useState(game.name);
  const [results, setResults] = useState(null);
  const [sgdbId, setSgdbId] = useState(game.sgdb_id || null);
  const [kind, setKind] = useState('cover');
  const [images, setImages] = useState(null);
  const [busy, setBusy] = useState(null);

  const search = async (e) => {
    e?.preventDefault();
    setResults(null);
    try {
      setResults((await api(`/games/steamgriddb/search?q=${encodeURIComponent(q.trim())}`)).results);
    } catch (err) {
      toast(err.message);
      setResults([]);
    }
  };
  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!sgdbId) return undefined;
    let dead = false;
    setImages(null);
    api(`/games/${encodeURIComponent(game.id)}/steamgriddb?kind=${kind}&sgdb_id=${sgdbId}`)
      .then((r) => !dead && setImages(r.images))
      .catch((err) => {
        if (dead) return;
        toast(err.message);
        setImages([]);
      });
    return () => {
      dead = true;
    };
  }, [sgdbId, kind, game.id, toast]);

  const apply = async (img) => {
    setBusy(img.id);
    try {
      const r = await api(`/games/${encodeURIComponent(game.id)}/steamgriddb`, { method: 'POST', body: { kind, sgdb_id: sgdbId, image_id: img.id } });
      onChange(r.game);
      toast(`${LABEL[kind]} saved`);
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-wide sgdb-picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Artwork for ${game.name}`}>
        <h2>
          Artwork for {game.name} <span>from SteamGridDB</span>
        </h2>
        <form className="follow-form" onSubmit={search}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Game to look for" />
          <button className="btn" disabled={!q.trim()}>
            Search
          </button>
        </form>
        {results === null ? (
          <div className="spinner" />
        ) : results.length === 0 ? (
          <p className="muted">SteamGridDB has nothing by that name. Try another spelling.</p>
        ) : (
          <div className="chips flat sgdb-results">
            {results.map((r) => (
              <button key={r.id} type="button" className={`chip ${sgdbId === r.id ? 'active' : ''}`} onClick={() => setSgdbId(r.id)}>
                {r.name}
                {r.year ? ` (${r.year})` : ''}
                {r.verified && <Icon name="check" size={14} className="inline-icon" title="Verified on SteamGridDB" />}
              </button>
            ))}
          </div>
        )}
        {sgdbId && (
          <>
            <div className="chips flat top-gap">
              {KINDS.map(([k, label]) => (
                <button key={k} type="button" className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
                  {label}
                </button>
              ))}
            </div>
            {images === null ? (
              <div className="spinner" />
            ) : images.length === 0 ? (
              <p className="muted">No {LABEL[kind].toLowerCase()} for this game yet.</p>
            ) : (
              <div className={`sgdb-grid ${kind}`}>
                {images.map((img) => (
                  <button key={img.id} type="button" className="sgdb-item" disabled={!!busy} onClick={() => apply(img)} title={img.author ? `By ${img.author}` : 'Use this one'}>
                    <img src={img.thumb} alt="" loading="lazy" />
                    <span className="sgdb-by">{busy === img.id ? 'Saving…' : img.author || ' '}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <p className="hint small">
          Images are made by the SteamGridDB community and credited on the game&apos;s page. A copy is kept on this site.
        </p>
        <div className="row-actions modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
