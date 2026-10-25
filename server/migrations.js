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
  {
    version: 3,
    name: 'trust and safety: reports, moderation, takedowns, invites, comment states, privacy',
    up(db) {
      db.exec(`
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,            -- video | comment | user | remote_video | remote_comment
  target_id TEXT NOT NULL,
  target_title TEXT,
  target_url TEXT,
  target_owner TEXT,
  reason TEXT NOT NULL,                 -- copyright | spam | harassment | illegal | other
  details TEXT NOT NULL DEFAULT '',
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_label TEXT,
  source_instance_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
  resolution TEXT,
  notes TEXT NOT NULL DEFAULT '',
  handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);
CREATE INDEX idx_reports_status ON reports(status, created_at);
CREATE INDEX idx_reports_target ON reports(target_type, target_id);

CREATE TABLE mod_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  details TEXT,
  report_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mod_actions_created ON mod_actions(created_at);

CREATE TABLE takedown_notices (
  id TEXT PRIMARY KEY,
  video_id TEXT,
  video_title TEXT,
  uploader_id TEXT,
  claimant TEXT NOT NULL,
  claimant_contact TEXT NOT NULL DEFAULT '',
  work TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  action TEXT NOT NULL,                 -- removed | none | rejected
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'closed',-- closed | countered | restored
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_takedowns_video ON takedown_notices(video_id);

CREATE TABLE counter_notices (
  id TEXT PRIMARY KEY,
  notice_id TEXT,
  video_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  statement TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  notice_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_strikes_user ON strikes(user_id);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE comment_filters (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word TEXT NOT NULL COLLATE NOCASE,
  action TEXT NOT NULL DEFAULT 'hold',  -- hold | reject
  PRIMARY KEY (user_id, word)
);
`);
      addColumn(db, 'videos', 'moderation_status', 'TEXT'); // NULL | hidden | removed
      addColumn(db, 'videos', 'moderation_reason', 'TEXT');
      addColumn(db, 'videos', 'moderated_at', 'INTEGER');
      addColumn(db, 'videos', 'comment_mode', "TEXT NOT NULL DEFAULT 'inherit'"); // inherit | open | hold_all | off
      addColumn(db, 'videos', 'pinned_comment_id', 'TEXT');
      addColumn(db, 'comments', 'status', "TEXT NOT NULL DEFAULT 'visible'"); // visible | held
      addColumn(db, 'comments', 'held_reason', 'TEXT');
      addColumn(db, 'comments', 'hearted', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'users', 'comment_mode', "TEXT NOT NULL DEFAULT 'open'"); // open | hold_all
      addColumn(db, 'users', 'quota_bytes', 'INTEGER'); // NULL = instance default, 0 = unlimited
      addColumn(db, 'users', 'history_paused', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'users', 'terms_accepted_at', 'INTEGER');
      addColumn(db, 'users', 'invited_by', 'TEXT');
      addColumn(db, 'users', 'delete_requested_at', 'INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id)');
      // allow_registration (true/false) becomes registration_mode (open | approval | invite | closed).
      const old = db.prepare("SELECT value FROM settings WHERE key = 'allow_registration'").get();
      if (old && !db.prepare("SELECT 1 FROM settings WHERE key = 'registration_mode'").get()) {
        db.prepare("INSERT INTO settings (key, value) VALUES ('registration_mode', ?)").run(old.value === 'false' ? 'closed' : 'open');
      }
    },
  },
  {
    version: 4,
    name: 'gaming clip tools: games, clips cut from videos, GIF and MP4 exports',
    up(db) {
      db.exec(`
CREATE TABLE games (
  id TEXT PRIMARY KEY,               -- slug, also used as the network tag
  name TEXT NOT NULL,
  short_name TEXT,
  aliases TEXT NOT NULL DEFAULT '',  -- comma-separated slugs that mean the same game
  artwork TEXT,                      -- file in DIRS.thumbs
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE media_exports (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  format TEXT NOT NULL,              -- gif | mp4
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  width INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | working | ready | failed
  progress INTEGER NOT NULL DEFAULT 0,
  file TEXT,
  size_bytes INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_media_exports_user ON media_exports(user_id, created_at);
`);
      addColumn(db, 'videos', 'game_id', 'TEXT');
      addColumn(db, 'videos', 'source_video_id', 'TEXT'); // set on clips cut from another video
      addColumn(db, 'videos', 'source_start', 'REAL');
      addColumn(db, 'videos', 'source_end', 'REAL');
      addColumn(db, 'videos', 'allow_clips', 'INTEGER NOT NULL DEFAULT 0'); // others may clip it
      addColumn(db, 'network_videos', 'game_slug', 'TEXT');
      addColumn(db, 'network_videos', 'game_name', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_videos_game ON videos(game_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_videos_source ON videos(source_video_id)');
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
