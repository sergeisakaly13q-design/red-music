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


function ensureOwnerAccount() {
  const ownerUsername = String(process.env.OWNER_USERNAME || "owners").trim().toLowerCase();
  const ownerPassword = String(process.env.OWNER_PASSWORD || "owner12345");

  if (!ownerUsername || !ownerPassword) return;

  const existing = db
    .prepare("SELECT id FROM users WHERE lower(username) = ?")
    .get(ownerUsername);

  if (!existing) {
    // Создаём OWNER автоматически на новой/пустой БД.
    // Пароль берётся из OWNER_PASSWORD, чтобы его можно было заменить
    // через Environment без изменения исходников.
    const bcrypt = require("bcryptjs");
    const passwordHash = bcrypt.hashSync(ownerPassword, 10);

    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name)
      VALUES (?, ?, ?)
    `).run(ownerUsername, passwordHash, ownerUsername.slice(0, 10));

    const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
    if (ownerRole) {
      db.prepare(
        "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)"
      ).run(info.lastInsertRowid, ownerRole.id);
    }

    console.log(`[db] Создан OWNER аккаунт: ${ownerUsername}`);
  }
}

function ensureSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);

  ensureOwnerAccount();

  // ID 1 и ID 2 всегда получают роль OWNER (как и в исходной demo-версии на localStorage)
  const ownerRole = db.prepare("SELECT id FROM roles WHERE name = 'OWNER'").get();
  if (ownerRole) {
    const insertUserRole = db.prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)"
    );
    const existingUsers = db.prepare("SELECT id FROM users WHERE id IN (1,2)").all();
    for (const u of existingUsers) insertUserRole.run(u.id, ownerRole.id);

    // Восстановление прав владельца после потери старой локальной базы:
    // текущий аккаунт владельца с логином "owners" получает OWNER автоматически.
    // При необходимости логин можно изменить через OWNER_USERNAME в Environment.
    const ownerUsername = String(process.env.OWNER_USERNAME || "owners").trim().toLowerCase();
    if (ownerUsername) {
      const ownerUser = db
        .prepare("SELECT id FROM users WHERE lower(username) = ?")
        .get(ownerUsername);
      if (ownerUser) {
        insertUserRole.run(ownerUser.id, ownerRole.id);
        console.log(`[db] OWNER восстановлен для аккаунта: ${ownerUsername}`);
      }
    }
  }
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
