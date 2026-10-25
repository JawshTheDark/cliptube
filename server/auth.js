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
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    bio: u.bio,
    avatar_url: u.avatar ? `/media/avatars/${u.avatar}` : null,
    banner_url: u.banner ? `/media/avatars/${u.banner}` : null,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  };
}

export function attachUser(req, res, next) {
  req.user = null;
  const token = req.cookies?.[COOKIE];
  if (token) {
    const row = db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
      .get(token, now());
    if (row) req.user = userToPublic(row);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) throw new HttpError(401, 'You need to be logged in to do that');
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) throw new HttpError(401, 'You need to be logged in to do that');
  if (!req.user.is_admin) throw new HttpError(403, 'Admins only');
  next();
}

function startSession(req, res, userId) {
  const token = newToken();
  const t = now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, t, t + SESSION_MS);
  // `secure` follows the request, so the cookie is HTTPS-only behind a TLS proxy but still works on plain-http LAN setups.
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
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

authRouter.post('/register', async (req, res) => {
  const { username, password, display_name, setup_code } = req.body || {};
  const first = userCount() === 0;
  if (!first && getSettings().allow_registration !== 'true') throw new HttpError(403, 'Registration is closed on this site');
  if (first) {
    const code = ensureSetupCode();
    if (String(setup_code || '').trim().toLowerCase() !== code.toLowerCase()) {
      throw new HttpError(403, 'Wrong setup code. The code is printed in the server console when it starts (for Docker: docker logs cliptube).');
    }
  }
  if (!USERNAME_RE.test(username || '')) throw new HttpError(400, 'Username must be 3-20 letters, numbers or underscores');
  if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken');

  const id = newId();
  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, username, str(display_name, 50).trim() || username, hash, first ? 1 : 0, now(),
  );
  startSession(req, res, id);
  res.status(201).json({ user: userToPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) throw new HttpError(401, 'Wrong username or password');
  startSession(req, res, u.id);
  res.json({ user: userToPublic(u) });
});

authRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => res.json({ user: req.user }));

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 6 * 3600 * 1000).unref();
