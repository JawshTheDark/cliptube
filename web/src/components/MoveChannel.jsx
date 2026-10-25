import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';
import { useToast } from './Toast.jsx';
import { copyText, formatBytes, formatDate } from '../util.js';

const RUNNING = ['queued', 'working', 'downloading'];

/** Settings: take a channel to another site (export, import, aliases, the move itself). */
export function MoveSettings() {
  return (
    <section className="card-panel" id="move">
      <h2>
        <Icon name="public" /> Moving to another site
      </h2>
      <p className="hint">
        Take your channel to another ClipTube instance: export it here, import it there, then move. Subscribers here, on other instances and on the fediverse
        follow you to the new channel. <Link to="/help/fediverse">How moving works</Link>
      </p>
      <ExportPart />
      <ImportPart />
      <MovePart />
    </section>
  );
}

function usePolled(load, busy) {
  useEffect(() => {
    if (!busy) return undefined;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  });
}

function ExportPart() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => api('/me/channel-exports').then((r) => setList(r.exports)).catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);
  usePolled(load, list?.some((x) => RUNNING.includes(x.status)));
  const start = async () => {
    try {
      await api('/me/channel-exports', { method: 'POST' });
      toast('Preparing the export');
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async (x) => {
    try {
      await api(`/me/channel-exports/${x.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <>
      <h3 className="sub-h">1. Export this channel</h3>
      <p className="hint">One archive with your videos, thumbnails, captions, comments and subscriber list. It is kept for 7 days.</p>
      <button className="btn" onClick={start} disabled={!list || list.some((x) => RUNNING.includes(x.status))}>
        <Icon name="download" /> {list?.some((x) => RUNNING.includes(x.status)) ? 'Preparing…' : 'Export channel'}
      </button>
      {list?.length > 0 && (
        <div className="fed-list top-gap">
          {list.map((x) => (
            <div key={x.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  {x.status === 'ready' ? (
                    <a href={x.download_url} download>
                      Channel archive
                    </a>
                  ) : (
                    <span>Channel archive</span>
                  )}
                  <span className={`badge ${x.status === 'ready' ? 'ok' : x.status === 'failed' ? 'err' : 'warn'}`}>{x.status}</span>
                </div>
                <div className="fed-sub">
                  {x.size_bytes ? `${formatBytes(x.size_bytes)} · ` : ''}made {formatDate(x.created_at)}
                  {x.expires_at ? ` · expires ${formatDate(x.expires_at)}` : ''}
                  {x.error ? ` · ${x.error}` : ''}
                </div>
              </div>
              {x.link && (
                <button className="btn btn-ghost" title="For importing on the new site without downloading it first" onClick={async () => toast((await copyText(x.link)) ? 'Private link copied' : x.link)}>
                  <Icon name="link" /> Copy link
                </button>
              )}
              <button className="icon-btn" title="Delete" onClick={() => remove(x)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
      {list?.some((x) => x.link) && <p className="hint small">Anyone with the private link can download the archive until it expires, so only paste it on your new site.</p>}
    </>
  );
}

function ImportPart() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [url, setUrl] = useState('');
  const [profile, setProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const load = () => api('/me/channel-imports').then((r) => setList(r.imports)).catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);
  usePolled(load, list?.some((x) => RUNNING.includes(x.status)));
  const run = async (body) => {
    setBusy(true);
    try {
      await api('/me/channel-imports', { method: 'POST', body });
      toast('Import started');
      setUrl('');
      load();
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const upload = (file) => {
    const fd = new FormData();
    fd.append('apply_profile', profile ? 'true' : 'false');
    fd.append('archive', file);
    run(fd);
  };
  const running = list?.some((x) => RUNNING.includes(x.status));
  return (
    <>
      <h3 className="sub-h">2. Import a channel here</h3>
      <p className="hint">Paste the private link from the old site (the fastest way), or upload the archive. Your videos are processed again here.</p>
      <form
        className="follow-form"
        onSubmit={(e) => {
          e.preventDefault();
          run({ url: url.trim(), apply_profile: profile });
        }}
      >
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://old.example/api/channel-exports/…" aria-label="Export link" />
        <button className="btn" disabled={busy || running || !url.trim()}>
          Import
        </button>
      </form>
      <div className="row-actions top-gap">
        <button className="btn btn-ghost" disabled={busy || running} onClick={() => fileRef.current.click()}>
          <Icon name="upload" /> Upload archive (.tar)
        </button>
        <label className="check-row">
          <input type="checkbox" checked={profile} onChange={(e) => setProfile(e.target.checked)} /> Also bring over the name, description, picture and links
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".tar,application/x-tar"
          hidden
          onChange={(e) => {
            if (e.target.files[0]) upload(e.target.files[0]);
            e.target.value = '';
          }}
        />
      </div>
      {list?.length > 0 && (
        <div className="fed-list top-gap">
          {list.map((x) => (
            <div key={x.id} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  {x.stats?.source?.handle || x.source_url || 'Uploaded archive'}
                  <span className={`badge ${x.status === 'done' ? 'ok' : x.status === 'failed' ? 'err' : 'warn'}`}>
                    {x.status}
                    {RUNNING.includes(x.status) && x.progress ? ` ${x.progress}%` : ''}
                  </span>
                </div>
                <div className="fed-sub">
                  {x.status === 'done' && x.stats
                    ? `${x.stats.videos} videos, ${x.stats.comments} comments${x.stats.already_here ? `, ${x.stats.already_here} already here` : ''}${x.stats.skipped ? `, ${x.stats.skipped} missing from the archive` : ''}. ${x.stats.subscribers} subscribers on the old channel: they come along when you move it (step 3).`
                    : x.error || formatDate(x.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function MovePart() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/me/move').then(setS).catch(() => {});
  }, []);
  if (!s) return null;
  const run = async (fn, message) => {
    setBusy(true);
    try {
      setS(await fn());
      if (message) toast(message);
      return true;
    } catch (err) {
      toast(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const total = s.followers.fediverse + s.followers.here + s.followers.network;
  return (
    <>
      <h3 className="sub-h">3. Move</h3>
      {!s.enabled && <div className="notice warn-box">Moving needs ActivityPub and this site's Public URL. Ask an admin to turn them on.</div>}
      <div className="move-cols">
        <div>
          <h4>Moving here</h4>
          <p className="hint">
            On the new site, add the old account first. That proves both are yours: the old site checks for it before it moves anyone. This account is{' '}
            <code>{s.handles.account}</code>.
          </p>
          <form
            className="follow-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api('/me/aliases', { method: 'POST', body: { handle: alias.trim() } }), 'Old account added').then((ok) => ok && setAlias(''));
            }}
          >
            <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="@you@old-site.example" aria-label="Old account" disabled={!s.enabled} />
            <button className="btn" disabled={busy || !alias.trim() || !s.enabled}>
              Add
            </button>
          </form>
          {s.aliases.length > 0 && (
            <div className="fed-list top-gap">
              {s.aliases.map((a) => (
                <div key={a.id} className="fed-item">
                  <div className="fed-main">
                    <div className="fed-name">{a.name || a.handle}</div>
                    <div className="fed-sub">
                      {a.handle} · {a.type === 'Group' ? 'channel' : 'account'}
                    </div>
                  </div>
                  <button className="icon-btn" title="Remove" disabled={busy} onClick={() => run(() => api('/me/aliases', { method: 'DELETE', body: { id: a.id } }))}>
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <h4>Moving away</h4>
          {s.moved ? (
            <>
              <p>
                This channel moved to{' '}
                <a href={s.moved.url} target="_blank" rel="noopener noreferrer">
                  {s.moved.handle}
                </a>{' '}
                on {formatDate(s.moved.at)}. Its page points there, and new subscribers are sent there.
              </p>
              <button className="btn" disabled={busy} onClick={() => window.confirm('Stop pointing this channel at the new one? People who already moved stay with the new channel.') && run(() => api('/me/move', { method: 'DELETE' }), 'Move undone')}>
                Undo the move
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!window.confirm(`Move this channel to ${target.trim()}? Its ${total} subscribers and followers are sent to the new channel.`)) return;
                run(() => api('/me/move', { method: 'POST', body: { handle: target.trim(), password } }), 'Moved. Subscribers are on their way.').then((ok) => ok && setPassword(''));
              }}
            >
              <p className="hint">
                Sends your {s.followers.here} subscribers here, {s.followers.network} on other instances and {s.followers.fediverse} on the fediverse to the new channel. Your
                videos here stay until you delete them.
              </p>
              <div className="field">
                <label>New account</label>
                <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="@you@new-site.example" disabled={!s.enabled} required />
              </div>
              <div className="field">
                <label>Password</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </div>
              <button className="btn btn-primary" disabled={busy || !s.enabled}>
                Move channel
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
