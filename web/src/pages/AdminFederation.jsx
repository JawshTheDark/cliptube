import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { AdminTabs } from './Admin.jsx';
import { timeAgo } from '../util.js';

const PEER_STATUS = {
  approved: ['ok', 'Connected'],
  pending: ['warn', 'Waiting for approval'],
  rejected: ['err', 'Rejected'],
  error: ['err', 'Could not connect'],
};

const FOLLOWER_STATUS = {
  approved: ['ok', 'Approved'],
  pending: ['warn', 'Wants to follow'],
  blocked: ['err', 'Blocked'],
};

function Badge({ map, status }) {
  const [cls, label] = map[status] || ['', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function AdminFederation() {
  const { refresh } = useAuth();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [form, setForm] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(null);
  useTitle('Federation');

  const apply = useCallback((s) => {
    setState(s);
    setForm({ enabled: s.settings.enabled, mode: s.settings.mode, description: s.settings.description });
  }, []);

  useEffect(() => {
    api('/admin/federation').then(apply).catch((e) => toast(e.message));
  }, [apply, toast]);

  // Keep statuses fresh while something is pending.
  const waiting = state?.peers.some((p) => p.status === 'pending');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => api('/admin/federation').then(setState).catch(() => {}), 10000);
    return () => clearInterval(t);
  }, [waiting]);

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      const s = await fn();
      setState(s);
      if (okMsg) toast(okMsg);
      refresh().catch(() => {});
      return s;
    } catch (e) {
      toast(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!state || !form) {
    return (
      <div className="page page-wide">
        <AdminTabs />
        <div className="spinner" />
      </div>
    );
  }

  const saveSettings = (e) => {
    e.preventDefault();
    run('settings', () => api('/admin/federation', { method: 'PATCH', body: form }), 'Federation settings saved').then((s) => s && apply(s));
  };

  const follow = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    const s = await run('follow', () => api('/admin/federation/peers', { method: 'POST', body: { url } }));
    if (s) {
      setUrl('');
      const p = s.peers[s.peers.length - 1];
      toast(p?.status === 'approved' ? `Connected to ${p.name}` : `Follow request sent${p ? ` to ${p.name}` : ''}. They need to approve it.`);
    }
  };

  const enabled = state.settings.enabled;
  const httpsWarning = state.self_url.startsWith('http://') && !state.allow_private;

  return (
    <div className="page page-wide">
      <AdminTabs />
      <h1>
        <Icon name="public" /> Federation
      </h1>
      <p className="page-sub flush">
        Connect this site to other ClipTube instances. Everyone keeps hosting their own videos; followed instances' public clips show up in the
        Network feed and in search here, and stream straight from the server that hosts them.
      </p>

      <div className="admin-grid">
        <section className="card-panel">
          <h2>This instance</h2>
          <form onSubmit={saveSettings}>
            <label className="checkbox field">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              <span>
                <b>Take part in federation</b>
                <br />
                <span className="hint">Off by default. While off, nothing is shared and no other instance is contacted.</span>
              </span>
            </label>
            <div className="field">
              <label>Who can follow this instance</label>
              <select className="select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="approval">Only instances I approve</option>
                <option value="open">Any instance (approved automatically)</option>
              </select>
              <span className="hint">Followers can list the public videos you mark as shared. Private and unlisted videos never leave this server.</span>
            </div>
            <div className="field">
              <label>Description shown to other instances</label>
              <textarea className="textarea" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="field">
              <label>Your instance address</label>
              <div className="code-box">{state.self_url}</div>
              {!state.public_url_set && <span className="hint">Taken from the address you are using right now. Set the Public URL under Overview to pin it.</span>}
              {httpsWarning && <span className="hint warn-text">Other instances will reach you over plain HTTP. Use HTTPS so their visitors can play your clips.</span>}
            </div>
            <button className="btn btn-primary" disabled={busy === 'settings'}>
              Save
            </button>
          </form>
        </section>

        <section className="card-panel">
          <h2>Follow an instance</h2>
          {!enabled ? (
            <p className="muted">Turn on federation first.</p>
          ) : (
            <form onSubmit={follow} className="follow-form">
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="clips.example.com" aria-label="Instance address" />
              <button className="btn btn-primary" disabled={busy === 'follow' || !url.trim()}>
                {busy === 'follow' ? 'Connecting…' : 'Follow'}
              </button>
            </form>
          )}
          <p className="hint">The other instance has to have federation turned on. If it only accepts approved followers, its admin sees your request.</p>

          <h3 className="sub-h">Following ({state.peers.length})</h3>
          {state.peers.length === 0 ? (
            <p className="muted">Not following anyone yet.</p>
          ) : (
            <div className="fed-list">
              {state.peers.map((p) => (
                <div key={p.id} className="fed-item">
                  <div className="fed-main">
                    <div className="fed-name">
                      <a href={p.url} target="_blank" rel="noopener noreferrer">
                        {p.name}
                      </a>
                      <Badge map={PEER_STATUS} status={p.status} />
                      {p.paused && <span className="badge">Paused</span>}
                    </div>
                    <div className="fed-sub">
                      {p.url} · {p.video_count} clip{p.video_count === 1 ? '' : 's'}
                      {p.last_sync_at ? ` · synced ${timeAgo(p.last_sync_at)}` : ''}
                    </div>
                    {p.last_error && <div className="fed-err">{p.last_error}</div>}
                  </div>
                  <div className="row-actions">
                    <button className="icon-btn" title={p.status === 'error' ? 'Retry' : 'Sync now'} disabled={!!busy} onClick={() => run(`sync${p.id}`, () => api(`/admin/federation/peers/${p.id}/sync`, { method: 'POST' }), 'Synced')}>
                      <Icon name="refresh" />
                    </button>
                    <button className="btn btn-sm" onClick={() => run(`pause${p.id}`, () => api(`/admin/federation/peers/${p.id}`, { method: 'PATCH', body: { paused: !p.paused } }))}>
                      {p.paused ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      className="icon-btn"
                      title="Unfollow"
                      onClick={() => window.confirm(`Unfollow ${p.name}? Their clips disappear from this site.`) && run(`del${p.id}`, () => api(`/admin/federation/peers/${p.id}`, { method: 'DELETE' }), 'Unfollowed')}
                    >
                      <Icon name="delete" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card-panel">
        <h2>Followers ({state.followers.length})</h2>
        <p className="hint">Instances that index your public clips. Blocking one cuts off its access immediately.</p>
        {state.followers.length === 0 ? (
          <p className="muted">No other instance follows this one yet.</p>
        ) : (
          <div className="fed-list">
            {state.followers.map((f) => (
              <div key={f.id} className="fed-item">
                <div className="fed-main">
                  <div className="fed-name">
                    <a href={f.url} target="_blank" rel="noopener noreferrer">
                      {f.name}
                    </a>
                    <Badge map={FOLLOWER_STATUS} status={f.status} />
                  </div>
                  <div className="fed-sub">
                    {f.url} · since {timeAgo(f.created_at)}
                    {f.last_seen_at ? ` · last synced ${timeAgo(f.last_seen_at)}` : ''}
                  </div>
                </div>
                <div className="row-actions">
                  {f.status !== 'approved' && (
                    <button className="btn btn-sm btn-primary" onClick={() => run(`ap${f.id}`, () => api(`/admin/federation/followers/${f.id}`, { method: 'PATCH', body: { status: 'approved' } }), `Approved ${f.name}`)}>
                      Approve
                    </button>
                  )}
                  {f.status !== 'blocked' && (
                    <button className="btn btn-sm" onClick={() => run(`bl${f.id}`, () => api(`/admin/federation/followers/${f.id}`, { method: 'PATCH', body: { status: 'blocked' } }), `Blocked ${f.name}`)}>
                      Block
                    </button>
                  )}
                  {!f.following_back && enabled && (
                    <button className="btn btn-sm" onClick={() => run(`fb${f.id}`, () => api('/admin/federation/peers', { method: 'POST', body: { url: f.url } }), `Follow request sent to ${f.name}`)}>
                      Follow back
                    </button>
                  )}
                  <button className="icon-btn" title="Remove" onClick={() => run(`rm${f.id}`, () => api(`/admin/federation/followers/${f.id}`, { method: 'DELETE' }))}>
                    <Icon name="delete" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
