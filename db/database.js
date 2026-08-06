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


function resetAccountsAndCreateOwner() {
  // Одноразовый сброс аккаунтов. После выполнения в этой БД больше
  // не повторяется, поэтому обычные перезапуски не удаляют новых пользователей.
  const markerTable = "red_music_account_reset_v2";
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${markerTable} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const alreadyDone = db.prepare(`SELECT id FROM ${markerTable} WHERE id = 1`).get();
  if (alreadyDone) return;

  const ownerUsername = "ColdCodi";
  const ownerPassword = "11111111111111111111";
  const bcrypt = require("bcryptjs");

  const reset = db.transaction(() => {
    // Удаляем только аккаунты и связанные с ними данные.
    // Остальные таблицы/функции проекта не трогаются.
    db.prepare("DELETE FROM users").run();

    const passwordHash = bcrypt.hashSync(ownerPassword, 10);
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name)
      VALUES (?, ?, ?)
    `).run(ownerUsername, passwordHash, ownerUsername);

    const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
    if (!ownerRole) throw new Error("Роль OWNER не найдена в схеме БД.");

    db.prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)"
    ).run(info.lastInsertRowid, ownerRole.id);

    db.prepare(`INSERT INTO ${markerTable} (id) VALUES (1)`).run();
  });

  reset();
  console.log(`[db] Аккаунты сброшены. Создан OWNER: ${ownerUsername}`);
}

function ensureSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);

  resetAccountsAndCreateOwner();
  // Безопасная миграция для отключения пароля без удаления профиля.
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    if (!cols.some((c) => c.name === "password_disabled")) {
      db.exec("ALTER TABLE users ADD COLUMN password_disabled INTEGER NOT NULL DEFAULT 0");
      console.log("[db] Добавлено поле password_disabled");
    }
  } catch (e) { console.error("[db] Миграция password_disabled не выполнена:", e.message); }
  console.log("[db] SQLite схема применена/проверена:", DB_PATH);
}

module.exports = { db, ensureSchema, STORAGE_DIR };
