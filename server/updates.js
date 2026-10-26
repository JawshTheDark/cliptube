// Tells admins when a newer OurTube is out: every 12 hours the version on GitHub's main branch is read and
// compared with this one. A new version is announced to each admin once (a notification and a banner in Admin).
// It can be turned off under Admin -> Debugging; UPDATE_CHECK_URL=off turns it off for the whole install.
import { db, getSettings, setSetting } from './db.js';
import { VERSION } from './config.js';
import { notify } from './notify.js';
import { now } from './util.js';

export const REPO_URL = 'https://github.com/JawshTheDark/ourtube';
const SOURCE = process.env.UPDATE_CHECK_URL || 'https://raw.githubusercontent.com/JawshTheDark/ourtube/main/package.json';
const EVERY_MS = 12 * 3600_000;

const parts = (v) => String(v || '').split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0);
/** True when version a is newer than version b (major.minor.patch). */
export function newer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function updateState() {
  const s = getSettings();
  const latest = s.update_latest || null;
  return {
    enabled: s.update_check !== 'false' && SOURCE !== 'off',
    current: VERSION,
    latest,
    available: !!latest && newer(latest, VERSION),
    checked_at: Number(s.update_checked_at) || null,
    error: s.update_error || null,
    repo: REPO_URL,
    changes: `${REPO_URL}/commits/main`,
  };
}

export async function checkForUpdate() {
  if (!updateState().enabled) return updateState();
  try {
    const r = await fetch(SOURCE, { headers: { 'User-Agent': `OurTube/${VERSION} (update check)` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const latest = String((await r.json()).version || '');
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error('No version number in the answer');
    setSetting('update_latest', latest);
    setSetting('update_error', '');
    if (newer(latest, VERSION) && getSettings().update_notified !== latest) {
      setSetting('update_notified', latest);
      const admins = db.prepare("SELECT id FROM users WHERE is_admin = 1 AND remote_instance_id IS NULL AND status = 'active'").all();
      for (const a of admins) {
        notify(a.id, {
          kind: 'update',
          title: `OurTube ${latest} is out (this server runs ${VERSION})`,
          body: 'See what changed and how to update under Admin.',
          url: '/admin',
          dedupe: `update:${latest}`,
        });
      }
    }
  } catch (e) {
    setSetting('update_error', String(e.message).slice(0, 200));
  }
  setSetting('update_checked_at', String(now()));
  return updateState();
}

export function startUpdateChecks() {
  if (SOURCE === 'off') return;
  const loop = () => {
    checkForUpdate()
      .catch(() => {})
      .finally(() => setTimeout(loop, EVERY_MS).unref());
  };
  setTimeout(loop, 60_000).unref();
}
