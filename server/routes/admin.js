import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, setSetting } from '../db.js';
import { DIRS } from '../config.js';
import { requireAdmin, userToPublic, setUserRole, setUserStatus } from '../auth.js';
import { HttpError } from '../util.js';
import { queueInfo, ffmpegInfo } from '../media.js';
import { enqueueAllRenditions } from '../renditions.js';
import { deleteAccount } from '../privacy.js';
import { logAction } from '../reports.js';
import { newId, now, str, clampInt } from '../util.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const ENCODERS = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'];

// Only the general site settings; keys, tokens and network settings never go to the browser from here.
const SITE_SETTINGS = [
  'site_name', 'registration_mode', 'max_upload_mb', 'default_quota_mb', 'max_height', 'encoder', 'delete_originals', 'public_url',
  'hls_ladder', 'federation_rendition', 'show_dislikes', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_from', 'steamgriddb_auto',
];
function siteSettings() {
  const s = getSettings();
  // Passwords and API keys are write-only: the browser only learns whether one is set.
  return { ...Object.fromEntries(SITE_SETTINGS.map((k) => [k, s[k]])), smtp_password_set: !!s.smtp_password, steamgriddb_key_set: !!s.steamgriddb_api_key };
}

adminRouter.get('/settings', (req, res) => res.json({ settings: siteSettings(), encoders: ENCODERS }));

adminRouter.patch('/settings', (req, res) => {
  const b = req.body || {};
  const bool = (v) => (v === true || v === 'true' ? 'true' : 'false');
  if (b.site_name !== undefined) {
    const name = String(b.site_name).trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Site name cannot be empty');
    setSetting('site_name', name);
  }
  if (b.allow_registration !== undefined) setSetting('registration_mode', bool(b.allow_registration) === 'true' ? 'open' : 'closed');
  if (b.registration_mode !== undefined) {
    if (!['open', 'approval', 'invite', 'closed'].includes(b.registration_mode)) throw new HttpError(400, 'Registration must be open, approval, invite or closed');
    setSetting('registration_mode', b.registration_mode);
    setSetting('allow_registration', b.registration_mode === 'closed' ? 'false' : 'true');
  }
  if (b.default_quota_mb !== undefined) {
    const n = parseInt(b.default_quota_mb, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new HttpError(400, 'Quota must be 0 (unlimited) or more MB');
    setSetting('default_quota_mb', n);
  }
  if (b.delete_originals !== undefined) setSetting('delete_originals', bool(b.delete_originals));
  if (b.show_dislikes !== undefined) setSetting('show_dislikes', bool(b.show_dislikes));
  for (const k of ['smtp_host', 'smtp_user', 'smtp_from']) if (b[k] !== undefined) setSetting(k, str(b[k], 200).trim());
  if (b.smtp_port !== undefined) setSetting('smtp_port', String(clampInt(b.smtp_port, 1, 65535, 587)));
  if (b.smtp_secure !== undefined) {
    if (!['starttls', 'tls', 'none'].includes(b.smtp_secure)) throw new HttpError(400, 'Encryption must be starttls, tls or none');
    setSetting('smtp_secure', b.smtp_secure);
  }
  if (typeof b.smtp_password === 'string' && b.smtp_password) setSetting('smtp_password', b.smtp_password);
  if (b.smtp_password === null) setSetting('smtp_password', '');
  if (typeof b.steamgriddb_api_key === 'string' && b.steamgriddb_api_key.trim()) setSetting('steamgriddb_api_key', b.steamgriddb_api_key.trim().slice(0, 200));
  if (b.steamgriddb_api_key === null) setSetting('steamgriddb_api_key', '');
  if (b.steamgriddb_auto !== undefined) setSetting('steamgriddb_auto', bool(b.steamgriddb_auto));
  // Changing the streaming ladder or the federation copy rebuilds renditions in the background.
  let rebuild = false;
  if (b.hls_ladder !== undefined) {
    if (!['off', '720', 'full'].includes(String(b.hls_ladder))) throw new HttpError(400, 'The streaming ladder must be off, 720 or full');
    rebuild = rebuild || getSettings().hls_ladder !== String(b.hls_ladder);
    setSetting('hls_ladder', String(b.hls_ladder));
  }
  if (b.federation_rendition !== undefined) {
    rebuild = rebuild || getSettings().federation_rendition !== bool(b.federation_rendition);
    setSetting('federation_rendition', bool(b.federation_rendition));
  }
  if (rebuild) enqueueAllRenditions();
  if (b.max_upload_mb !== undefined) {
    const n = parseInt(b.max_upload_mb, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) throw new HttpError(400, 'Upload limit must be between 1 and 1000000 MB');
    setSetting('max_upload_mb', n);
  }
  if (b.max_height !== undefined) {
    const n = parseInt(b.max_height, 10);
    if (![480, 720, 1080, 1440, 2160].includes(n)) throw new HttpError(400, 'Max height must be 480, 720, 1080, 1440 or 2160');
    setSetting('max_height', n);
  }
  if (b.encoder !== undefined) {
    if (!ENCODERS.includes(b.encoder)) throw new HttpError(400, 'Unknown encoder');
    setSetting('encoder', b.encoder);
  }
  if (b.public_url !== undefined) {
    const url = String(b.public_url).trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+/.test(url)) throw new HttpError(400, 'Public URL must start with http:// or https://');
    setSetting('public_url', url);
  }
  res.json({ settings: siteSettings(), encoders: ENCODERS });
});

