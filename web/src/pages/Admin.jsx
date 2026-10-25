import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { copyText, formatBytes, formatDate } from '../util.js';

const ENCODER_LABELS = {
  libx264: 'libx264 (CPU, works everywhere)',
  h264_nvenc: 'NVIDIA NVENC (GPU)',
  h264_qsv: 'Intel Quick Sync (GPU)',
  h264_amf: 'AMD AMF (GPU)',
};

const tabClass = ({ isActive }) => `tab ${isActive ? 'active' : ''}`;

export function AdminTabs() {
  const { user } = useAuth();
  const admin = !!user?.is_admin;
  return (
    <div className="tabs admin-tabs">
      {admin && (
        <NavLink to="/admin" end className={tabClass}>
          Overview
        </NavLink>
      )}
      <NavLink to="/admin/moderation" className={tabClass}>
        Moderation
      </NavLink>
      <NavLink to="/admin/games" className={tabClass}>
        Games
      </NavLink>
      {admin && (
        <NavLink to="/admin/legal" className={tabClass}>
          Legal
        </NavLink>
      )}
      {admin && (
        <NavLink to="/admin/network" className={tabClass}>
          Network
        </NavLink>
      )}
    </div>
  );
}

const REGISTRATION_HELP = {
  open: 'Anyone can create an account.',
  approval: 'Anyone can sign up, but an admin approves each account before it can sign in. Invite links skip approval.',
  invite: 'Only people with an invite link can sign up.',
  closed: 'Nobody can sign up.',
};

function quotaLabel(u) {
  if (u.quota_mb === null || u.quota_mb === undefined) return 'site default';
  if (u.quota_mb === 0) return 'unlimited';
  return formatBytes(u.quota_mb * 1048576);
}

