import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { reloadGames } from '../components/GameField.jsx';
import { AdminTabs } from './Admin.jsx';

function GameRow({ game, onChange, onDelete }) {
  const toast = useToast();
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
      <button type="button" className="game-art-btn" onClick={() => fileRef.current.click()} title="Upload artwork (portrait, like a box cover)">
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
      <div className="game-row-fields">
        <div className="field-row">
          <div className="field">
            <label>Name</label>
            <input className="input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="field">
            <label>Short name</label>
            <input className="input" value={form.short_name} maxLength={30} onChange={(e) => setForm({ ...form, short_name: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label>Also known as</label>
          <input className="input" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} placeholder="Other names other instances might use, separated by commas" />
        </div>
        <div className="row-actions">
          <span className="muted small">
            <Link to={`/g/${game.id}`}>/g/{game.id}</Link> · {game.video_count} here · {game.network_count} from the network
          </span>
          <span className="row-actions end">
            <button className="btn btn-sm btn-primary" disabled={!dirty}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onDelete(game)}>
              Delete
            </button>
          </span>
        </div>
      </div>
    </form>
  );
}

export default function AdminGames() {
  const toast = useToast();
  const [games, setGames] = useState(null);
  const [draft, setDraft] = useState({ name: '', short_name: '', aliases: '' });
  useTitle('Games');
  const load = () => api('/games').then((r) => setGames(r.games)).catch((e) => toast(e.message));
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
    if (!window.confirm(`Delete ${g.name}? Its ${g.video_count} clip(s) stay, without a game.`)) return;
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
            />
          ))}
          {games.length === 0 && <p className="muted">No games yet.</p>}
        </div>
      )}
    </div>
  );
}
