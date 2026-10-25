import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatBytes, formatDate } from '../util.js';

const ENCODER_LABELS = {
  libx264: 'libx264 (CPU, works everywhere)',
  h264_nvenc: 'NVIDIA NVENC (GPU)',
  h264_qsv: 'Intel Quick Sync (GPU)',
  h264_amf: 'AMD AMF (GPU)',
};

export default function Admin() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [form, setForm] = useState(null);
  const [encoders, setEncoders] = useState([]);
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  useTitle('Admin');

  const loadStats = () => api('/admin/stats').then(setStats).catch(() => {});
  const loadUsers = () => api('/admin/users').then((r) => setUsers(r.users)).catch(() => {});

  useEffect(() => {
    api('/admin/settings')
      .then((r) => {
        setForm(r.settings);
        setEncoders(r.encoders);
      })
      .catch((e) => toast(e.message));
    loadStats();
    loadUsers();
    const t = setInterval(loadStats, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api('/admin/settings', { method: 'PATCH', body: form });
      setForm(r.settings);
      refresh().catch(() => {});
      toast('Settings saved');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleAdmin = async (u) => {
    try {
      const r = await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { is_admin: !u.is_admin } });
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, ...r.user } : x)));
    } catch (err) {
      toast(err.message);
    }
  };

  const deleteUser = async (u) => {
    if (!window.confirm(`Delete @${u.username} and ALL of their videos (${u.video_count})?\n\nThis cannot be undone.`)) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      setUsers((list) => list.filter((x) => x.id !== u.id));
      toast('User deleted');
      loadStats();
    } catch (err) {
      toast(err.message);
    }
  };

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="page page-wide">
      <h1>
        <Icon name="shield" /> Admin
      </h1>

      {stats && (
        <div className="stats">
          <div className="stat">
            <div className="n">{stats.users}</div>
            <div className="l">Users</div>
          </div>
          <div className="stat">
            <div className="n">{stats.ready}</div>
            <div className="l">Videos ready{stats.failed ? ` · ${stats.failed} failed` : ''}</div>
          </div>
          <div className="stat">
            <div className="n">{stats.views.toLocaleString()}</div>
            <div className="l">Total views</div>
          </div>
          <div className="stat">
            <div className="n">{stats.comments}</div>
            <div className="l">Comments</div>
          </div>
          <div className="stat">
            <div className="n">{formatBytes(stats.disk.videos)}</div>
            <div className="l">Video storage</div>
          </div>
          <div className="stat">
            <div className="n">{formatBytes(stats.disk.originals)}</div>
            <div className="l">Kept originals</div>
          </div>
          <div className="stat">
            <div className="n">{stats.queue.current ? stats.queue.waiting + 1 : stats.queue.waiting}</div>
            <div className="l">{stats.queue.current ? 'Processing now' : 'Processing queue'}</div>
          </div>
        </div>
      )}

      <div className="admin-grid">
        <section className="card-panel">
          <h2>Site settings</h2>
          {form ? (
            <form onSubmit={save}>
              <div className="field">
                <label>Site name</label>
                <input className="input" value={form.site_name} maxLength={40} onChange={(e) => set({ site_name: e.target.value })} required />
              </div>
              <div className="field">
                <label>Public URL (optional)</label>
                <input className="input" value={form.public_url} placeholder="https://clips.example.com" onChange={(e) => set({ public_url: e.target.value })} />
                <span className="hint">Used for link previews when sharing to Discord etc. Leave empty to use whatever address viewers connect with.</span>
              </div>
              <label className="checkbox field">
                <input type="checkbox" checked={form.allow_registration === 'true'} onChange={(e) => set({ allow_registration: e.target.checked ? 'true' : 'false' })} />
                Allow new people to create accounts
              </label>
              <div className="field">
                <label>Max upload size (MB)</label>
                <input className="input" type="number" min={1} value={form.max_upload_mb} onChange={(e) => set({ max_upload_mb: e.target.value })} />
              </div>
              <div className="field">
                <label>Max resolution</label>
                <select className="select" value={form.max_height} onChange={(e) => set({ max_height: e.target.value })}>
                  <option value="480">480p</option>
                  <option value="720">720p</option>
                  <option value="1080">1080p</option>
                  <option value="1440">1440p</option>
                  <option value="2160">2160p (4K)</option>
                </select>
                <span className="hint">Taller videos are scaled down when processed. Smaller files mean smoother playback over Wi-Fi.</span>
              </div>
              <div className="field">
                <label>Video encoder</label>
                <select className="select" value={form.encoder} onChange={(e) => set({ encoder: e.target.value })}>
                  {encoders.map((enc) => (
                    <option key={enc} value={enc}>
                      {ENCODER_LABELS[enc] || enc}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  Used only when a clip needs re-encoding (anything that is not already H.264 MP4). GPU encoders are much faster; if one fails it falls back to libx264 automatically.
                </span>
              </div>
              <label className="checkbox field">
                <input type="checkbox" checked={form.delete_originals === 'true'} onChange={(e) => set({ delete_originals: e.target.checked ? 'true' : 'false' })} />
                Delete the original file after re-encoding (saves disk, loses the lossless source)
              </label>
              <button className="btn btn-primary" disabled={busy}>
                Save settings
              </button>
            </form>
          ) : (
            <div className="spinner" />
          )}
        </section>

        <section className="card-panel">
          <h2>Users</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Joined</th>
                  <th>Videos</th>
                  <th>Storage</th>
                  <th>Role</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link to={`/c/${u.username}`} className="user-cell">
                        <Avatar user={u} size={32} />
                        <div>
                          <div>{u.display_name}</div>
                          <div className="muted">@{u.username}</div>
                        </div>
                      </Link>
                    </td>
                    <td>{formatDate(u.created_at)}</td>
                    <td>{u.video_count}</td>
                    <td>{formatBytes(u.bytes)}</td>
                    <td>
                      <button className={`badge ${u.is_admin ? 'ok' : ''}`} onClick={() => toggleAdmin(u)} disabled={u.id === user.id} title={u.id === user.id ? 'You cannot change your own role' : 'Toggle admin'}>
                        {u.is_admin ? 'Admin' : 'Member'}
                      </button>
                    </td>
                    <td>
                      {u.id !== user.id && (
                        <button className="icon-btn" onClick={() => deleteUser(u)} title="Delete user and their videos">
                          <Icon name="delete" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {stats && (
        <p className="muted small">
          ffmpeg: {stats.tools.ffmpeg}
          <br />
          ffprobe: {stats.tools.ffprobe}
        </p>
      )}
    </div>
  );
}
