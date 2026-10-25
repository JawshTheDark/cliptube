import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, getSettings, userCount } from './db.js';
import { HttpError, newId, newToken, now, str } from './util.js';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'ct_session';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function userToPublic(u) {
  if (!u) return null;
  const remote = !!u.remote_instance_id;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    bio: u.bio,
    avatar_url: remote ? u.remote_avatar_url || null : u.avatar ? `/media/avatars/${u.avatar}` : null,
    ...(remote ? { remote: true, profile_url: u.remote_profile_url || null } : {}),
    banner_url: u.banner ? `/media/avatars/${u.banner}` : null,
    ...(u.moved_to && !remote ? { moved: { url: u.moved_to_url || u.moved_to, handle: u.moved_to_handle || null, at: u.moved_at } } : {}),
    is_admin: u.role === 'admin' || !!u.is_admin,
    is_moderator: u.role === 'admin' || u.role === 'moderator' || !!u.is_admin,
    role: u.role || (u.is_admin ? 'admin' : 'user'),
    status: u.status || 'active',
    created_at: u.created_at,
  };
}

export const ROLES = ['user', 'moderator', 'admin'];
export const STATUSES = ['active', 'pending', 'suspended', 'banned'];

/**
 * The session token: the cookie for browsers, or an `Authorization: Bearer` header for the Android app
 * (a native video player can send a header but not share the browser's cookie).
 */
export function sessionToken(req) {
  const cookie = req.cookies?.[COOKIE];
  if (cookie) return cookie;
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.get('authorization') || '').trim());
  return m ? m[1] : null;
}

/** Login and register return the session token in the body, instead of a cookie, when the app asks for it. */
const wantsToken = (req) => req.body?.return_token === true;

export function attachUser(req, res, next) {
  req.user = null;
  const token = sessionToken(req);
  if (token) {
    // Suspended and banned accounts lose their sessions immediately.
    const row = db
      .prepare(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.remote_instance_id IS NULL AND u.status = 'active'",
      )
      .get(token, now());
    if (row) req.user = userToPublic(row);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) throw new HttpError(401, 'You need to be logged in to do that');
  next();
}

export function requireModerator(req, res, next) {
  if (!req.user) throw new HttpError(401, 'You need to be logged in to do that');
  if (!req.user.is_moderator) throw new HttpError(403, 'Moderators only');
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) throw new HttpError(401, 'You need to be logged in to do that');
  if (!req.user.is_admin) throw new HttpError(403, 'Admins only');
  next();
}

/** Changes a local account's role or status, keeping the legacy is_admin flag in sync. */
export function setUserRole(userId, role) {
  if (!ROLES.includes(role)) throw new HttpError(400, `Role must be one of ${ROLES.join(', ')}`);
  db.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').run(role, role === 'admin' ? 1 : 0, userId);
}

export function setUserStatus(userId, status, reason = null) {
  if (!STATUSES.includes(status)) throw new HttpError(400, `Status must be one of ${STATUSES.join(', ')}`);
  db.prepare('UPDATE users SET status = ?, status_reason = ? WHERE id = ?').run(status, status === 'active' ? null : str(reason, 300) || null, userId);
  if (status !== 'active') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Starts a session. Returns its token when the client asked for one (the app), else sets the cookie. */
function startSession(req, res, userId) {
  const token = newToken();
  const t = now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, t, t + SESSION_MS);
  if (wantsToken(req)) return { token, token_expires_at: t + SESSION_MS };
  // `secure` follows the request, so the cookie is HTTPS-only behind a TLS proxy but still works on plain-http LAN setups.
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
  return {};
}

/**
 * While no accounts exist, the first registration (which becomes admin) must supply a one-time
 * setup code that is printed to the server console. This stops a stranger from claiming the admin
 * account on a freshly deployed public instance. Set SETUP_CODE in the environment to choose it.
 */
let setupCode = null;
export function ensureSetupCode() {
  if (userCount() > 0) {
    setupCode = null;
    return null;
  }
  if (!setupCode) {
    setupCode = (process.env.SETUP_CODE || crypto.randomBytes(4).toString('hex')).trim();
    console.log(`\nNo accounts exist yet. Create the first (admin) account at /register using setup code: ${setupCode}\n`);
  }
  return setupCode;
}

export const authRouter = Router();

export function registrationMode() {
  const s = getSettings();
  const mode = s.registration_mode || (s.allow_registration === 'false' ? 'closed' : 'open');
  return ['open', 'approval', 'invite', 'closed'].includes(mode) ? mode : 'open';
}

/** Returns the invite row if the code can still be used, else throws. */
export function checkInvite(code) {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || '').trim());
  if (!inv) throw new HttpError(403, 'That invite code is not valid');
  if (inv.expires_at && inv.expires_at < now()) throw new HttpError(403, 'That invite has expired');
  if (inv.max_uses > 0 && inv.uses >= inv.max_uses) throw new HttpError(403, 'That invite has already been used');
  return inv;
}

authRouter.post('/register', async (req, res) => {
  const { username, password, display_name, setup_code, invite, accept_terms } = req.body || {};
  const first = userCount() === 0;
  const mode = registrationMode();
  let inv = null;
  if (first) {
    const code = ensureSetupCode();
    if (String(setup_code || '').trim().toLowerCase() !== code.toLowerCase()) {
      throw new HttpError(403, 'Wrong setup code. The code is printed in the server console when it starts (for Docker: docker logs cliptube).');
    }
  } else {
    if (mode === 'closed') throw new HttpError(403, 'Registration is closed on this site');
    // An invite works in every open mode, and skips approval.
    if (invite) inv = checkInvite(invite);
    if (mode === 'invite' && !inv) throw new HttpError(403, 'This site is invite-only. Ask someone here for an invite link.');
    if (getSettings().legal_terms.trim() && !accept_terms) throw new HttpError(400, "Please read and accept the site's rules to create an account");
  }
  if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Username must be 3-20 letters, numbers or underscores');
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');

  const id = newId();
  const hash = await bcrypt.hash(password, 10);
  const status = !first && mode === 'approval' && !inv ? 'pending' : 'active';
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, is_admin, role, status, terms_accepted_at, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, username, str(display_name, 50).trim() || username, hash, first ? 1 : 0, first ? 'admin' : 'user', status, accept_terms ? now() : null, inv?.created_by || null, now());
  if (inv) db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inv.code);
  if (status === 'pending') {
    return res.status(202).json({ pending: true, message: 'Thanks! An admin needs to approve your account before you can sign in.' });
  }
  const session = startSession(req, res, id);
  res.status(201).json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), ...session });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND remote_instance_id IS NULL').get(String(username || ''));
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) throw new HttpError(401, 'Wrong username or password');
  if (u.status === 'pending') throw new HttpError(403, 'This account is waiting for an admin to approve it');
  if (u.status && u.status !== 'active') {
    throw new HttpError(403, `This account is ${u.status}${u.status_reason ? `: ${u.status_reason}` : ''}`);
  }
  const session = startSession(req, res, u.id);
  res.json({ user: userToPublic(u), ...session });
});

authRouter.post('/logout', (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => res.json({ user: req.user }));

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 6 * 3600 * 1000).unref();
