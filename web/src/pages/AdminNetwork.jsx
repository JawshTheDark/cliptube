import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { AdminTabs } from './Admin.jsx';
import { AdmissionPanel, BlocklistsPanel, PeersPanel } from '../components/NetworkPeers.jsx';
import { timeAgo } from '../util.js';

const MEMBER_STATUS = {
  approved: ['ok', 'Connected'],
  pending: ['warn', 'Waiting for the hub to approve'],
  suspended: ['err', 'Suspended by the hub'],
  banned: ['err', 'Banned by the hub'],
  removed: ['err', 'Removed from the network'],
};

const HUB_MEMBER_STATUS = {
  approved: ['ok', 'Active'],
  pending: ['warn', 'Waiting for approval'],
  suspended: ['warn', 'Suspended'],
  banned: ['err', 'Banned'],
};

function Badge({ map, status }) {
  const [cls, label] = map[status] || ['', status || 'Not connected'];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span className="toggle-text">
        <b>{label}</b>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export default function AdminNetwork() {
  const { refresh } = useAuth();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [hubForm, setHubForm] = useState(null);
  const [hubUrl, setHubUrl] = useState('');
  const [blockUrl, setBlockUrl] = useState('');
  const [busy, setBusy] = useState(null);
  useTitle('Network');

  const apply = useCallback((s) => {
    setState(s);
    setHubForm(s.hub.settings);
    setHubUrl((u) => u || s.member.hub_url || '');
  }, []);

  useEffect(() => {
    api('/admin/network').then(apply).catch((e) => toast(e.message));
  }, [apply, toast]);

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      const s = await fn();
      apply(s);
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(s) : okMsg);
      refresh().catch(() => {});
      return s;
    } catch (e) {
      toast(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!state || !hubForm) {
    return (
      <div className="page page-wide">
        <AdminTabs />
        <div className="spinner" />
      </div>
    );
  }

  const m = state.member;
  const hub = state.hub;
  const isHub = hub.enabled;
  const joined = m.enabled && !isHub;
  const hasHub = joined && !!m.status;
  const hubDirty = JSON.stringify(hubForm) !== JSON.stringify(hub.settings);
  const setHub = (patch) => setHubForm((f) => ({ ...f, ...patch }));
  const httpWarning = !state.self_url.startsWith('https://') && !state.allow_private;

  const memberAction = (inst, body, msg) => run(`m${inst.id}`, () => api(`/admin/network/hub/members/${inst.id}`, { method: 'PATCH', body }), msg);

  return (
    <div className="page page-wide">
      <AdminTabs />
      <h1>
        <Icon name="public" /> Network
        {isHub && <span className="badge ok">This instance is the hub</span>}
        {joined && <Badge map={MEMBER_STATUS} status={m.status} />}
      </h1>
      <p className="page-sub flush">
        Everyone hosts their own videos, and instances in a network browse and search each other's clips, with likes, comments and subscriptions across
        instances. A hub is the easy way in and can moderate the network, but instances also peer with each other directly, so the network keeps working if
        the hub goes away.
      </p>

      <div className="code-line">
        This instance's address: <code>{state.self_url}</code>
        {!state.public_url_set && <span className="hint"> (taken from the address you're using; set the Public URL under Overview to pin it)</span>}
      </div>
      {httpWarning && <div className="notice warn-box">Networks need HTTPS. Set this site's Public URL to its https:// address under Overview first.</div>}

      <div className="admin-grid">
        {/* ---- membership ---- */}
        {!isHub && (
          <section className="card-panel">
            <h2>Join a network</h2>
            {joined ? (
              <>
                <div className="net-status">
                  <div>
                    <div className="net-name">{m.network_name || (hasHub ? 'Network' : 'Peer-to-peer network')}</div>
                    <div className="fed-sub">
                      {hasHub ? (
                        <>
                          Hub:{' '}
                          <a href={m.hub_url} target="_blank" rel="noopener noreferrer">
                            {m.hub_url}
                          </a>
                        </>
                      ) : (
                        'No hub: connected through direct peers'
                      )}
                    </div>
                  </div>
                  {hasHub ? <Badge map={MEMBER_STATUS} status={m.status} /> : <span className={`badge ${state.active ? 'ok' : 'warn'}`}>{state.active ? 'Connected' : 'Waiting for peers'}</span>}
                </div>
                {m.note && <div className="fed-err">Hub says: {m.note}</div>}
                {m.announcement && <div className="announce">{m.announcement}</div>}
                <div className="kv">
                  <span className="muted">Clips from other instances</span>
                  <span>{m.video_count}</span>
                </div>
                <div className="kv">
                  <span className="muted">Last sync</span>
                  <span>{m.last_sync_at ? timeAgo(m.last_sync_at) : 'never'}</span>
                </div>
                <div className="kv">
                  <span className="muted">Network allows</span>
                  <span>
                    {['comments', 'likes', 'subscriptions'].filter((k) => m.policy[k]).join(', ') || 'browsing only'}
                  </span>
                </div>
                {m.last_error && <div className="fed-err">Last sync failed: {m.last_error}</div>}
                <div className="row-actions top-gap">
                  <button className="btn" disabled={!!busy} onClick={() => run('sync', () => api('/admin/network/sync', { method: 'POST' }), 'Synced with the hub')}>
                    <Icon name="refresh" /> Sync now
                  </button>
                  {hasHub && (
                    <button
                      className="btn btn-ghost"
                      disabled={!!busy}
                      title="Stop being a member of the hub, but keep exchanging clips with your direct peers"
                      onClick={() =>
                        window.confirm('Leave the hub but stay connected to your direct peers?') &&
                        run('leavehub', () => api('/admin/network/leave', { method: 'POST', body: { keep_peers: true } }), 'Left the hub; direct peers kept')
                      }
                    >
                      Leave hub only
                    </button>
                  )}
                  <button
                    className="btn btn-ghost"
                    disabled={!!busy}
                    onClick={() =>
                      window.confirm('Leave the network? Clips from other instances disappear from this site, and yours from theirs.') &&
                      run('leave', () => api('/admin/network/leave', { method: 'POST' }), 'Left the network')
                    }
                  >
                    Leave network
                  </button>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run('join', () => api('/admin/network/join', { method: 'POST', body: { url: hubUrl } }), (s) =>
                    s.member.status === 'approved'
                      ? `Joined ${s.member.network_name || 'the network'}`
                      : s.active
                        ? 'Connected to the network'
                        : s.member.status === 'pending'
                          ? 'Join request sent; the hub admin needs to approve it'
                          : 'Request sent; the instance admin needs to accept it',
                  );
                }}
              >
                <p className="muted">Off by default. While you're not in a network, nothing is shared and no other instance is contacted.</p>
                <div className="field">
                  <label>Hub or instance address</label>
                  <input className="input" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} placeholder="https://clips.irc.so" />
                  <span className="hint">A hub, or any instance that is already in the network. The rest of the network is found from there.</span>
                </div>
                <button className="btn btn-primary" disabled={busy === 'join' || !hubUrl.trim()}>
                  {busy === 'join' ? 'Joining…' : 'Join network'}
                </button>
              </form>
            )}

            <h3 className="sub-h">Accept from other instances</h3>
            <Toggle
              label="Comments"
              hint="People on other instances can comment on your videos."
              checked={m.accept.comments}
              onChange={(v) => run('acc', () => api('/admin/network/member', { method: 'PATCH', body: { accept_comments: v } }))}
            />
            <Toggle
              label="Likes"
              checked={m.accept.likes}
              onChange={(v) => run('acc', () => api('/admin/network/member', { method: 'PATCH', body: { accept_likes: v } }))}
            />
            <Toggle
              label="Subscriptions"
              checked={m.accept.subscriptions}
              onChange={(v) => run('acc', () => api('/admin/network/member', { method: 'PATCH', body: { accept_subscriptions: v } }))}
            />
          </section>
        )}

        {/* ---- hub mode ---- */}
        <section className="card-panel">
          <h2>Run the network (hub mode)</h2>
          <Toggle
            label="This instance is the hub"
            hint={joined ? 'Leave your current network first.' : 'Other instances join here. Your own videos stay part of the network too.'}
            checked={isHub}
            disabled={joined || !!busy}
            onChange={(v) =>
              (v || window.confirm('Turn off hub mode? Every instance in the network loses access to the shared index until you turn it back on.')) &&
              run('hub', () => api('/admin/network/hub', { method: 'PATCH', body: { enabled: v } }), v ? 'Hub mode is on' : 'Hub mode is off')
            }
          />
          {isHub && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run('hubsave', () => api('/admin/network/hub', { method: 'PATCH', body: hubForm }), 'Hub settings saved');
              }}
            >
              <div className="field top-gap">
                <label>Network name</label>
                <input className="input" maxLength={60} value={hubForm.network_name} onChange={(e) => setHub({ network_name: e.target.value })} />
              </div>

              <h3 className="sub-h">Joining</h3>
              <Toggle
                label="Accept new instances"
                hint="Turn off to lock the network down. Existing members keep working."
                checked={hubForm.accept_new}
                onChange={(v) => setHub({ accept_new: v })}
              />
              <Toggle
                label="Require my approval"
                hint="New instances wait in the list below until you approve them."
                checked={hubForm.require_approval}
                disabled={!hubForm.accept_new}
                onChange={(v) => setHub({ require_approval: v })}
              />
              <Toggle label="HTTPS only" hint="Refuse instances that aren't served over HTTPS." checked={hubForm.require_https} onChange={(v) => setHub({ require_https: v })} />

              <h3 className="sub-h">Across the whole network</h3>
              <Toggle label="Comments between instances" checked={hubForm.allow_comments} onChange={(v) => setHub({ allow_comments: v })} />
              <Toggle label="Likes between instances" checked={hubForm.allow_likes} onChange={(v) => setHub({ allow_likes: v })} />
              <Toggle label="Subscriptions between instances" checked={hubForm.allow_subscriptions} onChange={(v) => setHub({ allow_subscriptions: v })} />
              <Toggle
                label="Include this instance's videos"
                hint="Share the hub's own public videos with the network."
                checked={hubForm.include_own_videos}
                onChange={(v) => setHub({ include_own_videos: v })}
              />

              <div className="field-row top-gap">
                <div className="field">
                  <label>Max videos per instance</label>
                  <input className="input" type="number" min={1} value={hubForm.max_videos_per_instance} onChange={(e) => setHub({ max_videos_per_instance: e.target.value })} />
                </div>
                <div className="field">
                  <label>Sync every (minutes)</label>
                  <input className="input" type="number" min={1} max={1440} value={hubForm.sync_minutes} onChange={(e) => setHub({ sync_minutes: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Announcement</label>
                <textarea
                  className="textarea"
                  rows={2}
                  maxLength={1000}
                  value={hubForm.announcement}
                  onChange={(e) => setHub({ announcement: e.target.value })}
                  placeholder="Shown at the top of the Network page on every instance"
                />
              </div>
              <button className="btn btn-primary" disabled={!hubDirty || busy === 'hubsave'}>
                Save hub settings
              </button>
            </form>
          )}
        </section>
      </div>

      {/* ---- hub members ---- */}
      {isHub && (
        <section className="card-panel">
          <div className="section-head">
            <h2>Instances in the network ({hub.members.length})</h2>
            <button className="btn btn-sm" disabled={!!busy} onClick={() => run('syncall', () => api('/admin/network/sync', { method: 'POST' }), 'Pulled every instance')}>
              <Icon name="refresh" /> Sync all
            </button>
          </div>
          {hub.members.length === 0 ? (
            <p className="muted">No instances have joined yet. Point another ClipTube at {state.self_url} under Admin → Network.</p>
          ) : (
            <div className="fed-list">
              {hub.members.map((i) => (
                <div key={i.id} className="fed-item">
                  <div className="fed-main">
                    <div className="fed-name">
                      <a href={i.url} target="_blank" rel="noopener noreferrer">
                        {i.name}
                      </a>
                      <Badge map={HUB_MEMBER_STATUS} status={i.status} />
                      {!i.listed && <span className="badge">Videos hidden</span>}
                      {!i.allow_interactions && <span className="badge">No likes or comments</span>}
                    </div>
                    <div className="fed-sub">
                      {i.url} · {i.video_count} clip{i.video_count === 1 ? '' : 's'} · joined {timeAgo(i.created_at)}
                      {i.last_seen_at ? ` · seen ${timeAgo(i.last_seen_at)}` : ''}
                      {i.version ? ` · v${i.version}` : ''}
                    </div>
                    {i.note && <div className="fed-sub">Note: {i.note}</div>}
                    {i.last_error && <div className="fed-err">{i.last_error}</div>}
                  </div>
                  <div className="row-actions">
                    {i.status === 'pending' && (
                      <button className="btn btn-sm btn-primary" onClick={() => memberAction(i, { status: 'approved' }, `Approved ${i.name}`)}>
                        Approve
                      </button>
                    )}
                    {i.status === 'approved' && (
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          const note = window.prompt(`Suspend ${i.name}? Its videos leave the network until you unsuspend it. Reason (shown to them):`, '');
                          if (note !== null) memberAction(i, { status: 'suspended', note }, `Suspended ${i.name}`);
                        }}
                      >
                        Suspend
                      </button>
                    )}
                    {(i.status === 'suspended' || i.status === 'banned') && (
                      <button className="btn btn-sm" onClick={() => memberAction(i, { status: 'approved', note: '' }, `${i.name} is active again`)}>
                        {i.status === 'banned' ? 'Unban' : 'Unsuspend'}
                      </button>
                    )}
                    {i.status !== 'banned' && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          const note = window.prompt(`Ban ${i.name} from the network? It can't rejoin until you unban it. Reason:`, '');
                          if (note !== null) memberAction(i, { status: 'banned', note }, `Banned ${i.name}`);
                        }}
                      >
                        Ban
                      </button>
                    )}
                    <details className="more-menu">
                      <summary className="icon-btn" title="More">
                        <Icon name="more" />
                      </summary>
                      <div className="menu">
                        <button className="menu-item" onClick={() => memberAction(i, { allow_interactions: !i.allow_interactions })}>
                          {i.allow_interactions ? 'Stop its likes and comments' : 'Allow its likes and comments'}
                        </button>
                        <button className="menu-item" onClick={() => memberAction(i, { listed: !i.listed })}>
                          {i.listed ? 'Hide its videos from the network' : 'Show its videos in the network'}
                        </button>
                        <button className="menu-item" onClick={() => run(`s${i.id}`, () => api(`/admin/network/hub/members/${i.id}/sync`, { method: 'POST' }), `Pulled ${i.name}`)}>
                          Sync now
                        </button>
                        <button
                          className="menu-item"
                          onClick={() =>
                            window.confirm(`Remove ${i.name}? It can join again later (unless the network is locked).`) &&
                            run(`d${i.id}`, () => api(`/admin/network/hub/members/${i.id}`, { method: 'DELETE' }), `Removed ${i.name}`)
                          }
                        >
                          Remove from the list
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {state.participating && (
        <div className="admin-grid">
          <PeersPanel state={state} run={run} busy={busy} />
          <div className="stack">
            <AdmissionPanel key={state.max_peers} state={state} run={run} />
            <BlocklistsPanel state={state} run={run} busy={busy} />
          </div>
        </div>
      )}

      {/* ---- blocking ---- */}
      <section className="card-panel">
        <h2>Blocked instances</h2>
        <p className="hint">
          Blocking an instance hides its videos here and refuses likes, comments and subscriptions from its people.
          {isHub ? ' To remove an instance from the whole network, ban it above.' : ''}
        </p>
        <form
          className="follow-form"
          onSubmit={(e) => {
            e.preventDefault();
            run('block', () => api('/admin/network/instances/block', { method: 'POST', body: { url: blockUrl } }), 'Instance blocked').then((s) => s && setBlockUrl(''));
          }}
        >
          <input className="input" value={blockUrl} onChange={(e) => setBlockUrl(e.target.value)} placeholder="clips.example.com" aria-label="Instance to block" />
          <button className="btn" disabled={!blockUrl.trim() || busy === 'block'}>
            Block
          </button>
        </form>
        <div className="fed-list">
          {state.instances.map((i) => (
            <div key={i.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  {i.name}
                  {i.blocked && <span className="badge err">Blocked</span>}
                </div>
                <div className="fed-sub">
                  {i.url}
                  {!i.blocked ? ` · ${i.video_count} clip${i.video_count === 1 ? '' : 's'}` : ''}
                  {i.block_reason ? ` · ${i.block_reason}` : ''}
                  {i.block_source ? ' · from a list you follow' : ''}
                </div>
              </div>
              <button
                className={`btn btn-sm ${i.blocked ? '' : 'btn-ghost'}`}
                onClick={() => {
                  if (i.blocked) return run(`b${i.id}`, () => api(`/admin/network/instances/${i.id}`, { method: 'PATCH', body: { blocked: false } }), `Unblocked ${i.name}`);
                  const reason = window.prompt(`Block ${i.name}? Reason (optional, only you see it):`, '');
                  if (reason !== null) run(`b${i.id}`, () => api(`/admin/network/instances/${i.id}`, { method: 'PATCH', body: { blocked: true, reason } }), `Blocked ${i.name}`);
                }}
              >
                {i.blocked ? 'Unblock' : 'Block'}
              </button>
            </div>
          ))}
          {state.instances.length === 0 && <p className="muted">{joined ? 'No other instances in the network yet.' : 'Nothing blocked.'}</p>}
        </div>
      </section>

      {/* ---- hidden videos ---- */}
      {state.hidden.length > 0 && (
        <section className="card-panel">
          <h2>Hidden videos ({state.hidden.length})</h2>
          <p className="hint">{isHub ? 'Hidden from the whole network.' : 'Hidden on this site only.'}</p>
          <div className="fed-list">
            {state.hidden.map((h) => (
              <div key={`${h.instance_id}-${h.remote_id}`} className="fed-item">
                <div className="fed-main">
                  <div className="fed-name">
                    <a href={h.watch_url} target="_blank" rel="noopener noreferrer">
                      {h.title}
                    </a>
                  </div>
                  <div className="fed-sub">{h.peer_name}</div>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => run(`h${h.remote_id}`, () => api(`/admin/network/videos/${h.instance_id}/${h.remote_id}`, { method: 'PATCH', body: { hidden: false } }), 'Video shown again')}
                >
                  Show again
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
