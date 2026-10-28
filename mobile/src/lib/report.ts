import { router } from 'expo-router';

/** What a report is about: a video, a comment or a channel here, or a video or comment from another server. */
export type ReportTarget = { type: 'video' | 'comment' | 'user' | 'remote_video' | 'remote_comment'; id: string; label?: string; extra?: Record<string, string> };

/** Opens the report screen for `target` (the website's report dialog). */
export function openReport(target: ReportTarget, server?: string | null) {
  router.push({
    pathname: '/report',
    params: { type: target.type, id: target.id, label: target.label || '', extra: target.extra ? JSON.stringify(target.extra) : '', ...(server ? { server } : {}) },
  });
}

/** The report target for a comment shown from `path` (`/videos/<id>` or `/network/videos/<peer>/<id>`). */
export function commentTarget(path: string, c: { id: string; body: string; author: { username: string } }): ReportTarget {
  const label = `"${c.body.slice(0, 120)}" by @${c.author.username}`;
  const m = /^\/network\/videos\/(\d+)\/(.+)$/.exec(path);
  if (m) {
    return { type: 'remote_comment', id: `${m[1]}:${decodeURIComponent(m[2])}:${c.id}`, label, extra: { comment_excerpt: c.body.slice(0, 200), comment_author: c.author.username } };
  }
  return { type: 'comment', id: c.id, label };
}
