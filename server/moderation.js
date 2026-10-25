/**
 * Moderation: reports queue, actions on videos, comments, accounts and instances, strikes,
 * takedown notices, counter-notices, and the public legal and transparency information.
 *
 *   /api/reports            (signed-in users)  file a report, local or about another instance
 *   /api/mod/...            (moderators)       queue, actions, held comments, counter-notices, log
 *   /api/admin/legal/...    (admins)           legal page settings, takedown log
 *   /api/legal, /api/transparency (public)
 */
import { Router } from 'express';
import { db, getSettings, setSetting } from './db.js';
import { requireAuth, requireModerator, requireAdmin, setUserStatus } from './auth.js';
import { HttpError, newId, now, str, clampInt } from './util.js';
import { defineJob, enqueueJob } from './jobs.js';
import { createReport, logAction, REPORT_REASONS } from './reports.js';
import { onLocalVideosChanged, sendNetworkReport } from './network.js';
import { removeVideoFiles } from './routes/videos.js';
import { notifyModeration } from './notify.js';
import { actorUri, apVideoChanged, sendTo } from './ap/deliver.js';

const DAY = 24 * 3600_000;

// ---- videos ------------------------------------------------------------------------------

const videoById = (id) => db.prepare('SELECT v.*, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(String(id));

/** Hides, removes or restores (status null) a video. Removed files are purged after the retention period. */
export function setVideoModeration(video, status, reason, actor, reportId = null) {
  const t = now();
  db.prepare('UPDATE videos SET moderation_status = ?, moderation_reason = ?, moderated_at = ?, updated_at = ? WHERE id = ?').run(
    status, status ? str(reason, 300) || null : null, status ? t : null, t, video.id,
  );
  const action = status === 'hidden' ? 'video.hide' : status === 'removed' ? 'video.remove' : 'video.restore';
  logAction(actor, action, { targetType: 'video', targetId: video.id, targetLabel: video.title, details: reason || null, reportId });
  const what = status === 'hidden' ? 'was hidden by the moderators' : status === 'removed' ? 'was removed by the moderators' : 'was restored';
  notifyModeration(video.user_id, `"${video.title}" ${what}`, { body: status ? reason || null : null, url: `/watch/${video.id}` });
  apVideoChanged(video.id); // hidden or removed videos are withdrawn from the fediverse, restored ones come back
  if (status === 'removed') {
    const days = Math.max(1, Number(getSettings().removed_retention_days) || 30);
    enqueueJob('video.purge', { id: video.id, removed_at: t }, { delay: days * DAY });
  }
  onLocalVideosChanged();
}

defineJob('video.purge', {
  maxAttempts: 3,
  handler: ({ id, removed_at }) => {
    const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
    // Restored or removed again later: that later removal schedules its own purge.
    if (!v || v.moderation_status !== 'removed' || v.moderated_at !== removed_at) return;
    db.prepare('DELETE FROM videos WHERE id = ?').run(id);
    removeVideoFiles(v);
    logAction(null, 'video.purge', { targetType: 'video', targetId: id, targetLabel: v.title, details: 'Files deleted after the retention period' });
  },
});

// ---- accounts ------------------------------------------------------------------------------

export function activeStrikes(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM strikes WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(userId, now()).n;
}

/** Adds a strike; enough active strikes suspend the account (repeat-infringer policy). */
export function addStrike(userId, reason, actor, noticeId = null) {
  const s = getSettings();
  const u = db.prepare('SELECT id, username, status, remote_instance_id FROM users WHERE id = ?').get(userId);
  if (!u || u.remote_instance_id) return null;
  const days = Number(s.strike_expiry_days) || 0;
  const t = now();
  db.prepare('INSERT INTO strikes (user_id, reason, notice_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    u.id, str(reason, 300), noticeId, actor?.id || null, t, days > 0 ? t + days * DAY : null,
  );
  logAction(actor, 'user.strike', { targetType: 'user', targetId: u.id, targetLabel: u.username, details: reason });
  notifyModeration(u.id, 'You received a copyright strike', { body: reason, url: '/legal' });
  const count = activeStrikes(u.id);
  const threshold = Number(s.strike_threshold) || 0;
  if (threshold > 0 && count >= threshold && u.status === 'active') {
    setUserStatus(u.id, 'suspended', `Repeated copyright strikes (${count})`);
    logAction(null, 'user.suspend', { targetType: 'user', targetId: u.id, targetLabel: u.username, details: `Automatic: ${count} active strikes` });
  }
  return count;
}

// ---- reports ------------------------------------------------------------------------------

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const recentReports = new Map();

reportsRouter.post('/', async (req, res) => {
  const b = req.body || {};
  const t = now();
  const mine = (recentReports.get(req.user.id) || []).filter((x) => t - x < 3600_000);
  if (mine.length >= 20) throw new HttpError(429, "You've sent a lot of reports. Try again later.");
  mine.push(t);
  recentReports.set(req.user.id, mine);

  const reason = String(b.reason || '');
  const details = str(b.details, 2000);
  const targetType = String(b.target_type || '');
  const targetId = String(b.target_id || '');
  const base = { reason, details, reporterId: req.user.id };
  let id;

  if (targetType === 'video') {
    const v = videoById(targetId);
    if (!v || (v.visibility === 'private' && v.user_id !== req.user.id)) throw new HttpError(404, 'Video not found');
    id = createReport({ ...base, targetType, targetId: v.id, targetTitle: v.title, targetUrl: `/watch/${v.id}`, targetOwner: v.username });
  } else if (targetType === 'comment') {
    const c = db.prepare('SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(targetId);
    if (!c) throw new HttpError(404, 'Comment not found');
    id = createReport({ ...base, targetType, targetId: c.id, targetTitle: c.body.slice(0, 200), targetUrl: `/watch/${c.video_id}`, targetOwner: c.username });
  } else if (targetType === 'user') {
    const u = db.prepare('SELECT * FROM users WHERE (id = ? OR username = ?) AND remote_instance_id IS NULL').get(targetId, targetId);
    if (!u) throw new HttpError(404, 'Channel not found');
    id = createReport({ ...base, targetType, targetId: u.id, targetTitle: u.display_name, targetUrl: `/c/${u.username}`, targetOwner: u.username });
  } else if (targetType === 'remote_video' || targetType === 'remote_comment') {
    const [iid, rid, cid] = targetId.split(':');
    const nv = db
      .prepare('SELECT r.*, p.name AS peer_name, p.url AS peer_url FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ?')
      .get(Number(iid), String(rid || ''));
    if (!nv) throw new HttpError(404, 'Video not found');
    if (targetType === 'remote_comment' && !cid) throw new HttpError(400, 'Missing comment');
    id = createReport({
      ...base,
      targetType,
      targetId,
      targetTitle: targetType === 'remote_video' ? nv.title : str(b.comment_excerpt, 200) || `Comment on "${nv.title}"`,
      targetUrl: `/n/${nv.instance_id}/${nv.remote_id}`,
      targetOwner: targetType === 'remote_video' ? `${nv.uploader_username}@${new URL(nv.peer_url).host}` : str(b.comment_author, 100) || null,
    });
    // Tell the instance that hosts it too (best effort; the local report stands either way).
    try {
      if (nv.origin_type === 'activitypub') {
        // Fediverse servers get a Flag from this instance, without saying who reported it.
        const comment = targetType === 'remote_comment' ? db.prepare('SELECT ap_id FROM network_comments WHERE id = ?').get(String(cid)) : null;
        const objects = [nv.ap_id, comment?.ap_id].filter(Boolean);
        sendTo('i', { type: 'Flag', actor: actorUri('i'), object: objects, content: `${REPORT_REASONS[reason] || reason}${details ? `: ${details}` : ''}` }, [nv.ap_actor]);
      } else {
        await sendNetworkReport(Number(iid), { target_type: targetType === 'remote_video' ? 'video' : 'comment', target_id: targetType === 'remote_video' ? rid : cid, video_id: rid, reason, details }, req.user);
      }
    } catch (e) {
      console.warn(`[moderation] forwarding report to instance ${iid} failed: ${e.message}`);
    }
  } else {
    throw new HttpError(400, 'Unknown report target');
  }
  res.status(201).json({ ok: true, id });
});

// ---- moderator queue --------------------------------------------------------------------------

export const modRouter = Router();
modRouter.use(requireModerator);

function describeTarget(r) {
  switch (r.target_type) {
    case 'video': {
      const v = videoById(r.target_id);
      return v
        ? { exists: true, video_id: v.id, title: v.title, owner: v.username, owner_id: v.user_id, thumbnail_url: v.thumb_path ? `/media/thumbs/${v.thumb_path}` : null, moderation_status: v.moderation_status, visibility: v.visibility }
        : { exists: false };
    }
    case 'comment': {
      const c = db
        .prepare('SELECT c.*, u.username, u.remote_instance_id, v.title AS video_title FROM comments c JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id WHERE c.id = ?')
        .get(r.target_id);
      return c
        ? { exists: true, comment_id: c.id, body: c.body, author: c.username, author_id: c.user_id, author_remote_instance_id: c.remote_instance_id, video_id: c.video_id, video_title: c.video_title, status: c.status }
        : { exists: false };
    }
    case 'user': {
      const u = db.prepare('SELECT id, username, display_name, status FROM users WHERE id = ?').get(r.target_id);
      return u ? { exists: true, user_id: u.id, username: u.username, display_name: u.display_name, status: u.status, strikes: activeStrikes(u.id) } : { exists: false };
    }
    default: {
      const [iid, rid] = String(r.target_id).split(':');
      const nv = db
        .prepare('SELECT r.*, p.name AS peer_name, p.blocked FROM network_videos r JOIN instances p ON p.id = r.instance_id WHERE r.instance_id = ? AND r.remote_id = ?')
        .get(Number(iid), String(rid || ''));
      return nv
        ? { exists: true, instance_id: nv.instance_id, instance_name: nv.peer_name, instance_blocked: !!nv.blocked, title: nv.title, hidden: !!nv.hidden, watch_url: nv.watch_url }
        : { exists: false };
    }
  }
}

function serializeReport(r) {
  const handler = r.handled_by ? db.prepare('SELECT username FROM users WHERE id = ?').get(r.handled_by) : null;
  const reporter = r.reporter_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(r.reporter_id) : null;
  const source = r.source_instance_id ? db.prepare('SELECT name, url FROM instances WHERE id = ?').get(r.source_instance_id) : null;
  return {
    id: r.id,
    target_type: r.target_type,
    target_id: r.target_id,
    target_title: r.target_title,
    target_url: r.target_url,
    target_owner: r.target_owner,
    reason: r.reason,
    reason_label: REPORT_REASONS[r.reason] || r.reason,
    details: r.details,
    reporter: reporter?.username || r.reporter_label || null,
    from_instance: source ? source.name || source.url : null,
    status: r.status,
    resolution: r.resolution,
    notes: r.notes,
    handled_by: handler?.username || null,
    created_at: r.created_at,
    handled_at: r.handled_at,
    target: describeTarget(r),
  };
}

modRouter.get('/summary', (req, res) => {
  res.json({
    open_reports: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n,
    held_comments: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'held'").get().n,
    pending_counter_notices: db.prepare("SELECT COUNT(*) AS n FROM counter_notices WHERE status = 'pending'").get().n,
    pending_accounts: db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending' AND remote_instance_id IS NULL").get().n,
  });
});

modRouter.get('/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const limit = clampInt(req.query.limit, 1, 200, 100);
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  res.json({ reports: rows.map(serializeReport) });
});

modRouter.patch('/reports/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(String(req.params.id));
  if (!r) throw new HttpError(404, 'Report not found');
  if (req.body?.notes !== undefined) db.prepare('UPDATE reports SET notes = ? WHERE id = ?').run(str(req.body.notes, 2000), r.id);
  res.json({ report: serializeReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(r.id)) });
});

