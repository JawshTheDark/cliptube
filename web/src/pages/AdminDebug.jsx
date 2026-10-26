import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { copyText, formatBytes, formatDate, timeAgo } from '../util.js';
import { AdminTabs } from './Admin.jsx';

const FOLDERS = {
  videos: 'Videos',
  originals: 'Kept originals',
  hls: 'Adaptive streaming',
  renditions: 'Lower qualities',
  thumbs: 'Thumbnails',
  avatars: 'Avatars and banners',
  captions: 'Captions',
  editor: 'Editor sources',
  exports: 'Exports',
  live: 'Live recordings',
  uploads: 'Uploads in progress',
  tmp: 'Temporary files',
};

function Row({ label, children }) {
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

const yesNo = (v, yes = 'Yes', no = 'No') => (v === null || v === undefined ? 'Off' : v ? yes : no);
function duration(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/** Admin -> Debugging: versions, FFmpeg, disk, the queue, the network and recent errors, and a report to copy. */
export default function AdminDebug() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle('Debugging');
  const load = () =>
    api('/admin/diagnostics')
      .then(setD)
      .catch((e) => toast(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = async (body) => {
    setBusy(true);
    try {
      const u = await api('/admin/diagnostics/update', { method: 'POST', body });
      setD((x) => ({ ...x, update: u }));
      if (body.check) toast(u.error ? `Could not check: ${u.error}` : u.available ? `OurTube ${u.latest} is out` : 'This is the newest version');
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <div className="page page-wide">
        <AdminTabs />
        <div className="spinner" />
      </div>
    );
  }
  const { app, update: u, tools, storage, database, jobs, network, live, email, log } = d;
  const lanes = Object.entries(jobs.lanes);
  return (
    <div className="page page-wide">
      <AdminTabs />
      <h1>
        <Icon name="settings" /> Debugging
      </h1>
      <p className="hint">
        What to look at, or send to whoever is helping, when something goes wrong.{' '}
        <button className="link-btn" onClick={() => copyText(JSON.stringify(d, null, 2)).then(() => toast('Report copied'))}>
          Copy the whole report
        </button>{' '}
        (no passwords or keys are in it).{' '}
        <button className="link-btn" onClick={load}>
          Refresh
        </button>
      </p>

      <div className="admin-grid">
        <section className="card-panel">
          <h2>Version</h2>
          <Row label="OurTube">{app.version}</Row>
          <Row label="Newest on GitHub">
            {u.latest ? (u.available ? <b>{u.latest} is out</b> : `${u.latest} (up to date)`) : 'not checked yet'}
          </Row>
          <Row label="Last checked">{u.checked_at ? timeAgo(u.checked_at) : 'never'}</Row>
          {u.error && <Row label="Last check failed">{u.error}</Row>}
          <label className="check-row top-gap">
            <input type="checkbox" checked={u.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} /> Check GitHub for new versions
            every 12 hours and tell admins
          </label>
          <div className="row-actions top-gap">
            <button className="btn btn-sm" disabled={busy || !u.enabled} onClick={() => update({ check: true })}>
              Check now
            </button>
            <a className="btn btn-sm btn-ghost" href={u.changes} target="_blank" rel="noopener noreferrer">
              What changed
            </a>
            <a className="btn btn-sm btn-ghost" href={`${u.repo}/blob/main/docs/wiki/Upgrading-and-Backups.md`} target="_blank" rel="noopener noreferrer">
              How to update
            </a>
          </div>
        </section>

        <section className="card-panel">
          <h2>Server</h2>
          <Row label="Running for">{duration(app.uptime_seconds)}</Row>
          <Row label="Node.js">{app.node}</Row>
          <Row label="System">
            {app.platform}
            {app.in_docker ? ', in Docker' : ''}
          </Row>
          <Row label="CPU cores">{app.cpus}</Row>
          <Row label="Memory used by OurTube">{formatBytes(app.memory.rss)}</Row>
          <Row label="Memory free on the machine">
            {formatBytes(app.memory.system_free)} of {formatBytes(app.memory.system_total)}
          </Row>
          <Row label="Public URL">{app.public_url || <span className="error-text">not set</span>}</Row>
          <Row label="Address this page used">{app.address_seen}</Row>
        </section>

        <section className="card-panel">
          <h2>FFmpeg</h2>
          <Row label="ffmpeg">{tools.ffmpeg.version}</Row>
          <p className="hint ellipsis">{tools.ffmpeg.path}</p>
          <Row label="ffprobe">{tools.ffprobe.version}</Row>
          <p className="hint ellipsis">{tools.ffprobe.path}</p>
          <Row label="Encoder in use">{tools.encoder}</Row>
          <Row label="GPU encoders in this build">{tools.hardware_encoders_built_in.length ? tools.hardware_encoders_built_in.join(', ') : 'none'}</Row>
          <p className="hint">Built in doesn&apos;t mean the GPU is there: a GPU encoder that fails falls back to the CPU and logs why below.</p>
        </section>

        <section className="card-panel">
          <h2>Storage</h2>
          {storage.disk && (
            <Row label="Free on the data disk">
              {formatBytes(storage.disk.free)} of {formatBytes(storage.disk.total)}
            </Row>
          )}
          <Row label="Database">{formatBytes(storage.database_bytes)}</Row>
          <Row label="Database backups">
            {formatBytes(storage.backups.bytes)} ({storage.backups.files})
          </Row>
          {Object.entries(FOLDERS).map(([k, label]) =>
            storage.folders[k] && storage.folders[k].bytes > 0 ? (
              <Row key={k} label={label}>
                {formatBytes(storage.folders[k].bytes)}
              </Row>
            ) : null,
          )}
          <p className="hint ellipsis">Data folder: {storage.data_dir}</p>
        </section>

        <section className="card-panel">
          <h2>Database</h2>
          <Row label="Schema version">{database.schema_version}</Row>
          <Row label="Journal mode">{database.journal_mode}</Row>
          <Row label="Accounts here">{database.users}</Row>
          <Row label="Videos here">{database.videos}</Row>
          <Row label="Videos from other servers">{database.network_videos}</Row>
        </section>

        <section className="card-panel">
          <h2>Network and fediverse</h2>
          <Row label="Role">{network.role ? `${network.role}${network.name ? ` of ${network.name}` : ''}` : 'not in a network'}</Row>
          <Row label="Servers with videos here">{network.peers.length}</Row>
          <Row label="ActivityPub">{network.activitypub.enabled ? 'on' : 'off'}</Row>
          <Row label="Following">
            {network.activitypub.following}
            {network.activitypub.following_pending ? ` (+${network.activitypub.following_pending} waiting)` : ''}
          </Row>
          <Row label="Followers">{network.activitypub.followers}</Row>
          <Row label="Live streaming">{live.enabled ? (live.server_answers ? 'on, MediaMTX answers' : <span className="error-text">on, but MediaMTX doesn&apos;t answer</span>) : 'off'}</Row>
          <Row label="Email">{yesNo(email.configured, 'set up', 'not set up')}</Row>
        </section>

        <section className="card-panel">
          <h2>Job queue</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Lane</th>
                  <th>Waiting</th>
                  <th>Running</th>
                  <th>Failed</th>
                  <th>Done</th>
                </tr>
              </thead>
              <tbody>
                {lanes.map(([lane, n]) => (
                  <tr key={lane}>
                    <td>{lane}</td>
                    <td>{n.queued}</td>
                    <td>{n.running}</td>
                    <td>{n.failed}</td>
                    <td>{n.done}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {jobs.running.length > 0 && <p className="hint top-gap">Running now: {jobs.running.map((j) => `${j.type} #${j.id}`).join(', ')}</p>}
          {jobs.recent_failures.length > 0 && (
            <>
              <h3 className="top-gap">Recent failures</h3>
              {jobs.recent_failures.map((f) => (
                <div key={f.id} className="kv">
                  <span className="muted">
                    {f.type} #{f.id}, {f.finished_at ? formatDate(f.finished_at) : ''}
                  </span>
                  <span>{f.last_error}</span>
                </div>
              ))}
            </>
          )}
        </section>
      </div>

      <section className="card-panel top-gap">
        <h2>Recent warnings and errors</h2>
        {log.length === 0 ? (
          <p className="muted">Nothing since the server started {timeAgo(app.started_at)}.</p>
        ) : (
          <pre className="code-block log-block">
            {log
              .slice()
              .reverse()
              .map((l) => `${new Date(l.at).toLocaleString()}  ${l.level === 'error' ? 'ERROR' : 'warn '}  ${l.text}`)
              .join('\n')}
          </pre>
        )}
      </section>
    </div>
  );
}
