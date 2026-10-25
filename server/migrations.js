/**
 * Numbered schema migrations. Each runs once, in order, inside a transaction, and is recorded in
 * `schema_version`. Before any migration after the baseline runs on a database that already has
 * data, a backup copy is written to DATA_DIR/backups.
 *
 * Add new migrations at the end. Never edit or reorder one that has shipped.
 */
import fs from 'node:fs';
import path from 'node:path';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumn(db, table, name, def) {
  if (!columns(db, table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline (schema up to v0.3)',
    // Idempotent on purpose: existing databases created before migrations already have most of this.
    up(db) {
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
  visibility TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'queued',
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
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  public_key TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT,
  hub_status TEXT,
  hub_note TEXT,
  hub_token_hash TEXT,
  feed_token TEXT,
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
  hidden INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_network_videos_created ON network_videos(created_at);
CREATE INDEX IF NOT EXISTS idx_network_videos_updated ON network_videos(updated_at);
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
      addColumn(db, 'videos', 'base_path', 'TEXT');
      addColumn(db, 'videos', 'base_duration', 'REAL');
      addColumn(db, 'videos', 'fps', 'REAL NOT NULL DEFAULT 0');
      addColumn(db, 'videos', 'edit_json', 'TEXT');
      addColumn(db, 'videos', 'edit_version', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'videos', 'render_status', 'TEXT');
      addColumn(db, 'videos', 'render_progress', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'videos', 'render_error', 'TEXT');
      addColumn(db, 'videos', 'federate', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'videos', 'updated_at', 'INTEGER');
      addColumn(db, 'users', 'remote_instance_id', 'INTEGER');
      addColumn(db, 'users', 'remote_avatar_url', 'TEXT');
      addColumn(db, 'users', 'remote_profile_url', 'TEXT');
      db.exec('UPDATE videos SET base_path = file_path, base_duration = duration WHERE base_path IS NULL AND file_path IS NOT NULL');
      db.exec('UPDATE videos SET updated_at = COALESCE(published_at, created_at) WHERE updated_at IS NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_videos_updated ON videos(updated_at, id)');
      // The v0.2 follow-based federation tables are no longer used.
      db.exec('DROP TABLE IF EXISTS remote_videos; DROP TABLE IF EXISTS followers; DROP TABLE IF EXISTS peers;');
    },
  },
  {
    version: 2,
    name: 'roles, account status, persistent jobs',
    up(db) {
      addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'user'"); // user | moderator | admin
      addColumn(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'"); // active | suspended | banned
      addColumn(db, 'users', 'status_reason', 'TEXT');
      db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1");
      db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT 'default',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL,
  dedupe_key TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, lane, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key) WHERE status = 'queued' AND dedupe_key IS NOT NULL;
`);
    },
  },
];

export function currentVersion(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
}

function hasData(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  } catch {
    return false;
  }
}

function backup(db, dataDir, label) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // Keep the 10 most recent automatic backups.
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('pre-migration-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .slice(10);
  for (const f of old) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {}
  }
  return file;
}

/** Applies every pending migration. Returns the list of versions applied. */
export function runMigrations(db, dataDir) {
  let version = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > version);
  if (!pending.length) return [];
  if (pending.some((m) => m.version > 1) && hasData(db)) {
    const file = backup(db, dataDir, `pre-migration-v${pending[pending.length - 1].version}`);
    console.log(`[db] backed up the database to ${file} before migrating`);
  }
  const applied = [];
  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${e.message}`);
    }
    applied.push(m.version);
    version = m.version;
  }
  console.log(`[db] schema is at version ${version} (applied ${applied.join(', ')})`);
  return applied;
}