function closeReport(r, status, resolution, actor) {
  db.prepare('UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(status, resolution, actor.id, now(), r.id);
  // Tell the people who reported it what happened (local reporters only).
  for (const rep of db.prepare("SELECT DISTINCT reporter_id FROM reports WHERE status = 'open' AND target_type = ? AND target_id = ? AND reporter_id IS NOT NULL").all(r.target_type, r.target_id).concat(r.reporter_id ? [{ reporter_id: r.reporter_id }] : [])) {
    notifyModeration(rep.reporter_id, status === 'resolved' ? `Thanks: the moderators acted on your report about "${r.target_title || 'that'}"` : `The moderators looked at your report about "${r.target_title || 'that'}" and left it up`, {
      dedupe: `report:${r.id}:${rep.reporter_id}`,
    });
  }
  // Other open reports about the same thing are settled by the same decision.
  db.prepare("UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE status = 'open' AND target_type = ? AND target_id = ? AND id != ?").run(
    status, resolution, actor.id, now(), r.target_type, r.target_id, r.id,
  );
}

/** Applies a moderation action to a report's target. Returns a short description. */
function applyReportAction(r, action, reason, actor) {
  const t = describeTarget(r);
  const userIdForTarget = () => {
    if (r.target_type === 'video') return t.owner_id;
    if (r.target_type === 'comment') return t.author_id;
    if (r.target_type === 'user') return t.user_id;
    return null;
  };
  const why = reason || REPORT_REASONS[r.reason];
  switch (action) {
    case 'dismiss':
      logAction(actor, 'report.dismiss', { targetType: r.target_type, targetId: r.target_id, targetLabel: r.target_title, details: reason, reportId: r.id });
      closeReport(r, 'dismissed', 'Dismissed', actor);
      return 'Report dismissed';
    case 'resolve':
      logAction(actor, 'report.resolve', { targetType: r.target_type, targetId: r.target_id, targetLabel: r.target_title, details: reason, reportId: r.id });
      closeReport(r, 'resolved', reason || 'Resolved', actor);
      return 'Report marked resolved';
    case 'hide_video':
    case 'remove_video':
    case 'restore_video': {
      const v = videoById(t.video_id || r.target_id);
      if (!v) throw new HttpError(404, 'The video no longer exists');
      const status = action === 'hide_video' ? 'hidden' : action === 'remove_video' ? 'removed' : null;
      setVideoModeration(v, status, why, actor, r.id);
      closeReport(r, 'resolved', action === 'restore_video' ? 'Video restored' : `Video ${status}`, actor);
      return status ? `Video ${status}` : 'Video restored';
    }
    case 'delete_comment': {
      if (!t.exists || !t.comment_id) throw new HttpError(404, 'The comment no longer exists');
      db.prepare('DELETE FROM comments WHERE id = ?').run(t.comment_id);
      logAction(actor, 'comment.delete', { targetType: 'comment', targetId: t.comment_id, targetLabel: t.body?.slice(0, 120), details: why, reportId: r.id });
      closeReport(r, 'resolved', 'Comment deleted', actor);
      return 'Comment deleted';
    }
    case 'suspend_user':
    case 'ban_user':
    case 'strike_user': {
      const uid = userIdForTarget();
      const u = uid ? db.prepare('SELECT id, username, role, remote_instance_id FROM users WHERE id = ?').get(uid) : null;
      if (!u) throw new HttpError(404, 'No local account to act on');
      if (u.remote_instance_id) throw new HttpError(400, 'That person is on another instance; block their instance instead');
      if (u.role === 'admin' && !actor.is_admin) throw new HttpError(403, 'Only admins can act on admin accounts');
      if (action === 'strike_user') {
        const n = addStrike(u.id, why, actor);
        closeReport(r, 'resolved', `Strike added (${n} active)`, actor);
        return `Strike added to @${u.username} (${n} active)`;
      }
      const status = action === 'ban_user' ? 'banned' : 'suspended';
      setUserStatus(u.id, status, why);
      logAction(actor, `user.${action === 'ban_user' ? 'ban' : 'suspend'}`, { targetType: 'user', targetId: u.id, targetLabel: u.username, details: why, reportId: r.id });
      closeReport(r, 'resolved', `Account ${status}`, actor);
      return `@${u.username} ${status}`;
    }
    case 'block_instance': {
      const iid = t.instance_id || t.author_remote_instance_id;
      if (!iid) throw new HttpError(400, 'This report is not about another instance');
      const inst = db.prepare('SELECT * FROM instances WHERE id = ?').get(iid);
      if (!inst || inst.is_self) throw new HttpError(404, 'Instance not found');
      db.prepare('UPDATE instances SET blocked = 1, block_reason = ? WHERE id = ?').run(str(why, 200), inst.id);
      logAction(actor, 'instance.block', { targetType: 'instance', targetId: String(inst.id), targetLabel: inst.url, details: why, reportId: r.id });
      closeReport(r, 'resolved', `Blocked ${inst.name || inst.url}`, actor);
      return `Blocked ${inst.name || inst.url}`;
    }
    case 'hide_remote_video': {
      if (!t.instance_id) throw new HttpError(400, 'This report is not about another instance');
      const [, rid] = String(r.target_id).split(':');
      db.prepare('UPDATE network_videos SET hidden = 1, updated_at = ? WHERE instance_id = ? AND remote_id = ?').run(now(), t.instance_id, rid);
      logAction(actor, 'network_video.hide', { targetType: r.target_type, targetId: r.target_id, targetLabel: t.title, details: why, reportId: r.id });
      closeReport(r, 'resolved', 'Video hidden here', actor);
      return 'Video hidden';
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }
}

modRouter.post('/reports/:id/action', (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(String(req.params.id));
  if (!r) throw new HttpError(404, 'Report not found');
  const message = applyReportAction(r, String(req.body?.action || ''), str(req.body?.reason, 300), req.user);
  res.json({ message, report: serializeReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(r.id)) });
});

/** Direct actions on a video without a report (moderator tools on the watch page). */
modRouter.post('/videos/:id', (req, res) => {
  const v = videoById(req.params.id);
  if (!v) throw new HttpError(404, 'Video not found');
  const action = String(req.body?.action || '');
  const status = { hide: 'hidden', remove: 'removed', restore: null }[action];
  if (status === undefined) throw new HttpError(400, 'Action must be hide, remove or restore');
  setVideoModeration(v, status, str(req.body?.reason, 300), req.user);
  res.json({ ok: true });
});

modRouter.get('/comments/held', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, u.username, u.display_name, u.remote_instance_id, v.title AS video_title FROM comments c
       JOIN users u ON u.id = c.user_id JOIN videos v ON v.id = c.video_id WHERE c.status = 'held' ORDER BY c.created_at DESC LIMIT 200`,
    )
    .all();
  res.json({ comments: rows.map(heldComment) });
});

export function heldComment(c) {
  return {
    id: c.id,
    video_id: c.video_id,
    video_title: c.video_title,
    body: c.body,
    held_reason: c.held_reason,
    created_at: c.created_at,
    author: { username: c.username, display_name: c.display_name, remote: !!c.remote_instance_id },
  };
}

modRouter.get('/log', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 500, 100);
  res.json({ actions: db.prepare('SELECT * FROM mod_actions ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) });
});

modRouter.get('/counter-notices', (req, res) => {
  const rows = db
    .prepare(
      `SELECT cn.*, u.username, v.title AS video_title, v.moderation_reason, t.claimant, t.work FROM counter_notices cn
       LEFT JOIN users u ON u.id = cn.user_id LEFT JOIN videos v ON v.id = cn.video_id LEFT JOIN takedown_notices t ON t.id = cn.notice_id
       ORDER BY cn.status = 'pending' DESC, cn.created_at DESC LIMIT 200`,
    )
    .all();
  res.json({ counter_notices: rows });
});

modRouter.post('/counter-notices/:id', (req, res) => {
  const cn = db.prepare('SELECT * FROM counter_notices WHERE id = ?').get(String(req.params.id));
  if (!cn) throw new HttpError(404, 'Counter-notice not found');
  if (cn.status !== 'pending') throw new HttpError(400, 'Already decided');
  const decision = req.body?.decision;
  if (!['accept', 'reject'].includes(decision)) throw new HttpError(400, 'Decision must be accept or reject');
  db.prepare('UPDATE counter_notices SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(decision === 'accept' ? 'accepted' : 'rejected', req.user.id, now(), cn.id);
  const v = videoById(cn.video_id);
  notifyModeration(cn.user_id, decision === 'accept' ? `Your ${v?.moderation_status === 'removed' ? 'counter-notice' : 'appeal'} was accepted` : `Your ${v?.moderation_status === 'removed' ? 'counter-notice' : 'appeal'} was declined`, {
    url: v ? `/watch/${v.id}` : null,
  });
  if (decision === 'accept') {
    if (v) setVideoModeration(v, null, 'Counter-notice accepted', req.user);
    if (cn.notice_id) {
      db.prepare("UPDATE takedown_notices SET status = 'restored' WHERE id = ?").run(cn.notice_id);
      db.prepare('DELETE FROM strikes WHERE notice_id = ?').run(cn.notice_id);
    }
  } else if (cn.notice_id) {
    db.prepare("UPDATE takedown_notices SET status = 'closed' WHERE id = ?").run(cn.notice_id);
  }
  logAction(req.user, `counter_notice.${decision}`, { targetType: 'video', targetId: cn.video_id, targetLabel: v?.title, details: str(req.body?.reason, 300) || null });
  res.json({ ok: true });
});

/** Settings moderators can change (comment spam controls). */
const SPAM_SETTINGS = ['spam_hold_first_comments', 'spam_new_account_hours', 'spam_hold_links_new_accounts', 'spam_check_impersonation', 'spam_rate_per_10min', 'spam_rate_new_per_10min'];

modRouter.get('/settings', (req, res) => {
  const s = getSettings();
  res.json({ settings: Object.fromEntries(SPAM_SETTINGS.map((k) => [k, s[k]])) });
});

modRouter.patch('/settings', (req, res) => {
  const b = req.body || {};
  for (const k of SPAM_SETTINGS) {
    if (b[k] === undefined) continue;
    if (k.startsWith('spam_hold') || k === 'spam_check_impersonation') setSetting(k, b[k] === true || b[k] === 'true' ? 'true' : 'false');
    else setSetting(k, String(clampInt(b[k], 0, 10000, 0)));
  }
  logAction(req.user, 'settings.spam', { details: b });
  const s = getSettings();
  res.json({ settings: Object.fromEntries(SPAM_SETTINGS.map((k) => [k, s[k]])) });
});

// ---- legal (admins) ---------------------------------------------------------------------------

const LEGAL_SETTINGS = [
  'legal_contact_email', 'legal_dmca_agent', 'legal_rules', 'legal_terms', 'legal_transparency_public',
  'removed_retention_days', 'strike_threshold', 'strike_expiry_days', 'strike_on_takedown',
];

export const legalAdminRouter = Router();
legalAdminRouter.use(requireAdmin);

function legalState() {
  const s = getSettings();
  return {
    settings: Object.fromEntries(LEGAL_SETTINGS.map((k) => [k, s[k]])),
    notices: db.prepare('SELECT * FROM takedown_notices ORDER BY received_at DESC LIMIT 500').all(),
  };
}

legalAdminRouter.get('/', (req, res) => res.json(legalState()));

legalAdminRouter.patch('/', (req, res) => {
  const b = req.body || {};
  const text = { legal_contact_email: 200, legal_dmca_agent: 2000, legal_rules: 10000, legal_terms: 10000 };
  for (const [k, max] of Object.entries(text)) if (b[k] !== undefined) setSetting(k, str(b[k], max));
  for (const k of ['legal_transparency_public', 'strike_on_takedown']) if (b[k] !== undefined) setSetting(k, b[k] === true || b[k] === 'true' ? 'true' : 'false');
  if (b.removed_retention_days !== undefined) setSetting('removed_retention_days', String(clampInt(b.removed_retention_days, 1, 3650, 30)));
  if (b.strike_threshold !== undefined) setSetting('strike_threshold', String(clampInt(b.strike_threshold, 0, 100, 3)));
  if (b.strike_expiry_days !== undefined) setSetting('strike_expiry_days', String(clampInt(b.strike_expiry_days, 0, 3650, 365)));
  logAction(req.user, 'settings.legal');
  res.json(legalState());
});

/** Records a takedown notice; with action "removed" the video is removed and the uploader gets a strike. */
legalAdminRouter.post('/takedowns', (req, res) => {
  const b = req.body || {};
  const claimant = str(b.claimant, 200).trim();
  const work = str(b.work, 2000).trim();
  if (!claimant || !work) throw new HttpError(400, 'Claimant and the copyrighted work are required');
  const action = ['removed', 'none', 'rejected'].includes(b.action) ? b.action : 'none';
  const ref = String(b.video || '').trim();
  const vid = (/\/watch\/([A-Za-z0-9_-]+)/.exec(ref) || [])[1] || ref;
  const v = vid ? videoById(vid) : null;
  if (action === 'removed' && !v) throw new HttpError(400, 'To remove a video, give its link or id');
  const id = newId();
  const t = now();
  const received = Number(new Date(b.received_at || t)) || t;
  db.prepare(
    `INSERT INTO takedown_notices (id, video_id, video_title, uploader_id, claimant, claimant_contact, work, url, received_at, action, notes, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?)`,
  ).run(id, v?.id || null, v?.title || null, v?.user_id || null, claimant, str(b.claimant_contact, 300), work, str(b.url || ref, 500), received, action, str(b.notes, 2000), req.user.id, t);
  logAction(req.user, 'takedown.record', { targetType: 'video', targetId: v?.id || null, targetLabel: v?.title || ref, details: `${claimant}: ${action}` });
  if (action === 'removed') {
    setVideoModeration(v, 'removed', `Copyright notice from ${claimant}`, req.user);
    if (getSettings().strike_on_takedown === 'true') addStrike(v.user_id, `Copyright notice from ${claimant} about "${v.title}"`, req.user, id);
  }
  res.status(201).json(legalState());
});

// ---- public -------------------------------------------------------------------------------------

export const legalPublicRouter = Router();

legalPublicRouter.get('/legal', (req, res) => {
  const s = getSettings();
  res.json({
    site_name: s.site_name,
    contact_email: s.legal_contact_email,
    dmca_agent: s.legal_dmca_agent,
    rules: s.legal_rules,
    terms: s.legal_terms,
    transparency_public: s.legal_transparency_public === 'true',
  });
});

legalPublicRouter.get('/transparency', (req, res) => {
  if (getSettings().legal_transparency_public !== 'true') throw new HttpError(404, 'Not published');
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    takedown_notices: count('SELECT COUNT(*) AS n FROM takedown_notices'),
    videos_removed_for_copyright: count("SELECT COUNT(*) AS n FROM takedown_notices WHERE action = 'removed'"),
    notices_rejected: count("SELECT COUNT(*) AS n FROM takedown_notices WHERE action = 'rejected'"),
    counter_notices: count('SELECT COUNT(*) AS n FROM counter_notices'),
    videos_restored: count("SELECT COUNT(*) AS n FROM counter_notices WHERE status = 'accepted'"),
    reports_received: count('SELECT COUNT(*) AS n FROM reports'),
    reports_actioned: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'resolved'"),
    accounts_suspended_or_banned: count("SELECT COUNT(*) AS n FROM users WHERE status IN ('suspended', 'banned') AND remote_instance_id IS NULL"),
    since: db.prepare('SELECT MIN(created_at) AS t FROM users').get().t,
    // The public log leaves out contact details and internal notes.
    notices: db
      .prepare('SELECT received_at, claimant, work, video_title, action, status FROM takedown_notices ORDER BY received_at DESC LIMIT 200')
      .all(),
  });
});
