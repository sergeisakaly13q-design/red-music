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
  console.log("[db] SQLite схема применена/проверена:", DB_PATH);
}

module.exports = { db, ensureSchema, STORAGE_DIR };