function Invites() {
  const toast = useToast();
  const [invites, setInvites] = useState(null);
  const [draft, setDraft] = useState({ note: '', max_uses: 1, expires_days: 14 });
  const load = () => api('/admin/invites').then((r) => setInvites(r.invites)).catch((e) => toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const link = (code) => `${window.location.origin}/register?invite=${code}`;
  const create = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/admin/invites', { method: 'POST', body: draft });
      await copyText(link(r.invite.code));
      toast('Invite created and its link copied');
      setDraft({ ...draft, note: '' });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async (code) => {
    try {
      await api(`/admin/invites/${code}`, { method: 'DELETE' });
      setInvites((list) => list.filter((i) => i.code !== code));
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel">
      <h2>Invites</h2>
      <p className="hint">Invite links let people join when sign-up is invite-only, and skip approval when it needs approval.</p>
      <form onSubmit={create} className="field-row align-end">
        <div className="field grow">
          <label>Note</label>
          <input className="input" value={draft.note} maxLength={200} placeholder="Who it's for" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </div>
        <div className="field narrow">
          <label>Uses</label>
          <input className="input" type="number" min={0} value={draft.max_uses} onChange={(e) => setDraft({ ...draft, max_uses: e.target.value })} title="0 = unlimited" />
        </div>
        <div className="field narrow">
          <label>Days</label>
          <input className="input" type="number" min={0} value={draft.expires_days} onChange={(e) => setDraft({ ...draft, expires_days: e.target.value })} title="0 = never expires" />
        </div>
        <div className="field">
          <button className="btn btn-primary">Create</button>
        </div>
      </form>
      {invites === null ? (
        <div className="spinner" />
      ) : invites.length === 0 ? (
        <p className="muted">No invites yet.</p>
      ) : (
        <div className="fed-list">
          {invites.map((i) => {
            const expired = i.expires_at && i.expires_at < Date.now();
            const used = i.max_uses > 0 && i.uses >= i.max_uses;
            return (
              <div key={i.code} className="fed-item">
                <div className="fed-main">
                  <div className="fed-name">
                    <code>{i.code}</code>
                    {i.note && <span>{i.note}</span>}
                    {(expired || used) && <span className="badge">{expired ? 'expired' : 'used up'}</span>}
                  </div>
                  <div className="fed-sub">
                    Used {i.uses}
                    {i.max_uses > 0 ? ` of ${i.max_uses}` : ''} · {i.expires_at ? `expires ${formatDate(i.expires_at)}` : 'never expires'}
                    {i.created_by_name ? ` · by @${i.created_by_name}` : ''}
                  </div>
                </div>
                <div className="row-actions end">
                  <button className="icon-btn" title="Copy link" onClick={async () => toast((await copyText(link(i.code))) ? 'Link copied' : link(i.code))}>
                    <Icon name="link" />
                  </button>
                  <button className="icon-btn" title="Delete invite" onClick={() => remove(i.code)}>
                    <Icon name="delete" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

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

  const updateUser = async (u, body, message) => {
    try {
      const r = await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, ...r.user, status_reason: body.reason ?? x.status_reason } : x)));
      if (message) toast(message);
    } catch (err) {
      toast(err.message);
    }
  };

  const changeStatus = (u, status) => {
    if (status === 'active') return updateUser(u, { status }, u.status === 'pending' ? `@${u.username} is approved` : `@${u.username} is active again`);
    const reason = window.prompt(`${status === 'banned' ? 'Ban' : 'Suspend'} @${u.username}? They are signed out and can't sign in. Reason (shown to them):`, '');
    if (reason !== null) updateUser(u, { status, reason }, `@${u.username} is ${status}`);
  };

  const setQuota = (u) => {
    const v = window.prompt(`Storage quota for @${u.username} in MB.\nLeave empty for the site default, 0 for unlimited.`, u.quota_mb ?? '');
    if (v === null) return;
    updateUser(u, { quota_mb: v.trim() === '' ? null : v.trim() }, 'Quota updated');
  };

  const deleteUser = async (u, pending = false) => {
    const q = pending
      ? `Reject @${u.username}'s sign-up? Their account is deleted.`
      : `Delete @${u.username} and ALL of their videos (${u.video_count})?\n\nThis cannot be undone.`;
    if (!window.confirm(q)) return;
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
      <AdminTabs />
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
            <div className="l">{stats.queue.current ? 'Processing now' : 'Processing queue'}{stats.rendering ? ` · ${stats.rendering} edit render(s)` : ''}</div>
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
              <div className="field">
                <label>Sign-up</label>
                <select className="select" value={form.registration_mode} onChange={(e) => set({ registration_mode: e.target.value })}>
                  <option value="open">Open</option>
                  <option value="approval">Needs approval</option>
                  <option value="invite">Invite only</option>
                  <option value="closed">Closed</option>
                </select>
                <span className="hint">{REGISTRATION_HELP[form.registration_mode]}</span>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Max upload size (MB)</label>
                  <input className="input" type="number" min={1} value={form.max_upload_mb} onChange={(e) => set({ max_upload_mb: e.target.value })} />
                </div>
                <div className="field">
                  <label>Storage per person (MB)</label>
                  <input className="input" type="number" min={0} value={form.default_quota_mb} onChange={(e) => set({ default_quota_mb: e.target.value })} />
                  <span className="hint">0 = unlimited. Override per person below.</span>
                </div>
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
              <div className="field">
                <label>Adaptive streaming (HLS)</label>
                <select className="select" value={form.hls_ladder} onChange={(e) => set({ hls_ladder: e.target.value })}>
                  <option value="off">Off: play the MP4 only</option>
                  <option value="720">720p plus source quality</option>
                  <option value="full">1080p, 720p and 480p plus source quality</option>
                </select>
                <span className="hint">
                  Viewers on slow connections get a smaller stream and can pick a quality; source quality is always offered. Uses roughly 50 to 100% more
                  disk per video, and each video is re-encoded once in the background. Changing this rebuilds every video.
                </span>
              </div>
              <label className="checkbox field">
                <input type="checkbox" checked={form.federation_rendition === 'true'} onChange={(e) => set({ federation_rendition: e.target.checked ? 'true' : 'false' })} />
                Keep a 720p copy of large videos for other platforms (Mastodon and others only cache small videos)
              </label>
              <label className="checkbox field">
                <input type="checkbox" checked={form.show_dislikes === 'true'} onChange={(e) => set({ show_dislikes: e.target.checked ? 'true' : 'false' })} />
                Show dislike counts (uploaders always see their own)
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
                  <th title="Active copyright strikes">Strikes</th>
                  <th>Role</th>
                  <th>Status</th>
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
                    <td>
                      <button className="link-btn" onClick={() => setQuota(u)} title="Change storage quota">
                        {formatBytes(u.bytes)}
                        <span className="muted"> / {quotaLabel(u)}</span>
                      </button>
                    </td>
                    <td>
                      {u.strikes > 0 ? (
                        <button
                          className="link-btn"
                          title="Clear strikes"
                          onClick={() => window.confirm(`Clear @${u.username}'s strikes?`) && updateUser(u, { clear_strikes: true }, 'Strikes cleared')}
                        >
                          {u.strikes}
                        </button>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td>
                      <select
                        className="select select-inline"
                        value={u.role}
                        disabled={u.id === user.id}
                        title={u.id === user.id ? 'You cannot change your own role' : 'Role'}
                        onChange={(e) => updateUser(u, { role: e.target.value }, `@${u.username} is now ${e.target.value}`)}
                      >
                        <option value="user">Member</option>
                        <option value="moderator">Moderator</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td>
                      {u.id === user.id ? (
                        <span className="badge ok">Active</span>
                      ) : u.status === 'pending' ? (
                        <span className="row-actions">
                          <button className="btn btn-sm approve" onClick={() => changeStatus(u, 'active')}>
                            Approve
                          </button>
                          <button className="btn btn-sm" onClick={() => deleteUser(u, true)}>
                            Reject
                          </button>
                        </span>
                      ) : (
                        <select
                          className={`select select-inline status-${u.status}`}
                          value={u.status}
                          title={u.status_reason || 'Account status'}
                          onChange={(e) => changeStatus(u, e.target.value)}
                        >
                          <option value="active">Active</option>
                          <option value="suspended">Suspended</option>
                          <option value="banned">Banned</option>
                        </select>
                      )}
                    </td>
                    <td>
                      {u.delete_requested_at && (
                        <span className="badge warn" title={`Asked to delete their account on ${formatDate(u.delete_requested_at)}`}>
                          deleting
                        </span>
                      )}
                      {u.id !== user.id && u.status !== 'pending' && (
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

        <Invites />
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
