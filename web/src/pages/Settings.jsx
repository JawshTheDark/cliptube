import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { Icon } from '../components/Icons.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatBytes, formatDate, isAnonymous, setAnonymous } from '../util.js';

export default function Settings() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.display_name);
  const [bio, setBio] = useState(user.bio || '');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwError, setPwError] = useState(null);
  const fileRef = useRef(null);
  useTitle('Settings');

  const saveProfile = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api('/me', { method: 'PATCH', body: { display_name: displayName, bio } });
      setUser(r.user);
      toast('Profile saved');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError(null);
    if (pw !== pw2) return setPwError('New passwords do not match');
    setBusy(true);
    try {
      await api('/me', { method: 'PATCH', body: { current_password: current, new_password: pw } });
      setCurrent('');
      setPw('');
      setPw2('');
      toast('Password changed');
    } catch (err) {
      setPwError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    setBusy(true);
    try {
      const r = await api('/me/avatar', { method: 'POST', body: fd });
      setUser(r.user);
      toast('Profile picture updated');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const removeAvatar = async () => {
    try {
      const r = await api('/me/avatar', { method: 'DELETE' });
      setUser(r.user);
    } catch (err) {
      toast(err.message);
    }
  };

  return (
    <div className="page page-narrow">
      <h1>Settings</h1>

      <section className="card-panel">
        <h2>Channel</h2>
        <div className="avatar-edit">
          <Avatar user={user} size={96} />
          <div className="row-actions">
            <button className="btn" onClick={() => fileRef.current.click()} disabled={busy}>
              Change picture
            </button>
            {user.avatar_url && (
              <button className="btn btn-ghost" onClick={removeAvatar}>
                Remove
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                if (e.target.files[0]) uploadAvatar(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </div>
        </div>
        <form onSubmit={saveProfile}>
          <div className="field">
            <label>Display name</label>
            <input className="input" value={displayName} maxLength={50} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Username</label>
            <input className="input" value={`@${user.username}`} disabled />
            <span className="hint">
              Your channel lives at <Link to={`/c/${user.username}`}>/c/{user.username}</Link>
            </span>
          </div>
          <div className="field">
            <label>Channel description</label>
            <textarea className="textarea" rows={4} value={bio} maxLength={1000} onChange={(e) => setBio(e.target.value)} placeholder="What do you post?" />
          </div>
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </form>
      </section>

      <section className="card-panel">
        <h2>Change password</h2>
        {pwError && <div className="error">{pwError}</div>}
        <form onSubmit={changePassword}>
          <div className="field">
            <label>Current password</label>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div className="field">
            <label>New password</label>
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={6} required />
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
          </div>
          <button className="btn" disabled={busy}>
            Change password
          </button>
        </form>
      </section>

      <MoreSettings />
    </div>
  );
}

function MoreSettings() {
  const toast = useToast();
  const [s, setS] = useState(null);
  useEffect(() => {
    api('/me/settings').then(setS).catch((e) => toast(e.message));
  }, [toast]);
  if (!s) return <div className="spinner" />;
  const patch = async (body, message) => {
    try {
      await api('/me', { method: 'PATCH', body });
      setS((x) => ({ ...x, ...body }));
      if (message) toast(message);
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <>
      <CommentSettings s={s} patch={patch} setS={setS} />
      <PrivacySettings s={s} patch={patch} />
      <StorageCard storage={s.storage} />
      <DataSettings />
      <DeleteAccount initial={s.delete_requested_at} />
    </>
  );
}

function CommentSettings({ s, patch, setS }) {
  const toast = useToast();
  const [word, setWord] = useState('');
  const [action, setAction] = useState('hold');
  const saveFilters = async (filters) => {
    try {
      const r = await api('/me/comment-filters', { method: 'PUT', body: { filters } });
      setS((x) => ({ ...x, comment_filters: r.comment_filters }));
    } catch (err) {
      toast(err.message);
    }
  };
  const add = (e) => {
    e.preventDefault();
    const w = word.trim().toLowerCase();
    if (!w) return;
    saveFilters([...s.comment_filters.filter((f) => f.word !== w), { word: w, action }]);
    setWord('');
  };
  return (
    <section className="card-panel">
      <h2>Comments on your videos</h2>
      <div className="field">
        <label>New comments</label>
        <select className="select" value={s.comment_mode} onChange={(e) => patch({ comment_mode: e.target.value }, 'Saved')}>
          <option value="open">Publish right away (spam checks still apply)</option>
          <option value="hold_all">Hold every comment for my review</option>
        </select>
        <span className="hint">
          Each video can override this when you edit it. Held comments wait in <Link to="/studio/comments">Studio, Comments</Link>.
        </span>
      </div>
      <h3 className="sub-h">Blocked words</h3>
      <p className="hint">Comments containing these words or phrases are held for review or rejected outright.</p>
      <form onSubmit={add} className="field-row align-end">
        <div className="field grow">
          <input className="input" value={word} maxLength={60} placeholder="Word or phrase" onChange={(e) => setWord(e.target.value)} />
        </div>
        <div className="field">
          <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="hold">Hold for review</option>
            <option value="reject">Reject</option>
          </select>
        </div>
        <div className="field">
          <button className="btn">Add</button>
        </div>
      </form>
      {s.comment_filters.length > 0 && (
        <div className="chips flat">
          {s.comment_filters.map((f) => (
            <span key={f.word} className={`chip ${f.action === 'reject' ? 'chip-danger' : ''}`} title={f.action === 'reject' ? 'Rejected' : 'Held for review'}>
              {f.word}
              <button type="button" className="chip-x" aria-label={`Remove ${f.word}`} onClick={() => saveFilters(s.comment_filters.filter((x) => x.word !== f.word))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function PrivacySettings({ s, patch }) {
  const [anon, setAnon] = useState(isAnonymous());
  return (
    <section className="card-panel">
      <h2>Privacy</h2>
      <label className="toggle-row">
        <span className="toggle-text">
          <b>Pause watch history</b>
          <span className="hint">Videos you watch aren't added to your history or used for resume points.</span>
        </span>
        <input type="checkbox" className="switch" checked={s.history_paused} onChange={(e) => patch({ history_paused: e.target.checked }, e.target.checked ? 'History paused' : 'History on')} />
      </label>
      <label className="toggle-row">
        <span className="toggle-text">
          <b>Anonymous mode in this browser</b>
          <span className="hint">Watching from this browser doesn't touch your history, and views count as a signed-out viewer. Also in the account menu.</span>
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={anon}
          onChange={(e) => {
            setAnonymous(e.target.checked);
            setAnon(e.target.checked);
            window.dispatchEvent(new Event('ct-anon'));
          }}
        />
      </label>
      <p className="hint">
        <Link to="/history">Manage your history</Link>
      </p>
    </section>
  );
}

function StorageCard({ storage }) {
  const pct = storage.quota > 0 ? Math.min(100, Math.round((storage.used / storage.quota) * 100)) : 0;
  return (
    <section className="card-panel">
      <h2>Storage</h2>
      <p>
        {formatBytes(storage.used)} used{storage.quota > 0 ? ` of ${formatBytes(storage.quota)}` : ', no limit'}
      </p>
      {storage.quota > 0 && (
        <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`meter-fill ${pct >= 90 ? 'warn' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </section>
  );
}

function DataSettings() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const load = () => api('/me/exports').then(setState).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!state?.preparing) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [state]);
  const start = async () => {
    try {
      setState(await api('/me/exports', { method: 'POST' }).then(() => ({ ...state, preparing: true })));
      toast('Preparing your export');
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel">
      <h2>Your data</h2>
      <p className="hint">
        Download everything you have here: your videos and their originals, thumbnails, comments, likes, subscriptions and history, in one archive. Links
        last 7 days.
      </p>
      <button className="btn" onClick={start} disabled={!state || state.preparing}>
        <Icon name="download" /> {state?.preparing ? 'Preparing…' : 'Export my data'}
      </button>
      {state?.exports?.length > 0 && (
        <div className="fed-list top-gap">
          {state.exports.map((x) => (
            <div key={x.file} className="fed-item">
              <div className="fed-main">
                <div className="fed-name">
                  <a href={`/api/me/exports/${encodeURIComponent(x.file)}`} download>
                    {x.file}
                  </a>
                </div>
                <div className="fed-sub">
                  {formatBytes(x.size)} · made {formatDate(x.created_at)} · expires {formatDate(x.expires_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DeleteAccount({ initial }) {
  const toast = useToast();
  const [requested, setRequested] = useState(initial);
  const [deletesAt, setDeletesAt] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/me/deletion')
      .then((r) => {
        setRequested(r.requested_at);
        setDeletesAt(r.deletes_at);
      })
      .catch(() => {});
  }, []);
  const request = async (e) => {
    e.preventDefault();
    if (!window.confirm('Delete your account and everything on it? You have 7 days to change your mind.')) return;
    setBusy(true);
    try {
      const r = await api('/me/deletion', { method: 'POST', body: { password } });
      setRequested(r.requested_at);
      setDeletesAt(r.deletes_at);
      setPassword('');
      toast('Your account will be deleted');
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      await api('/me/deletion', { method: 'DELETE' });
      setRequested(null);
      setDeletesAt(null);
      toast('Deletion cancelled');
    } catch (err) {
      toast(err.message);
    }
  };
  return (
    <section className="card-panel danger-zone">
      <h2>Delete account</h2>
      {requested ? (
        <>
          <p>
            Your account and all of your videos will be deleted on <b>{formatDate(deletesAt || requested + 7 * 86400000)}</b>. Other instances in the network are told
            to remove your comments and likes too.
          </p>
          <button className="btn" onClick={cancel}>
            Keep my account
          </button>
        </>
      ) : (
        <form onSubmit={request}>
          <p className="hint">Deletes your channel, videos, comments, likes and history after a 7-day grace period. Export your data first if you want a copy.</p>
          <div className="field">
            <label>Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          <button className="btn btn-danger" disabled={busy}>
            Delete my account
          </button>
        </form>
      )}
    </section>
  );
}
