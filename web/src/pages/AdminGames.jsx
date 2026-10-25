import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { reloadGames } from '../components/GameField.jsx';
import { SteamGridPicker } from '../components/SteamGridPicker.jsx';
import { AdminTabs } from './Admin.jsx';

/** The SteamGridDB API key (admins) and filling in artwork (moderators). */
function SteamGridSettings({ sgdb, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [s, setS] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user?.is_admin) api('/admin/settings').then((r) => setS(r.settings)).catch(() => {});
  }, [user?.is_admin]);
  const save = async (body, message) => {
    setBusy(true);
    try {
      setS((await api('/admin/settings', { method: 'PATCH', body })).settings);
      setKey('');
      if (message) toast(message);
      onChanged();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const fill = async () => {
    setBusy(true);
    try {
      const r = await api('/games/steamgriddb/fill', { method: 'POST' });
      toast(r.queued ? `Finding artwork for ${r.queued} game${r.queued === 1 ? '' : 's'}; it shows up in a minute or two` : 'Every game already has its artwork');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card-panel">
      <h2>
        <Icon name="image" /> Artwork from SteamGridDB
      </h2>
      <p className="hint">
        Covers, title logos and banners from <a href="https://www.steamgriddb.com" target="_blank" rel="noopener noreferrer">SteamGridDB</a>, picked per game or filled in
        on their own. Its artists are credited on each game&apos;s page.
      </p>
      {user?.is_admin && s && (
        <>
          <form
            className="follow-form"
            onSubmit={(e) => {
              e.preventDefault();
              save({ steamgriddb_api_key: key }, 'API key saved');
            }}
          >
            <input
              className="input"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={s.steamgriddb_key_set ? 'A key is saved; paste a new one to replace it' : 'SteamGridDB API key'}
              autoComplete="off"
              aria-label="SteamGridDB API key"
            />
            <button className="btn" disabled={busy || !key.trim()}>
              Save key
            </button>
            {s.steamgriddb_key_set && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => save({ steamgriddb_api_key: null }, 'API key removed')}>
                Remove
              </button>
            )}
          </form>
          <p className="hint small">
            Get one from your SteamGridDB account under{' '}
            <a href="https://www.steamgriddb.com/profile/preferences/api" target="_blank" rel="noopener noreferrer">
              Preferences, API
            </a>
            . It is never shown again here.
          </p>
          <label className="toggle-row">
            <span className="toggle-text">
              <b>Fill in artwork for new games</b>
              <span className="hint">Takes SteamGridDB&apos;s best-rated cover, logo and banner when a game is added.</span>
            </span>
            <input type="checkbox" className="switch" checked={s.steamgriddb_auto !== 'false'} disabled={busy} onChange={(e) => save({ steamgriddb_auto: e.target.checked })} />
          </label>
        </>
      )}
      {sgdb.configured ? (
        <button className="btn top-gap" disabled={busy} onClick={fill}>
          <Icon name="refresh" /> Fill in missing artwork
        </button>
      ) : (
        !user?.is_admin && <p className="muted small">An admin needs to add a SteamGridDB API key first.</p>
      )}
    </section>
  );
}

