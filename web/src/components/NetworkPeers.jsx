import { useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { timeAgo } from '../util.js';

const MINE = { approved: ['ok', 'Accepted'], pending: ['warn', 'Asked to peer'], rejected: ['err', 'Declined'] };
const THEIRS = { approved: ['ok', 'Accepts us'], pending: ['warn', 'Waiting for them'], rejected: ['err', 'Declined us'], left: ['', 'Left the network'] };

function Pill({ map, value }) {
  if (!value || !map[value]) return null;
  const [cls, label] = map[value];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <b>{label}</b>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Instances this one peers with directly: status both ways, health, and admin actions. */
export function PeersPanel({ state, run, busy }) {
  const [url, setUrl] = useState('');
  const peers = state.peers;
  const waiting = peers.filter((p) => p.peer_status === 'pending');
  const act = (p, body, msg) => run(`p${p.id}`, () => api(`/admin/network/peers/${p.id}`, { method: 'PATCH', body }), msg);
  return (
    <section className="card-panel">
      <h2>
        Direct peers ({peers.filter((p) => p.direct).length} connected{waiting.length ? `, ${waiting.length} waiting` : ''})
      </h2>
      <p className="hint">
        Instances this one exchanges clips with directly, so the network keeps working without a hub. Each one's key is checked at its own address. New peers
        are found through the hub and through other peers.
      </p>
      <form
        className="follow-form"
        onSubmit={(e) => {
          e.preventDefault();
          run('peer', () => api('/admin/network/peers', { method: 'POST', body: { url } }), (s) => {
            const p = s.peers.find((x) => x.url.includes(url.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')));
            return p?.remote_status === 'approved' ? `Peering with ${p.name}` : 'Request sent; their admin needs to accept it';
          }).then((s) => s && setUrl(''));
        }}
      >
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="clips.example.com" aria-label="Instance to peer with" />
        <button className="btn" disabled={!url.trim() || busy === 'peer'}>
          Peer with it
        </button>
      </form>
      <div className="fed-list">
        {peers.map((p) => (
          <div key={p.id} className="fed-item">
            <div className="fed-main">
              <div className="fed-name">
                {p.name}
                {p.direct && <span className="badge ok">Connected</span>}
                {!p.direct && <Pill map={MINE} value={p.peer_status} />}
                {!p.direct && <Pill map={THEIRS} value={p.remote_status} />}
                {p.in_hub && <span className="badge">In the hub</span>}
                {p.protocol < 3 && <span className="badge" title="An older OurTube: reachable through the hub only">Older version</span>}
              </div>
              <div className="fed-sub">
                {p.url} · {p.video_count} clip{p.video_count === 1 ? '' : 's'}
                {p.last_ok_at ? ` · synced ${timeAgo(p.last_ok_at)}` : ' · not synced yet'}
                {p.source === 'peer' ? ' · found through a peer' : p.source === 'hub' ? ' · from the hub' : p.source === 'inbound' ? ' · asked us' : ''}
              </div>
              {p.last_error && <div className="fed-err">{p.last_error}</div>}
            </div>
            <div className="row-actions end">
              {p.peer_status === 'pending' && (
                <>
                  <button className="btn btn-sm approve" disabled={!!busy} onClick={() => act(p, { status: 'approved' }, `Accepted ${p.name}`)}>
                    Accept
                  </button>
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => act(p, { status: 'rejected' }, `Declined ${p.name}`)}>
                    Decline
                  </button>
                </>
              )}
              {p.peer_status === 'rejected' && (
                <button className="btn btn-sm" disabled={!!busy} onClick={() => act(p, { status: 'approved' }, `Accepted ${p.name}`)}>
                  Accept
                </button>
              )}
              <button
                className="icon-btn"
                title="Forget this peer"
                disabled={!!busy}
                onClick={() =>
                  window.confirm(`Forget ${p.name}? Its clips disappear here until you peer again.`) &&
                  run(`f${p.id}`, () => api(`/admin/network/peers/${p.id}`, { method: 'DELETE' }), `Forgot ${p.name}`)
                }
              >
                <Icon name="close" />
              </button>
            </div>
          </div>
        ))}
        {peers.length === 0 && <p className="muted">No direct peers yet.</p>}
      </div>
    </section>
  );
}

/** Who may peer with this instance. On a hub the same switches decide who may join. */
export function AdmissionPanel({ state, run }) {
  const a = state.admission;
  const set = (body, msg) => run('adm', () => api('/admin/network/admission', { method: 'PATCH', body }), msg);
  const [max, setMax] = useState(String(state.max_peers));
  return (
    <section className="card-panel">
      <h2>Who can peer with this instance</h2>
      {state.role === 'hub' ? (
        <p className="hint">On the hub, the joining switches above also decide who can peer with it directly.</p>
      ) : (
        <>
          <Toggle
            label="Accept new instances"
            hint="Turn off to lock down: instances you already peer with keep working, nobody new gets in."
            checked={a.accept_new}
            onChange={(v) => set({ accept_new: v }, v ? 'Accepting new instances' : 'Locked down')}
          />
          <Toggle
            label="Ask me first"
            hint="New instances wait in the peer list until you accept them."
            checked={a.require_approval}
            onChange={(v) => set({ require_approval: v })}
          />
          <Toggle label="HTTPS only" hint="Refuse instances that aren't served over HTTPS." checked={a.require_https} onChange={(v) => set({ require_https: v })} />
        </>
      )}
      <Toggle
        label="Publish my block list"
        hint="Other instances can follow the instances you block (with your reasons) at /api/network/blocklist."
        checked={state.publish_blocklist}
        onChange={(v) => set({ publish_blocklist: v })}
      />
      <div className="field-row align-end top-gap">
        <div className="field narrow">
          <label>Most peers</label>
          <input className="input" type="number" min={1} max={5000} value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
        <div className="field">
          <button className="btn btn-sm" disabled={String(state.max_peers) === max} onClick={() => set({ max_peers: max }, 'Saved')}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}

/** Block lists this instance follows, with entries waiting for review. */
export function BlocklistsPanel({ state, run, busy }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('review');
  const patch = (b, body, msg) => run(`bl${b.id}`, () => api(`/admin/network/blocklists/${b.id}`, { method: 'PATCH', body }), msg);
  return (
    <section className="card-panel">
      <h2>Block lists you follow</h2>
      <p className="hint">
        Follow another instance's list of blocked instances. Automatic lists apply right away and undo themselves when the source takes a block back;
        review lists wait for you. Joining a hub follows the hub's list automatically, so its bans reach you even when you pull from peers directly.
      </p>
      <form
        className="follow-form"
        onSubmit={(e) => {
          e.preventDefault();
          run('blsub', () => api('/admin/network/blocklists', { method: 'POST', body: { url, mode } }), 'Following the list').then((s) => s && setUrl(''));
        }}
      >
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="clips.example.com" aria-label="Instance whose list to follow" />
        <select className="select select-inline" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="review">Review first</option>
          <option value="auto">Apply automatically</option>
        </select>
        <button className="btn" disabled={!url.trim() || busy === 'blsub'}>
          Follow
        </button>
      </form>
      <div className="fed-list">
        {state.blocklists.map((b) => (
          <div key={b.id} className="fed-item column">
            <div className="fed-row">
              <div className="fed-main">
                <div className="fed-name">
                  {b.url.replace(/^https?:\/\//, '')}
                  <span className={`badge ${b.mode === 'auto' ? 'ok' : ''}`}>{b.mode === 'auto' ? 'Automatic' : 'Review'}</span>
                </div>
                <div className="fed-sub">
                  {b.applied} applied{b.pending.length ? ` · ${b.pending.length} waiting` : ''}
                  {b.last_fetched_at ? ` · checked ${timeAgo(b.last_fetched_at)}` : ''}
                </div>
                {b.last_error && <div className="fed-err">{b.last_error}</div>}
              </div>
              <div className="row-actions end">
                <button className="btn btn-sm" disabled={!!busy} onClick={() => patch(b, { mode: b.mode === 'auto' ? 'review' : 'auto' })}>
                  {b.mode === 'auto' ? 'Review first' : 'Apply automatically'}
                </button>
                <button className="icon-btn" title="Check now" disabled={!!busy} onClick={() => patch(b, { refresh: true }, 'Checked')}>
                  <Icon name="refresh" />
                </button>
                <button
                  className="icon-btn"
                  title="Stop following"
                  disabled={!!busy}
                  onClick={() =>
                    window.confirm(`Stop following ${b.url}? Blocks that came from it are lifted.`) &&
                    run(`bld${b.id}`, () => api(`/admin/network/blocklists/${b.id}`, { method: 'DELETE' }), 'Stopped following')
                  }
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
            {b.pending.map((e) => (
              <div key={`${e.kind}${e.target}`} className="bl-entry">
                <span>
                  {e.kind === 'video' ? 'Video ' : ''}
                  <b>{e.target.replace(/^https?:\/\//, '')}</b>
                  {e.reason ? <span className="muted"> · {e.reason}</span> : null}
                </span>
                <span className="row-actions">
                  <button className="btn btn-sm" disabled={!!busy} onClick={() => patch(b, { entry: { kind: e.kind, target: e.target, status: 'applied' } }, 'Applied')}>
                    Apply
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => patch(b, { entry: { kind: e.kind, target: e.target, status: 'ignored' } })}>
                    Ignore
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
        {state.blocklists.length === 0 && <p className="muted">Not following any lists.</p>}
      </div>
    </section>
  );
}
