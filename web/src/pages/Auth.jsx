import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useTitle } from '../auth.jsx';

function useRedirectIfLoggedIn() {
  const { user } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const from = location.state?.from && !['/login', '/register'].includes(location.state.from) ? location.state.from : '/';
  useEffect(() => {
    if (user) nav(from, { replace: true });
  }, [user, from, nav]);
  return from;
}

export function Login() {
  const { setUser, site } = useAuth();
  const from = useRedirectIfLoggedIn();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle('Sign in');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username, password } });
      setUser(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-box">
      <h1>Sign in</h1>
      <p className="sub">to continue to {site.site_name}</p>
      {site.needs_setup && (
        <div className="notice">
          No accounts exist yet. <Link to="/register">Create the first account</Link> to become the admin.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <form onSubmit={submit}>
        <div className="field">
          <label>Username</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="auth-foot">
        {site.allow_registration || site.needs_setup ? (
          <>
            New here? <Link to="/register" state={{ from }}>Create an account</Link>
          </>
        ) : (
          'Registration is closed. Ask the admin for an account.'
        )}
      </div>
    </div>
  );
}

export function Register() {
  const { setUser, site, refresh } = useAuth();
  const from = useRedirectIfLoggedIn();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [params] = useSearchParams();
  const [invite, setInvite] = useState(() => params.get('invite') || '');
  const [terms, setTerms] = useState(false);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle('Create account');

  const mode = site.registration_mode || (site.allow_registration ? 'open' : 'closed');
  const closed = mode === 'closed' && !site.needs_setup;
  const askInvite = !site.needs_setup && (mode === 'invite' || !!params.get('invite'));
  const askTerms = !site.needs_setup && site.has_terms;

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/register', {
        method: 'POST',
        body: { username, password, display_name: displayName, setup_code: setupCode, invite: invite.trim() || undefined, accept_terms: terms },
      });
      if (r.pending) {
        setPending(r.message);
        return;
      }
      setUser(r.user);
      refresh().catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-box">
      <h1>Create your account</h1>
      <p className="sub">{site.needs_setup ? `Set up ${site.site_name}` : `Join ${site.site_name}`}</p>
      {site.needs_setup && <div className="notice">You are creating the first account, so it becomes the admin account.</div>}
      {!site.needs_setup && mode === 'approval' && !invite && !pending && <div className="notice">An admin approves new accounts before they can sign in.</div>}
      {pending ? (
        <div className="notice">{pending}</div>
      ) : closed ? (
        <div className="error">Registration is closed on this site. Ask the admin to invite you.</div>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          <form onSubmit={submit}>
            {site.needs_setup && (
              <div className="field">
                <label>Setup code</label>
                <input className="input" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="off" required />
                <span className="hint">Printed in the server console when it starts. With Docker: <code>docker logs cliptube</code></span>
              </div>
            )}
            <div className="field">
              <label>Username</label>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z0-9_]{3,20}" title="3-20 letters, numbers or underscores" autoFocus required />
              <span className="hint">3-20 letters, numbers or underscores. This is your channel URL.</span>
            </div>
            <div className="field">
              <label>Display name</label>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username || 'How your name shows on videos'} maxLength={50} />
            </div>
            <div className="field">
              <label>Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={6} required />
            </div>
            <div className="field">
              <label>Confirm password</label>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </div>
            {askInvite && (
              <div className="field">
                <label>Invite code</label>
                <input className="input" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" required={mode === 'invite'} />
                {mode === 'invite' && <span className="hint">This site is invite-only. Ask someone here for an invite link.</span>}
              </div>
            )}
            {askTerms && (
              <label className="checkbox field">
                <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
                <span>
                  I have read and accept the{' '}
                  <Link to="/legal" target="_blank">
                    rules and terms
                  </Link>
                </span>
              </label>
            )}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        </>
      )}
      <div className="auth-foot">
        Already have an account? <Link to="/login" state={{ from }}>Sign in</Link>
      </div>
    </div>
  );
}
