import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { timeAgo } from '../util.js';

/** The bell in the top bar: unread count, and the latest notifications in a menu. */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const nav = useNavigate();
  const location = useLocation();

  const count = useCallback(() => api('/notifications/count').then((r) => setUnread(r.unread)).catch(() => {}), []);
  useEffect(() => {
    count();
    const t = setInterval(count, 60_000);
    const onFocus = () => count();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [count]);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    api('/notifications')
      .then((r) => {
        setList(r.notifications.slice(0, 12));
        setUnread(r.unread);
      })
      .catch(() => setList([]));
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const openOne = async (n) => {
    setOpen(false);
    if (!n.read) api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).then((r) => setUnread(r.unread)).catch(() => {});
    if (n.url) nav(n.url);
  };
  const readAll = async () => {
    const r = await api('/notifications/read', { method: 'POST' }).catch(() => null);
    if (r) {
      setUnread(r.unread);
      setList((l) => l?.map((n) => ({ ...n, read: true })));
    }
  };

  return (
    <div className="avatar-menu" ref={ref}>
      <button className="icon-btn bell-btn" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
        <Icon name="bell" />
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="menu notif-menu">
          <div className="notif-head">
            <b>Notifications</b>
            <span className="row-actions">
              {unread > 0 && (
                <button className="link-btn" onClick={readAll}>
                  Mark all read
                </button>
              )}
              <Link to="/settings/notifications" className="icon-btn" title="Notification settings">
                <Icon name="settings" />
              </Link>
            </span>
          </div>
          {list === null ? (
            <div className="spinner" />
          ) : list.length === 0 ? (
            <p className="muted notif-empty">Nothing yet. New uploads from your subscriptions, replies and mentions show up here.</p>
          ) : (
            list.map((n) => <NotificationRow key={n.id} n={n} onOpen={() => openOne(n)} />)
          )}
          <Link to="/notifications" className="menu-item notif-all">
            See all
          </Link>
        </div>
      )}
    </div>
  );
}

export function NotificationRow({ n, onOpen }) {
  const icon = { upload: 'video', reply: 'comment', mention: 'comment', comment: 'comment', moderation: 'gavel', update: 'download' }[n.kind] || 'bell';
  return (
    <button className={`notif-row ${n.read ? '' : 'unread'}`} onClick={onOpen}>
      <span className="notif-icon">
        <Icon name={icon} />
      </span>
      <span className="notif-text">
        <span className="notif-title">{n.title}</span>
        {n.body && <span className="notif-body">{n.body}</span>}
        <span className="muted small">{timeAgo(n.created_at)}</span>
      </span>
      {n.image_url && <img className="notif-thumb" src={n.image_url} alt="" />}
    </button>
  );
}
