import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { NotificationRow } from '../components/NotificationBell.jsx';
import { Empty } from '../components/VideoCard.jsx';

export default function Notifications() {
  const [data, setData] = useState(null);
  const nav = useNavigate();
  useTitle('Notifications');
  const load = () => api('/notifications').then(setData).catch(() => setData({ notifications: [], unread: 0 }));
  useEffect(() => {
    load();
  }, []);
  if (!data) return <div className="spinner" />;
  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>
          <Icon name="bell" /> Notifications
        </h1>
        <div className="row-actions">
          {data.unread > 0 && (
            <button className="btn" onClick={() => api('/notifications/read', { method: 'POST' }).then(load)}>
              Mark all read
            </button>
          )}
          <Link to="/settings/notifications" className="btn btn-ghost">
            <Icon name="settings" /> Settings
          </Link>
        </div>
      </div>
      {data.notifications.length === 0 ? (
        <Empty icon="bell" title="No notifications">
          <p>New uploads from channels you subscribe to, replies, mentions and moderation decisions show up here.</p>
        </Empty>
      ) : (
        <div className="notif-list">
          {data.notifications.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onOpen={() => {
                if (!n.read) api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {});
                if (n.url) nav(n.url);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
