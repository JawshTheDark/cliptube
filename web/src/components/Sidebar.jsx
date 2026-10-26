import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';
import { Logo } from './Logo.jsx';

function Item({ to, icon, label, end, active }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${(active ?? isActive) ? 'active' : ''}`}>
      <Icon name={icon} />
      <span>{label}</span>
    </NavLink>
  );
}

export function Sidebar({ mini = false, drawer = false, onClose }) {
  const { user, site } = useAuth();
  const location = useLocation();
  // Shorts plays them one after another; its grid is the home page filtered to vertical videos.
  const shorts = location.pathname.startsWith('/shorts') || (location.pathname === '/' && new URLSearchParams(location.search).get('feed') === 'vertical');
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
          <Logo name={site.site_name} onClick={onClose} />
        </div>
      )}
      <Item to="/" icon="home" label="Home" end active={location.pathname === '/' && !shorts} />
      <Item to="/shorts" icon="shorts" label="Shorts" active={shorts} />
      <Item to="/trending" icon="trending" label="Trending" />
      <Item to="/games" icon="game" label="Games" />
      {site.federation && <Item to="/network" icon="public" label="Network" />}
      {user && <Item to="/subscriptions" icon="subscriptions" label="Subscriptions" />}

      {!mini && <div className="nav-divider" />}

      {user ? (
        <>
          {!mini && <div className="nav-heading">You</div>}
          {!mini && <Item to={`/c/${user.username}`} icon="person" label="Your channel" />}
          <Item to="/history" icon="history" label="History" />
          <Item to="/liked" icon="thumb_up" label="Liked" />
          <Item to="/watch-later" icon="watch_later" label="Watch later" />
          <Item to="/playlists" icon="playlist" label="Playlists" />
          <Item to="/studio" icon="video" label="Studio" />
          {user.is_admin && !mini && <Item to="/admin" icon="shield" label="Admin" />}
          {!user.is_admin && user.is_moderator && !mini && <Item to="/admin/moderation" icon="gavel" label="Moderation" />}
        </>
      ) : (
        !mini && (
          <div className="nav-signin">
            <p>Sign in to upload videos, like them, comment and subscribe.</p>
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
          {subs.map((c) =>
            c.remote ? (
              <a key={c.id} href={c.remote.profile_url} target="_blank" rel="noopener noreferrer" className="nav-item" title={`On ${c.remote.peer_name}`}>
                <Avatar user={c} size={24} />
                <span className="ellipsis">{c.display_name}</span>
                <Icon name="public" className="inline-icon nav-remote" />
              </a>
            ) : (
              <NavLink key={c.id} to={`/c/${c.username}`} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Avatar user={c} size={24} />
                <span className="ellipsis">{c.display_name}</span>
              </NavLink>
            ),
          )}
        </>
      )}

      {!mini && (
        <>
          <div className="nav-divider" />
          <div className="nav-foot">
            {site.site_name} · self-hosted
            <br />
            Runs on{' '}
            <a href="https://github.com/JawshTheDark/ourtube" target="_blank" rel="noopener noreferrer" className="nav-foot-strong">
              OurTube
            </a>
            , free and open source
            <br />
            <Link to="/legal">Rules and contact</Link>
            {site.transparency && (
              <>
                {' · '}
                <Link to="/transparency">Transparency</Link>
              </>
            )}
            <br />
            Shortcuts: k play/pause · j/l seek · f fullscreen · t theater · m mute
          </div>
        </>
      )}
    </nav>
  );
}
