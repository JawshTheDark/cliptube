import { useEffect, useState } from 'react';

const COLORS = ['#e53935', '#8e24aa', '#3949ab', '#039be5', '#00897b', '#7cb342', '#fb8c00', '#6d4c41', '#546e7a', '#d81b60'];

export function Avatar({ user, size = 40, className = '' }) {
  const name = user?.display_name || user?.username || '?';
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  // A picture that doesn't load (its server is down or refuses it) falls back to the initial.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [user?.avatar_url]);
  if (user?.avatar_url && !failed) {
    return <img className={`avatar ${className}`} style={style} src={user.avatar_url} alt={name} onError={() => setFailed(true)} />;
  }
  let h = 0;
  for (const c of user?.username || name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${className}`} style={{ ...style, background: COLORS[h % COLORS.length] }}>
      {name.trim()[0]?.toUpperCase() || '?'}
    </span>
  );
}
