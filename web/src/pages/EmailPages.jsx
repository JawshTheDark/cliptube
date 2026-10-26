import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';

export function ForgotPassword() {
  const [login, setLogin] = useState('');
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle('Forgot password');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMsg((await api('/auth/forgot-password', { method: 'POST', body: { login } })).message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-box">
      <h1>Forgot your password?</h1>
      <p className="sub">We'll email a reset link to the confirmed address on your account.</p>
      {msg ? (
        <div className="notice">{msg}</div>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="error">{error}</div>}
          <div className="field">
            <label>Username or email</label>
            <input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus required />
          </div>
          <button className="btn btn-primary" disabled={busy}>
            Send reset link
          </button>
        </form>
      )}
      <div className="auth-foot">
        <Link to="/login">Back to sign in</Link>
      </div>
    </div>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useTitle('Choose a new password');
  const submit = async (e) => {
    e.preventDefault();
    if (pw !== pw2) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token: params.get('token'), password: pw } });
      nav('/login', { replace: true, state: { message: 'Password changed. Sign in with the new one.' } });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-box">
      <h1>Choose a new password</h1>
      {error && <div className="error">{error}</div>}
      <form onSubmit={submit}>
        <div className="field">
          <label>New password</label>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={6} required autoFocus />
        </div>
        <div className="field">
          <label>Confirm new password</label>
          <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          Change password
        </button>
      </form>
    </div>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const [state, setState] = useState('checking');
  const [error, setError] = useState(null);
  useTitle('Confirm email');
  useEffect(() => {
    api('/auth/verify-email', { method: 'POST', body: { token: params.get('token') } })
      .then(() => setState('ok'))
      .catch((e) => {
        setError(e.message);
        setState('failed');
      });
  }, [params]);
  return (
    <div className="auth-box">
      <h1>Confirm email</h1>
      {state === 'checking' && <div className="spinner" />}
      {state === 'ok' && <div className="notice">Your email address is confirmed. Choose which notifications reach it in Settings.</div>}
      {state === 'failed' && <div className="error">{error}</div>}
      <div className="auth-foot">
        <Link to="/settings/notifications">Notification settings</Link>
      </div>
    </div>
  );
}
