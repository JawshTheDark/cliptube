import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DIRS } from './config.js';

for (const d of [DATA_DIR, ...Object.values(DIRS)]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'cliptube.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  banner TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',   -- public | unlisted | private
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | processing | ready | failed
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  original_name TEXT,
  original_path TEXT,
  file_path TEXT,
  thumb_path TEXT,
  custom_thumb INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at);
CREATE INDEX IF NOT EXISTS idx_videos_list ON videos(status, visibility, created_at);

CREATE TABLE IF NOT EXISTS tags (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (video_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_video ON likes(video_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscriber_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_channel ON subscriptions(channel_id);

CREATE TABLE IF NOT EXISTS views (
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  viewer_key TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, viewer_key)
);

CREATE TABLE IF NOT EXISTS history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  watched_at INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Federation: instances we pull public videos from.
CREATE TABLE IF NOT EXISTS peers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  token TEXT,
  nonce TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | error
  paused INTEGER NOT NULL DEFAULT 0,
  video_count INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_full_sync_at INTEGER,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Federation: instances that pull from us.
CREATE TABLE IF NOT EXISTS followers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | blocked
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_followers_token ON followers(token_hash);

-- Federation: cached index of peers' public videos (metadata only, media stays on the origin).
CREATE TABLE IF NOT EXISTS remote_videos (
  peer_id INTEGER NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  thumbnail_url TEXT,
  video_url TEXT NOT NULL,
  watch_url TEXT NOT NULL,
  uploader_username TEXT NOT NULL,
  uploader_display_name TEXT NOT NULL,
  uploader_avatar_url TEXT,
  uploader_url TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (peer_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_remote_created ON remote_videos(created_at);

-- Network (hub model). One row per ClipTube instance this server knows about.
-- On a member these come from the hub's directory; on the hub they are the members.
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  public_key TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,          -- this server's own block list
  block_reason TEXT,
  hub_status TEXT,                             -- pending | approved | suspended | banned | gone
  hub_note TEXT,                               -- reason shown to the member
  hub_token_hash TEXT,                         -- member -> hub auth (hub side)
  feed_token TEXT,                             -- hub -> member feed auth (hub side)
  allow_interactions INTEGER NOT NULL DEFAULT 1,
  listed INTEGER NOT NULL DEFAULT 1,
  video_count INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_full_sync_at INTEGER,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  version TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instances_token ON instances(hub_token_hash);

-- Public videos from other instances (metadata only; files stream from their origin).
CREATE TABLE IF NOT EXISTS network_videos (
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  thumbnail_url TEXT,
  video_url TEXT NOT NULL,
  watch_url TEXT NOT NULL,
  uploader_username TEXT NOT NULL,
  uploader_display_name TEXT NOT NULL,
  uploader_avatar_url TEXT,
  uploader_url TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,           -- hidden by this server's admin (network-wide when this is the hub)
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_network_videos_created ON network_videos(created_at);
CREATE INDEX IF NOT EXISTS idx_network_videos_updated ON network_videos(updated_at);

-- What local users did to videos and channels on other instances (for their own UI state and feeds).
CREATE TABLE IF NOT EXISTS network_likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, instance_id, remote_id)
);
CREATE TABLE IF NOT EXISTS network_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  profile_url TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, instance_id, username)
);
`);

// ---- additive migrations -----------------------------------------------------

function addColumn(table, name, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addColumn('videos', 'base_path', 'TEXT');                      // first processed MP4, the source for edits
addColumn('videos', 'base_duration', 'REAL');
addColumn('videos', 'fps', 'REAL NOT NULL DEFAULT 0');
addColumn('videos', 'edit_json', 'TEXT');                      // current edit decision list, NULL = unedited
addColumn('videos', 'edit_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('videos', 'render_status', 'TEXT');                  // NULL | queued | rendering | failed
addColumn('videos', 'render_progress', 'INTEGER NOT NULL DEFAULT 0');
addColumn('videos', 'render_error', 'TEXT');
addColumn('videos', 'federate', 'INTEGER NOT NULL DEFAULT 1'); // include in the federated network when public
addColumn('videos', 'updated_at', 'INTEGER');
// People from other instances who like, comment or subscribe here get a placeholder account
// ("name@their.host") that can never log in.
addColumn('users', 'remote_instance_id', 'INTEGER');
addColumn('users', 'remote_avatar_url', 'TEXT');
addColumn('users', 'remote_profile_url', 'TEXT');
db.exec('UPDATE videos SET base_path = file_path, base_duration = duration WHERE base_path IS NULL AND file_path IS NOT NULL');
db.exec('UPDATE videos SET updated_at = COALESCE(published_at, created_at) WHERE updated_at IS NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_videos_updated ON videos(updated_at, id)');

/** Marks a video as changed so federation peers pick it up on their next sync. */
export function touchVideo(id) {
  db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export const DEFAULT_SETTINGS = {
  site_name: 'ClipTube',
  allow_registration: 'true',
  max_upload_mb: '8192',
  max_height: '1080',
  encoder: 'libx264',
  delete_originals: 'false',
  public_url: '',
  instance_description: '',

  // Membership in a network (this instance as a member of a hub).
  network_enabled: 'false',
  network_hub_url: 'https://clips.irc.so',
  network_accept_comments: 'true',
  network_accept_likes: 'true',
  network_accept_subscriptions: 'true',

  // Hub mode (this instance runs the network).
  hub_enabled: 'false',
  hub_network_name: 'ClipTube Network',
  hub_accept_new: 'true',          // lockdown switch: false = no new instances can join
  hub_require_approval: 'false',   // new instances wait for the hub admin
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
  'instance_private_key', 'network_hub_token', 'network_feed_token_hash', 'network_join_nonce',
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
