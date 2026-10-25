import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { useToast } from '../components/Toast.jsx';

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
    </div>
  );
}
