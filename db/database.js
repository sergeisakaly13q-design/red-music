const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// STORAGE_DIR позволяет на Render указать путь к подключённому Persistent Disk,
// чтобы файл базы и загруженная музыка переживали деплой/рестарт.
// Локально по умолчанию всё хранится прямо в папке проекта — ничего настраивать не нужно.
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "..");

const DB_DIR = path.join(STORAGE_DIR, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = process.env.SQLITE_PATH || path.join(DB_DIR, "red-music.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");


function ensureStage6Migrations() {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(x => x.name);
  if (!userCols.includes("profile_public")) db.exec("ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 0");
  if (!userCols.includes("vip_theme")) db.exec("ALTER TABLE users ADD COLUMN vip_theme TEXT NOT NULL DEFAULT 'default'");
  if (!userCols.includes("avatar_shape")) db.exec("ALTER TABLE users ADD COLUMN avatar_shape TEXT NOT NULL DEFAULT 'circle'");

  const cols = db.prepare("PRAGMA table_info(playlists)").all().map(x => x.name);
  if (!cols.includes("is_public")) db.exec("ALTER TABLE playlists ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS friendships (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('pending','accepted')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(requester_id,addressee_id), CHECK(requester_id<>addressee_id));
    CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id,status);
    CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id,status);
    CREATE TABLE IF NOT EXISTS now_playing (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, track_key TEXT NOT NULL, title TEXT DEFAULT '', artist TEXT DEFAULT '', playing INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS shared_tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_key TEXT NOT NULL, title TEXT NOT NULL, artist TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_shared_tracks_receiver ON shared_tracks(receiver_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS playlist_collaborators (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'editor', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(playlist_id,user_id));
    CREATE INDEX IF NOT EXISTS idx_playlist_collab_user ON playlist_collaborators(user_id);
  `);
}

function initializeMasterSafely() {
  // Никогда не очищаем существующих пользователей или связанные с ними данные.
  // Master создаётся только в действительно пустой базе.
  const existingUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (Number(existingUsers.count) > 0) return;

  const username = String(process.env.MASTER_USERNAME || "master").trim().toLowerCase();
  const password = String(process.env.MASTER_PASSWORD || "").trim();
  if (!password) {
    throw new Error("MASTER_PASSWORD must be configured before creating the OWNER account.");
  }

  const bcrypt = require("bcryptjs");
  const hash = bcrypt.hashSync(password, 12);

  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name)
    VALUES (?, ?, ?)
  `).run(username, hash, "Master");

  const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
  if (!ownerRole) throw new Error("Роль OWNER не найдена в схеме БД");

  db.prepare(
    "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)"
  ).run(info.lastInsertRowid, ownerRole.id);

  console.log("[db] Создан OWNER: Master");
}

function ensureSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);

  ensureStage6Migrations();
