-- Red Music — схема базы данных SQLite
-- Применяется автоматически при старте сервера (db/database.js -> ensureSchema)

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_disabled INTEGER NOT NULL DEFAULT 0,
  display_name  TEXT NOT NULL,
  bio           TEXT DEFAULT '',
  avatar_url    TEXT DEFAULT '',
  avatar_color  TEXT DEFAULT 'linear-gradient(135deg,#ff0055,#e00000)',
  vip_until     TEXT,
  banned        INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roles (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT UNIQUE NOT NULL,
  is_custom INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO roles (name, is_custom) VALUES
  ('USER', 0), ('VIP', 0), ('RUBY', 0), ('CO-CREATOR', 0), ('OWNER', 0);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  artist      TEXT DEFAULT '',
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  duration_seconds INTEGER,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS listening_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_user ON listening_history(user_id, played_at DESC);

CREATE TABLE IF NOT EXISTS track_play_counts (
  track_key   TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT DEFAULT '',
  play_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_play_counts_count ON track_play_counts(play_count DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  details    TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);


CREATE TABLE IF NOT EXISTS promo_codes (
  code        TEXT PRIMARY KEY,
  vip_days    INTEGER NOT NULL DEFAULT 7,
  max_uses    INTEGER,
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  code        TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, user_id)
);


CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  path TEXT DEFAULT '',
  method TEXT DEFAULT '',
  status_code INTEGER,
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT UNIQUE NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_security_blocks_until ON security_blocks(blocked_until);


CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'redmusic',
  source_url TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  artist TEXT DEFAULT '',
  album TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'redmusic',
  external_id TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  track_key TEXT DEFAULT '',
  matched_track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  offline_requested INTEGER NOT NULL DEFAULT 0,
  offline_available INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_external ON playlist_tracks(source, external_id);

CREATE TABLE IF NOT EXISTS playlist_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  playlist_name TEXT DEFAULT '',
  track_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'preview',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_playlist_imports_user ON playlist_imports(user_id, created_at DESC);
