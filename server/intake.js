/**
 * Content intake: every new comment, like and report passes through here, whether it was made on
 * this instance or arrived from another one. Spam filters, moderation holds and federation all
 * plug in at this one place, so local and remote content always get the same treatment.
 *
 * Each check returns { status, reason }:
 *   visible   publish normally
 *   held      store it, show it only to its author (and moderators) until approved
 *   rejected  refuse it; `reason` is shown to the sender
 */

const commentChecks = [];
const likeChecks = [];

/** Registers an extra comment check: fn(ctx) => undefined | { status, reason }. */
export function addCommentCheck(fn) {
  commentChecks.push(fn);
}

export function addLikeCheck(fn) {
  likeChecks.push(fn);
}

function runChecks(checks, ctx) {
  let held = null;
  for (const check of checks) {
    const r = check(ctx);
    if (!r) continue;
    if (r.status === 'rejected') return r;
    if (r.status === 'held' && !held) held = r;
  }
  return held || { status: 'visible', reason: null };
}

/**
 * ctx: { video, author (users row), body, parentId, remote (bool), instance (instances row or null) }
 */
export function intakeComment(ctx) {
  return runChecks(commentChecks, ctx);
}

/** ctx: { video, author, value, remote, instance } */
export function intakeLike(ctx) {
  return runChecks(likeChecks, ctx);
}
