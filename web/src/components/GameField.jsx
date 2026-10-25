import { useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

let cache = null;
/** The instance's game list, fetched once per page load (call reloadGames after changes). */
export function loadGames() {
  if (!cache) cache = api('/games').then((r) => r.games).catch(() => ((cache = null), []));
  return cache;
}
export function reloadGames() {
  cache = null;
  return loadGames();
}

/** A text field with the game list as suggestions. The value is the game's name (or id). */
export function GameField({ value, onChange }) {
  const { user } = useAuth();
  const [games, setGames] = useState([]);
  const id = useId();
  useEffect(() => {
    loadGames().then(setGames);
  }, []);
  const known = !value || games.some((g) => [g.name, g.id, g.short_name, ...g.aliases].filter(Boolean).some((x) => x.toLowerCase() === value.trim().toLowerCase()));
  return (
    <div className="field">
      <label>Game</label>
      <input className="input" list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={games.length ? 'Start typing a game' : 'No games listed yet'} />
      <datalist id={id}>
        {games.map((g) => (
          <option key={g.id} value={g.name}>
            {g.short_name || ''}
          </option>
        ))}
      </datalist>
      <span className="hint">
        {known
          ? 'Clips are grouped by game on the Games page, here and on other instances.'
          : user?.is_moderator
            ? 'Not in the list yet: saving adds it.'
            : "Not in this site's list. Pick one from the list, or ask a moderator to add it."}
      </span>
    </div>
  );
}
