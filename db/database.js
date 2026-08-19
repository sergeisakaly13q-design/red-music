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


function resetAccountsAndCreateMaster() {
  // Одноразовая инициализация владельца для этой версии проекта.
  // После выполнения повторные перезапуски не удаляют новых пользователей.
  const markerTable = "red_music_master_reset_v1";
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${markerTable} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const done = db.prepare(`SELECT id FROM ${markerTable} WHERE id = 1`).get();
  if (done) return;

  // Никогда не очищаем существующую базу. Это особенно важно после рестартов/деплоев.
  // Если пользователи уже есть, просто отмечаем инициализацию завершённой.
  const existingUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (Number(existingUsers.count) > 0) {
    db.prepare(`INSERT OR IGNORE INTO ${markerTable} (id) VALUES (1)`).run();
    return;
  }

  const username = String(process.env.MASTER_USERNAME || "master").trim().toLowerCase();
  const password = String(process.env.MASTER_PASSWORD || "").trim();
  if (!password) {
    throw new Error("MASTER_PASSWORD must be configured before creating the OWNER account.");
  }
  const bcrypt = require("bcryptjs");

  const reset = db.transaction(() => {
    // Удаляем аккаунты и только связанные с ними данные через FK.
    db.prepare("DELETE FROM users").run();
    // AUTOINCREMENT иначе продолжит старую последовательность и ID может быть не 1.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'users'").run();

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name)
      VALUES (?, ?, ?)
    `).run(username, hash, "Master");

    if (Number(info.lastInsertRowid) !== 1) {
      throw new Error(`Не удалось создать Master с ID 1 (получен ID ${info.lastInsertRowid})`);
    }

    const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
    if (!ownerRole) throw new Error("Роль OWNER не найдена в схеме БД");

    db.prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)"
    ).run(1, ownerRole.id);

    db.prepare(`INSERT INTO ${markerTable} (id) VALUES (1)`).run();
  });

  reset();
  console.log("[db] Создан OWNER: Master (ID 1)");
}

function ensureSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);

  resetAccountsAndCreateMaster();

  // OWNER закреплён только за аккаунтом ID 1.
  // Старые/ошибочные OWNER-роли у других пользователей автоматически снимаются.
  const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
  if (ownerRole) {
    db.prepare("DELETE FROM user_roles WHERE role_id = ? AND user_id != 1").run(ownerRole.id);
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
