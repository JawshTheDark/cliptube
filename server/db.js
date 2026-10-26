import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DIRS } from './config.js';
import { runMigrations } from './migrations.js';

for (const d of [DATA_DIR, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'cliptube.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// The schema lives in migrations.js; this brings any database up to date (with a backup first).
runMigrations(db, DATA_DIR);

/** Runs fn inside a transaction. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Marks a video as changed so network peers pick it up on their next sync. */
export function touchVideo(id) {
  db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export const DEFAULT_SETTINGS = {
  site_name: 'OurTube',
  allow_registration: 'true', // legacy; registration_mode replaces it
  registration_mode: 'open', // open | approval | invite | closed
  max_upload_mb: '8192',
  default_quota_mb: '0', // per-user storage quota, 0 = unlimited

  // Legal and abuse handling.
  legal_contact_email: '',
  legal_dmca_agent: '',
  legal_rules: '',
  legal_terms: '',
  legal_transparency_public: 'true',
  removed_retention_days: '30', // removed videos' files are kept this long in case of a counter-notice
  strike_threshold: '3', // active strikes that suspend an account
  strike_expiry_days: '365',
  strike_on_takedown: 'true',

  // Comment spam controls (apply to people from other instances too).
  spam_hold_first_comments: 'true',
  spam_new_account_hours: '24',
  spam_hold_links_new_accounts: 'true',
  spam_check_impersonation: 'true',
  spam_rate_per_10min: '20',
  spam_rate_new_per_10min: '5',

  max_height: '1080',
  encoder: 'libx264',
  delete_originals: 'false',
  public_url: '',
  instance_description: '',
  // Email (optional): notifications people opt into, address checks and password resets.
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: 'starttls', // starttls | tls | none
  smtp_user: '',
  smtp_password: '',
  smtp_from: '',
  // Game artwork from SteamGridDB (needs an API key from a SteamGridDB account).
  steamgriddb_api_key: '',
  steamgriddb_auto: 'true', // fill in covers, logos and banners for new games
  vapid_public_key: '',
  vapid_private_key: '',
  // ActivityPub (Mastodon, PeerTube and the rest of the fediverse).
  activitypub_enabled: 'true',
  ap_instance_public_key: '',
  ap_instance_private_key: '',
  hls_ladder: 'off', // off | 720 (720p plus source) | full (1080p, 720p, 480p plus source)
  federation_rendition: 'true', // a ~720p MP4 for platforms that only cache small remote videos
  show_dislikes: 'true',

  // Membership in a network (this instance as a member of a hub).
  network_enabled: 'false',
  network_hub_url: 'https://clips.irc.so',
  network_accept_comments: 'true',
  network_accept_likes: 'true',
  network_accept_subscriptions: 'true',
  // Peering directly with other instances (every instance, hub or not). On a hub the hub switches apply.
  network_accept_new: 'true', // lockdown switch: false = no new peers
  network_require_approval: 'false', // new peers wait for an admin
  network_require_https: 'true',
  network_publish_blocklist: 'true',
  network_max_peers: '200',

  // Hub mode (this instance runs the network).
  hub_enabled: 'false',
  hub_network_name: 'OurTube Network',
  hub_accept_new: 'true', // lockdown switch: false = no new instances can join
  hub_require_approval: 'false', // new instances wait for the hub admin
  hub_require_https: 'true',
  hub_allow_comments: 'true',
  hub_allow_likes: 'true',
  hub_allow_subscriptions: 'true',
  hub_include_own_videos: 'true',
  hub_max_videos_per_instance: '5000',
  hub_sync_minutes: '10',
  hub_announcement: '',
};

/** Settings that must never be sent to a browser, even an admin's. */
export const SECRET_SETTINGS = new Set([
  'instance_private_key', 'network_hub_token', 'network_feed_token_hash', 'network_join_nonce', 'smtp_password', 'vapid_private_key', 'steamgriddb_api_key',
  'ap_instance_private_key',
]);

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value;
  return s;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** Local accounts only (placeholder accounts for people on other instances don't count). */
export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE remote_instance_id IS NULL').get().n;
}
