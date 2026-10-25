import { useEffect, useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';

function Item({ to, icon, label, end }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <Icon name={icon} />
      <span>{label}</span>
    </NavLink>
  );
}

export function Sidebar({ mini = false, drawer = false, onClose }) {
  const { user, site } = useAuth();
  const [subs, setSubs] = useState([]);

  useEffect(() => {
    if (!user || mini) return;
    api('/me/subscriptions')
      .then((r) => setSubs(r.channels))
      .catch(() => setSubs([]));
  }, [user, mini]);

  return (
    <nav className={`sidebar ${mini ? 'mini' : ''} ${drawer ? 'drawer' : ''}`}>
      {drawer && (
        <div className="drawer-head">
          <button className="icon-btn" onClick={onClose} aria-label="Close menu">
            <Icon name="menu" />
          </button>
          <Link to="/" className="logo" onClick={onClose}>
            <span className="logo-mark">
              <Icon name="play" />
            </span>
            <span className="logo-text">{site.site_name}</span>
          </Link>
        </div>
      )}
      <Item to="/" icon="home" label="Home" end />
      <Item to="/trending" icon="trending" label="Trending" />
      {user && <Item to="/subscriptions" icon="subscriptions" label="Subscriptions" />}

      {!mini && <div className="nav-divider" />}

      {user ? (
        <>
          {!mini && <div className="nav-heading">You</div>}
          {!mini && <Item to={`/c/${user.username}`} icon="person" label="Your channel" />}
          <Item to="/history" icon="history" label="History" />
          <Item to="/liked" icon="thumb_up" label="Liked" />
          <Item to="/studio" icon="video" label="Studio" />
          {user.is_admin && !mini && <Item to="/admin" icon="shield" label="Admin" />}
        </>
      ) : (
        !mini && (
          <div className="nav-signin">
            <p>Sign in to upload clips, like videos, comment and subscribe.</p>
            <Link to="/login" className="btn btn-outline">
              <Icon name="person" /> Sign in
            </Link>
          </div>
        )
      )}

      {!mini && user && subs.length > 0 && (
        <>
          <div className="nav-divider" />
          <div className="nav-heading">Subscriptions</div>
          {subs.map((c) => (
            <NavLink key={c.id} to={`/c/${c.username}`} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Avatar user={c} size={24} />
              <span className="ellipsis">{c.display_name}</span>
            </NavLink>
          ))}
        </>
      )}

      {!mini && (
        <>
          <div className="nav-divider" />
          <div className="nav-foot">
            {site.site_name} · self-hosted
            <br />
            Shortcuts: k play/pause · j/l seek · f fullscreen · t theater · m mute
          </div>
        </>
      )}
    </nav>
  );
}
