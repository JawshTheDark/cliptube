import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icons.jsx';
import { isAnonymous, setAnonymous } from '../util.js';
import { NotificationBell } from './NotificationBell.jsx';

/** Tracks the per-browser anonymous mode, kept in sync across components. */
export function useAnonymous() {
  const [anon, setAnon] = useState(isAnonymous());
  useEffect(() => {
    const h = () => setAnon(isAnonymous());
    window.addEventListener('ct-anon', h);
    window.addEventListener('storage', h);
    return () => {
      window.removeEventListener('ct-anon', h);
      window.removeEventListener('storage', h);
    };
  }, []);
  const toggle = () => {
    setAnonymous(!anon);
    window.dispatchEvent(new Event('ct-anon'));
  };
  return [anon, toggle];
}

export function TopBar({ onMenu }) {
  const { user, site, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [anon, toggleAnon] = useAnonymous();
  const menuRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (location.pathname === '/results') setQ(params.get('q') || '');
  }, [location.pathname, params]);

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [location]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  const submit = (e) => {
    e.preventDefault();
    const term = q.trim();
    if (term) nav(`/results?q=${encodeURIComponent(term)}`);
  };

  const searchForm = (
    <form className="search" onSubmit={submit} role="search">
      <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" />
      <button type="submit" aria-label="Search">
        <Icon name="search" />
      </button>
    </form>
  );

  if (searchOpen) {
    return (
      <header className="topbar topbar-search">
        <button className="icon-btn" onClick={() => setSearchOpen(false)} aria-label="Back">
          <Icon name="back" />
        </button>
        {searchForm}
      </header>
    );
  }

  return (
    <header className="topbar">
      <div className="topbar-start">
        <button className="icon-btn" onClick={onMenu} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <Link to="/" className="logo">
          <span className="logo-mark">
            <Icon name="play" />
          </span>
          <span className="logo-text">{site.site_name}</span>
        </Link>
      </div>
      <div className="topbar-center">{searchForm}</div>
      <div className="topbar-end">
        <button className="icon-btn search-toggle" onClick={() => setSearchOpen(true)} aria-label="Search">
          <Icon name="search" />
        </button>
        {user ? (
          <>
            <Link to="/upload" className="btn btn-ghost upload-btn" title="Upload a video">
              <Icon name="upload" />
              <span className="btn-text">Upload</span>
            </Link>
            <NotificationBell />
            <div className="avatar-menu" ref={menuRef}>
              <button className={`avatar-btn ${anon ? 'anon' : ''}`} onClick={() => setMenuOpen((o) => !o)} aria-label="Account menu" title={anon ? 'Anonymous mode is on' : undefined}>
                <Avatar user={user} size={32} />
                {anon && (
                  <span className="anon-dot">
                    <Icon name="incognito" />
                  </span>
                )}
              </button>
              {menuOpen && (
                <div className="menu">
                  <div className="menu-head">
                    <Avatar user={user} size={40} />
                    <div>
                      <div className="menu-name">{user.display_name}</div>
                      <div className="menu-sub">@{user.username}</div>
                      <Link to={`/c/${user.username}`} className="menu-link">
                        View your channel
                      </Link>
                    </div>
                  </div>
                  <Link to="/studio" className="menu-item">
                    <Icon name="video" /> Your videos
                  </Link>
                  <Link to="/settings" className="menu-item">
                    <Icon name="settings" /> Settings
                  </Link>
                  <button className="menu-item" onClick={toggleAnon} title="Watching doesn't touch your history and counts as a signed-out view">
                    <Icon name="incognito" /> Anonymous mode: {anon ? 'on' : 'off'}
                  </button>
                  {user.is_admin ? (
                    <Link to="/admin" className="menu-item">
                      <Icon name="shield" /> Admin
                    </Link>
                  ) : (
                    user.is_moderator && (
                      <Link to="/admin/moderation" className="menu-item">
                        <Icon name="gavel" /> Moderation
                      </Link>
                    )
                  )}
                  <button
                    className="menu-item"
                    onClick={async () => {
                      await logout();
                      nav('/');
                    }}
                  >
                    <Icon name="logout" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <Link to="/login" className="btn btn-outline" state={{ from: location.pathname }}>
            <Icon name="person" />
            <span>Sign in</span>
          </Link>
        )}
      </div>
    </header>
  );
}
