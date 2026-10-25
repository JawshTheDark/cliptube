/**
 * Comment checks plugged into the intake pipeline (see intake.js). They apply to local people and
 * to people commenting from other instances alike.
 *
 * Order: channel comment mode, rate limits, the channel's keyword filters, hold-everything mode,
 * names that imitate the uploader, links from new accounts, first-time commenters.
 */
import { db, getSettings } from './db.js';
import { addCommentCheck } from './intake.js';
import { isLinkedCommenter } from './links.js';

const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(com|net|org|io|gg|ru|xyz|me|tv|co|ly|link|site|online|top|info|biz|app|live|shop|club)\b/i;

/** Folds a name so lookalikes compare equal: accents, digits standing in for letters, symbols. */
export function foldName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/l/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[^a-z]/g, '');
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** True when `author` is a different person whose name could be mistaken for `owner`'s. */
export function imitates(author, owner) {
  if (!author || !owner || author.id === owner.id) return false;
  const mine = [foldName(author.display_name), foldName(String(author.username).split('@')[0])];
  const theirs = [foldName(owner.display_name), foldName(owner.username)];
  return mine.some((x) => x.length >= 3 && theirs.some((y) => y.length >= 3 && (x === y || (Math.min(x.length, y.length) >= 5 && editDistance(x, y) <= 1))));
}

/** The comment mode in effect for a video: the video's own setting, else its channel's. */
export function effectiveCommentMode(video, owner) {
  if (video.comment_mode && video.comment_mode !== 'inherit') return video.comment_mode;
  return owner?.comment_mode || 'open';
}

addCommentCheck(({ video, author, body }) => {
  const s = getSettings();
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(video.user_id);
  const mode = effectiveCommentMode(video, owner);
  // Verified linked accounts of the uploader on other sites count as the uploader (see links.js).
  const isOwner = author.id === video.user_id || isLinkedCommenter(video.user_id, author);
  const isMod = author.role === 'admin' || author.role === 'moderator' || !!author.is_admin;
  if (mode === 'off' && !isOwner) return { status: 'rejected', reason: 'Comments are turned off for this video' };
  if (isOwner || isMod) return undefined;

  const ageHours = (Date.now() - Number(author.created_at || 0)) / 3600_000;
  const isNew = ageHours < (Number(s.spam_new_account_hours) || 0);

  const recent = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?').get(author.id, Date.now() - 600_000).n;
  const limit = Number(isNew ? s.spam_rate_new_per_10min : s.spam_rate_per_10min) || 20;
  if (recent >= limit) return { status: 'rejected', reason: "You're commenting too fast. Try again in a few minutes." };

  const lower = body.toLowerCase();
  for (const f of db.prepare('SELECT word, action FROM comment_filters WHERE user_id = ?').all(video.user_id)) {
    if (lower.includes(f.word.toLowerCase())) {
      return f.action === 'reject'
        ? { status: 'rejected', reason: "This comment contains a word the channel doesn't allow" }
        : { status: 'held', reason: `Contains a filtered word ("${f.word}")` };
    }
  }

  if (mode === 'hold_all') return { status: 'held', reason: 'This channel reviews every comment' };

  if (s.spam_check_impersonation === 'true' && imitates(author, owner)) {
    return { status: 'held', reason: "Name looks like the uploader's" };
  }

  if (isNew && s.spam_hold_links_new_accounts === 'true' && LINK_RE.test(body)) {
    return { status: 'held', reason: 'Links from new accounts are reviewed first' };
  }

  if (s.spam_hold_first_comments === 'true') {
    const hasApproved = db.prepare("SELECT 1 FROM comments WHERE user_id = ? AND status = 'visible' LIMIT 1").get(author.id);
    if (!hasApproved) return { status: 'held', reason: 'First comments are reviewed before they appear' };
  }
  return undefined;
});