function GameRow({ game, onChange, onDelete, hubName, sgdb }) {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  // Games from the hub's catalog are kept up to date by the hub and changed there.
  const locked = game.from_hub;
  const fileRef = useRef(null);
  const [form, setForm] = useState({ name: game.name, short_name: game.short_name || '', aliases: game.aliases.join(', ') });
  const dirty = form.name !== game.name || form.short_name !== (game.short_name || '') || form.aliases !== game.aliases.join(', ');
  const save = async (e) => {
    e.preventDefault();
    try {
      onChange((await api(`/games/${game.id}`, { method: 'PATCH', body: form })).game);
      toast('Saved');
    } catch (err) {
      toast(err.message);
    }
  };
  const upload = async (file) => {
    const fd = new FormData();
    fd.append('artwork', file);
    try {
      onChange((await api(`/games/${game.id}/artwork`, { method: 'POST', body: fd })).game);
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <form className="game-row" onSubmit={save}>
      <button type="button" className="game-art-btn" disabled={locked} onClick={() => fileRef.current.click()} title={locked ? 'Artwork from the hub' : 'Upload artwork (portrait, like a box cover)'}>
        {game.artwork_url ? <img src={game.artwork_url} alt="" /> : <Icon name="image" />}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          if (e.target.files[0]) upload(e.target.files[0]);
          e.target.value = '';
        }}
      />
      {picking && <SteamGridPicker game={game} onClose={() => setPicking(false)} onChange={onChange} />}
      <div className="game-row-fields">
        {(game.logo_url || game.hero_url) && (
          <div className="game-row-art">
            {game.hero_url && <img className="game-row-hero" src={game.hero_url} alt="" />}
            {game.logo_url && <img className="game-row-logo" src={game.logo_url} alt={`${game.name} logo`} />}
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label>Name</label>
            <input className="input" value={form.name} maxLength={80} disabled={locked} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="field">
            <label>Short name</label>
            <input className="input" value={form.short_name} maxLength={30} disabled={locked} onChange={(e) => setForm({ ...form, short_name: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label>Also known as</label>
          <input
            className="input"
            value={form.aliases}
            disabled={locked}
            onChange={(e) => setForm({ ...form, aliases: e.target.value })}
            placeholder="Other names other instances might use, separated by commas"
          />
        </div>
        <div className="row-actions">
          <span className="muted small">
            <Link to={`/g/${game.id}`}>/g/{game.id}</Link> · {game.video_count} here · {game.network_count} from the network
          </span>
          {locked ? (
            <span className="badge" title="The hub keeps this game up to date; it is changed or deleted there">
              From {hubName || 'the hub'}
            </span>
          ) : (
            <span className="row-actions end">
              {sgdb.configured && (
                <button type="button" className="btn btn-sm" onClick={() => setPicking(true)} title="Cover, title logo and banner from SteamGridDB">
                  <Icon name="image" size={16} /> Artwork
                </button>
              )}
              <button className="btn btn-sm btn-primary" disabled={!dirty}>
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => onDelete(game)}>
                Delete
              </button>
            </span>
          )}
        </div>
      </div>
    </form>
  );
}

export default function AdminGames() {
  const toast = useToast();
  const [games, setGames] = useState(null);
  const [catalog, setCatalog] = useState({});
  const [sgdb, setSgdb] = useState({ configured: false, auto: false });
  const [draft, setDraft] = useState({ name: '', short_name: '', aliases: '' });
  useTitle('Games');
  const load = () =>
    api('/games')
      .then((r) => {
        setGames(r.games);
        setCatalog(r.catalog || {});
        setSgdb(r.steamgriddb || { configured: false, auto: false });
      })
      .catch((e) => toast(e.message));
  const hubName = catalog.hub_url ? new URL(catalog.hub_url).host : null;
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (e) => {
    e.preventDefault();
    try {
      await api('/games', { method: 'POST', body: draft });
      setDraft({ name: '', short_name: '', aliases: '' });
      reloadGames();
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async (g) => {
    const everywhere = catalog.is_hub ? ' It also leaves the catalog of every instance in the network.' : '';
    if (!window.confirm(`Delete ${g.name}? Its ${g.video_count} clip(s) stay, without a game.${everywhere}`)) return;
    try {
      await api(`/games/${g.id}`, { method: 'DELETE' });
      setGames((list) => list.filter((x) => x.id !== g.id));
      reloadGames();
    } catch (err) {
      toast(err.message);
    }
  };

  return (
    <div className="page page-wide">
      <AdminTabs />
      <h1>
        <Icon name="game" /> Games
      </h1>
      <p className="page-sub flush">
        Clips can be filed under these games. The short name becomes the game's id, which other instances in the network use to group clips, so keep
        it to the common name (like <code>mw3</code> or <code>valorant</code>). Add other spellings under "Also known as".
      </p>
      {catalog.is_hub && <p className="hint">This list is the network&apos;s catalog: members get these games automatically, and a game deleted here goes from theirs too.</p>}
      {hubName && <p className="hint">Games marked &ldquo;From {hubName}&rdquo; come from the network hub&apos;s catalog and stay in step with it. Games you add here are this site&apos;s own.</p>}
      <SteamGridSettings sgdb={sgdb} onChanged={load} />
      <section className="card-panel">
        <h2>Add a game</h2>
        <form onSubmit={create} className="field-row align-end">
          <div className="field grow">
            <label>Name</label>
            <input className="input" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Call of Duty: Modern Warfare III" required />
          </div>
          <div className="field">
            <label>Short name</label>
            <input className="input" value={draft.short_name} maxLength={30} onChange={(e) => setDraft({ ...draft, short_name: e.target.value })} placeholder="MW3" />
          </div>
          <div className="field grow">
            <label>Also known as</label>
            <input className="input" value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="cod, call of duty" />
          </div>
          <div className="field">
            <button className="btn btn-primary">Add</button>
          </div>
        </form>
      </section>
      {games === null ? (
        <div className="spinner" />
      ) : (
        <div className="game-rows">
          {games.map((g) => (
            <GameRow
              key={g.id}
              game={g}
              onChange={(n) => {
                setGames((list) => list.map((x) => (x.id === n.id ? n : x)));
                reloadGames();
              }}
              onDelete={remove}
              hubName={hubName}
              sgdb={sgdb}
            />
          ))}
          {games.length === 0 && <p className="muted">No games yet.</p>}
        </div>
      )}
    </div>
  );
}
