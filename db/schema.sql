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
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roles (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT UNIQUE NOT NULL,
  is_custom INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO roles (name, is_custom) VALUES
  ('USER', 0), ('VIP', 0), ('CO-CREATOR', 0), ('OWNER', 0);

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