initializeMasterSafely();

  // Гарантируем OWNER для существующего Master/ID 1, не удаляя роли других аккаунтов.
  const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
  if (ownerRole) {
    const ownerExists = db.prepare("SELECT id FROM users WHERE id = 1").get();
    if (ownerExists) {
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (1, ?)").run(ownerRole.id);
    }
  }
  // Владелец (ID 1) никогда не должен оказаться заблокирован из-за отключённого
  // пароля — это может привести к невозможности войти в приложение. Снимаем этот
  // флаг при каждом запуске сервера как страховку.
  try {
    const ownerRow = db.prepare("SELECT id, password_disabled, password_hash FROM users WHERE id = 1").get();
    if (ownerRow && (ownerRow.password_disabled || !ownerRow.password_hash)) {
      const masterPassword = String(process.env.MASTER_PASSWORD || "").trim();
      if (masterPassword) {
        const bcrypt = require("bcryptjs");
        const hash = bcrypt.hashSync(masterPassword, 10);
        db.prepare("UPDATE users SET password_disabled = 0, password_hash = ?, session_version = session_version + 1 WHERE id = 1").run(hash);
        console.log("[db] OWNER (ID 1) был заблокирован — пароль восстановлен из MASTER_PASSWORD.");
      } else {
        console.warn("[db] OWNER (ID 1) заблокирован (пароль отключён), но MASTER_PASSWORD не задан — восстановить не удалось.");
      }
    }
  } catch (e) { console.error("[db] Не удалось проверить/восстановить пароль OWNER:", e.message); }

  // Безопасная миграция для отключения пароля без удаления профиля.
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    if (!cols.some((c) => c.name === "password_disabled")) {
      db.exec("ALTER TABLE users ADD COLUMN password_disabled INTEGER NOT NULL DEFAULT 0");
      console.log("[db] Добавлено поле password_disabled");
    }
    if (!cols.some((c) => c.name === "session_version")) {
      db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1");
      console.log("[db] Добавлено поле session_version");
    }
  } catch (e) { console.error("[db] Миграция users не выполнена:", e.message); }


  // Миграция для таблицы telegram_user_balance
  try {
    const balanceTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_user_balance'"
    ).get();
    if (!balanceTableExists) {
      db.exec(`
        CREATE TABLE telegram_user_balance (
          telegram_id TEXT PRIMARY KEY REFERENCES telegram_users(telegram_id) ON DELETE CASCADE,
          test_stars  INTEGER NOT NULL DEFAULT 0,
          real_stars  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_telegram_balance_updated ON telegram_user_balance(updated_at DESC);
      `);
      console.log("[db] Создана таблица telegram_user_balance");
    }
  } catch (e) { console.error("[db] Миграция telegram_user_balance не выполнена:", e.message); }

  // Stage 2: add immutable client metadata to reward sessions for history.
  try {
    const rewardCols = db.prepare("PRAGMA table_info(listening_reward_sessions)").all();
    if (!rewardCols.some((c) => c.name === "client_title")) db.exec("ALTER TABLE listening_reward_sessions ADD COLUMN client_title TEXT NOT NULL DEFAULT ''");
    if (!rewardCols.some((c) => c.name === "client_artist")) db.exec("ALTER TABLE listening_reward_sessions ADD COLUMN client_artist TEXT NOT NULL DEFAULT ''");
  } catch (e) { console.error('[db] Миграция reward session metadata не выполнена:', e.message); }

  // Stage 2: canonical listening events. This migration is intentionally
  // additive so existing listening_history data is never deleted.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS listening_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
        track_key TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT DEFAULT '',
        duration_seconds REAL NOT NULL DEFAULT 0,
        listened_seconds REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        played_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_listening_events_user_time
        ON listening_events(user_id, played_at DESC);
      CREATE INDEX IF NOT EXISTS idx_listening_events_user_track
        ON listening_events(user_id, track_key, played_at DESC);
    `);
  } catch (e) { console.error('[db] Миграция listening_events не выполнена:', e.message); }

  // Stage 2: migrate legacy completed history once into the canonical event table.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS redmusic_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const done = db.prepare("SELECT 1 FROM redmusic_migrations WHERE name = 'stage2-history-v1'").get();
    if (!done) {
      db.transaction(() => {
        db.exec(`
          INSERT INTO listening_events
            (user_id, track_id, track_key, title, artist, duration_seconds, listened_seconds, completed, played_at)
          SELECT h.user_id, h.track_id, 'track:' || h.track_id, t.title, COALESCE(t.artist,''),
                 COALESCE(t.duration_seconds,0), COALESCE(t.duration_seconds,0), 1, h.played_at
          FROM listening_history h
          JOIN tracks t ON t.id = h.track_id
          WHERE NOT EXISTS (
            SELECT 1 FROM listening_events e
            WHERE e.user_id = h.user_id AND e.track_key = 'track:' || h.track_id AND e.played_at = h.played_at
          );
        `);
        db.prepare("INSERT INTO redmusic_migrations(name) VALUES ('stage2-history-v1')").run();
      })();
      console.log('[db] Перенесена старая история прослушиваний в Stage 2.');
    }
  } catch (e) { console.error('[db] Миграция legacy history не выполнена:', e.message); }

  // Stage 3: add album metadata without touching existing track rows.
  try {
    const trackCols = db.prepare("PRAGMA table_info(tracks)").all();
    if (!trackCols.some((c) => c.name === "album")) {
      db.exec("ALTER TABLE tracks ADD COLUMN album TEXT DEFAULT ''");
      console.log('[db] Добавлено поле tracks.album');
    }
  } catch (e) { console.error('[db] Миграция tracks.album не выполнена:', e.message); }

  // Stage 4: recommendation feedback. Additive migration for existing databases.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recommendation_interactions (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_key TEXT NOT NULL,
        title TEXT DEFAULT '',
        artist TEXT DEFAULT '',
        action TEXT NOT NULL CHECK(action IN ('like','skip')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, track_key)
      );
      CREATE INDEX IF NOT EXISTS idx_recommendation_interactions_user
        ON recommendation_interactions(user_id, updated_at DESC);
    `);
  } catch (e) { console.error('[db] Миграция recommendation_interactions не выполнена:', e.message); }

  // Stage 3: artist subscriptions. Additive migration for existing databases.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artist_follows (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        artist_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, artist_name)
      );
      CREATE INDEX IF NOT EXISTS idx_artist_follows_user ON artist_follows(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artist_follows_artist ON artist_follows(artist_name COLLATE NOCASE);
    `);
  } catch (e) { console.error('[db] Миграция artist_follows не выполнена:', e.message); }

  // Stage 5: public profile flag. Additive migration for existing databases.
  try {
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some((c) => c.name === "profile_public")) {
      db.exec("ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 0");
      console.log('[db] Добавлено поле users.profile_public');
    }
  } catch (e) { console.error('[db] Миграция users.profile_public не выполнена:', e.message); }

  // Миграция: отдельный баланс звёзд, заработанных достижениями.
  try {
    const cols = db.prepare("PRAGMA table_info(telegram_user_balance)").all();
    if (!cols.some((c) => c.name === "earned_stars")) {
      db.exec("ALTER TABLE telegram_user_balance ADD COLUMN earned_stars INTEGER NOT NULL DEFAULT 0");
      console.log("[db] Добавлено поле telegram_user_balance.earned_stars");
    }
  } catch (e) { console.error("[db] Миграция earned_stars не выполнена:", e.message); }

  // Таблицы достижений/прослушивания создаются schema.sql. Для уже существующих
  // баз дополнительно проверяем их наличие, чтобы старые инсталляции не ломались.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS listening_reward_stats (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        completed_seconds INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS listening_reward_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
        client_track_key TEXT NOT NULL DEFAULT '',
        client_title TEXT NOT NULL DEFAULT '',
        client_artist TEXT NOT NULL DEFAULT '',
        duration_seconds REAL NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_position REAL NOT NULL DEFAULT 0,
        max_position REAL NOT NULL DEFAULT 0,
        listened_seconds REAL NOT NULL DEFAULT 0,
        suspicious INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS telegram_achievement_rewards (
        telegram_id TEXT NOT NULL REFERENCES telegram_users(telegram_id) ON DELETE CASCADE,
        milestone_hour INTEGER NOT NULL,
        stars INTEGER NOT NULL,
        awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (telegram_id, milestone_hour)
      );
    `);
  } catch (e) { console.error("[db] Миграция listening achievements не выполнена:", e.message); }

  console.log("[db] SQLite схема применена/проверена:", DB_PATH);
}

module.exports = { db, ensureSchema, STORAGE_DIR };