const ADMIN_USER_SQL =
  'SELECT u.*, (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS video_count, (SELECT COALESCE(SUM(size_bytes), 0) FROM videos v WHERE v.user_id = u.id) AS bytes FROM users u';

function adminUser(u) {
  return {
    ...userToPublic(u),
    status_reason: u.status_reason || null,
    quota_mb: u.quota_bytes === null || u.quota_bytes === undefined ? null : Math.round(u.quota_bytes / 1048576),
    strikes: db.prepare('SELECT COUNT(*) AS n FROM strikes WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(u.id, now()).n,
    delete_requested_at: u.delete_requested_at || null,
    video_count: u.video_count,
    bytes: u.bytes,
  };
}

adminRouter.get('/users', (req, res) => {
  const rows = db.prepare(`${ADMIN_USER_SQL} WHERE u.remote_instance_id IS NULL ORDER BY u.created_at ASC`).all();
  res.json({ users: rows.map(adminUser) });
});

// ---- invites ---------------------------------------------------------------------------------

adminRouter.get('/invites', (req, res) => {
  res.json({
    invites: db
      .prepare('SELECT i.*, u.username AS created_by_name FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC')
      .all(),
  });
});

adminRouter.post('/invites', (req, res) => {
  const b = req.body || {};
  const code = newId(9);
  const days = clampInt(b.expires_days, 0, 365, 14);
  db.prepare('INSERT INTO invites (code, created_by, note, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(
    code, req.user.id, str(b.note, 200), clampInt(b.max_uses, 0, 1000, 1), days ? now() + days * 24 * 3600_000 : null, now(),
  );
  logAction(req.user, 'invite.create', { targetType: 'invite', targetId: code, details: b.note || null });
  res.status(201).json({ invite: db.prepare('SELECT * FROM invites WHERE code = ?').get(code) });
});

adminRouter.delete('/invites/:code', (req, res) => {
  db.prepare('DELETE FROM invites WHERE code = ?').run(String(req.params.code));
  res.json({ ok: true });
});

adminRouter.patch('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const b = req.body || {};
  if (u.remote_instance_id) throw new HttpError(400, 'People from other instances are managed by blocking their instance');
  // Legacy toggle kept for older clients.
  const role = b.role !== undefined ? b.role : b.is_admin !== undefined ? (b.is_admin ? 'admin' : 'user') : undefined;
  if (role !== undefined) {
    if (u.id === req.user.id && role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role');
    setUserRole(u.id, role);
  }
  if (b.status !== undefined) {
    if (u.id === req.user.id) throw new HttpError(400, 'You cannot change your own account status');
    setUserStatus(u.id, b.status, b.reason);
    const verb = { active: u.status === 'pending' ? 'approve' : 'activate', suspended: 'suspend', banned: 'ban', pending: 'unapprove' }[b.status] || b.status;
    logAction(req.user, `user.${verb}`, { targetType: 'user', targetId: u.id, targetLabel: u.username, details: b.reason || null });
  }
  if (b.quota_mb !== undefined) {
    const q = b.quota_mb === null || b.quota_mb === '' ? null : clampInt(b.quota_mb, 0, 100_000_000, 0) * 1048576;
    db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(q, u.id);
  }
  if (b.clear_strikes) {
    db.prepare('DELETE FROM strikes WHERE user_id = ?').run(u.id);
    logAction(req.user, 'user.clear_strikes', { targetType: 'user', targetId: u.id, targetLabel: u.username });
  }
  res.json({ user: adminUser(db.prepare(`${ADMIN_USER_SQL} WHERE u.id = ?`).get(u.id)) });
});

adminRouter.delete('/users/:id', async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  if (u.id === req.user.id) throw new HttpError(400, 'You cannot delete your own account from here');
  await deleteAccount(u.id, req.user);
  res.json({ ok: true });
});

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return total;
}

adminRouter.get('/stats', (req, res) => {
  res.json({
    users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE remote_instance_id IS NULL').get().n,
    videos: db.prepare('SELECT COUNT(*) AS n FROM videos').get().n,
    ready: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'ready'").get().n,
    failed: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'failed'").get().n,
    views: db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM videos').get().n,
    comments: db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,
    disk: { videos: dirSize(DIRS.videos), originals: dirSize(DIRS.originals), thumbs: dirSize(DIRS.thumbs), avatars: dirSize(DIRS.avatars) },
    rendering: db.prepare("SELECT COUNT(*) AS n FROM videos WHERE render_status IN ('queued', 'rendering')").get().n,
    queue: queueInfo(),
    tools: ffmpegInfo(),
  });
});
