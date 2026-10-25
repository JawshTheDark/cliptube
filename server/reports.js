/**
 * Reports and the moderation audit log. Kept free of heavy imports so the network inbox and the
 * moderation routes can both use it.
 */
import { db } from './db.js';
import { HttpError, newId, now, str } from './util.js';

export const REPORT_REASONS = {
  copyright: 'Copyright',
  spam: 'Spam or scam',
  harassment: 'Harassment or hate',
  illegal: 'Illegal content',
  other: 'Something else',
};

export const TARGET_TYPES = ['video', 'comment', 'user', 'remote_video', 'remote_comment'];

/** Records a moderation action in the audit log. `actor` is a user (or null for the system). */
export function logAction(actor, action, { targetType = null, targetId = null, targetLabel = null, details = null, reportId = null } = {}) {
  db.prepare(
    'INSERT INTO mod_actions (actor_id, actor_label, action, target_type, target_id, target_label, details, report_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    actor?.id || null,
    actor ? actor.username : 'system',
    action,
    targetType,
    targetId,
    targetLabel ? str(targetLabel, 200) : null,
    details ? str(typeof details === 'string' ? details : JSON.stringify(details), 1000) : null,
    reportId,
    now(),
  );
}

/**
 * Creates a report. A report about the same target from the same reporter while one is still open
 * is merged into it instead of piling up duplicates.
 */
export function createReport({ targetType, targetId, targetTitle = null, targetUrl = null, targetOwner = null, reason, details = '', reporterId = null, reporterLabel = null, sourceInstanceId = null }) {
  if (!TARGET_TYPES.includes(targetType)) throw new HttpError(400, 'Unknown report target');
  if (!REPORT_REASONS[reason]) throw new HttpError(400, `Reason must be one of ${Object.keys(REPORT_REASONS).join(', ')}`);
  const existing = db
    .prepare(
      "SELECT id FROM reports WHERE status = 'open' AND target_type = ? AND target_id = ? AND COALESCE(reporter_id, '') = COALESCE(?, '') AND COALESCE(reporter_label, '') = COALESCE(?, '')",
    )
    .get(targetType, String(targetId), reporterId, reporterLabel);
  if (existing) {
    db.prepare("UPDATE reports SET reason = ?, details = CASE WHEN ? != '' THEN ? ELSE details END WHERE id = ?").run(reason, str(details, 2000), str(details, 2000), existing.id);
    return existing.id;
  }
  const id = newId();
  db.prepare(
    `INSERT INTO reports (id, target_type, target_id, target_title, target_url, target_owner, reason, details, reporter_id, reporter_label, source_instance_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, targetType, String(targetId), targetTitle ? str(targetTitle, 200) : null, targetUrl ? str(targetUrl, 500) : null, targetOwner ? str(targetOwner, 100) : null,
    reason, str(details, 2000), reporterId, reporterLabel ? str(reporterLabel, 120) : null, sourceInstanceId, now(),
  );
  return id;
}

export function openReportCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
}
