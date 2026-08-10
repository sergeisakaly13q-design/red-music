const { db, ensureSchema } = require("./db/database");
try {
  ensureSchema();
  const users = db.prepare("SELECT id, username, display_name, created_at FROM users ORDER BY id DESC").all();
  console.table(users);
  console.log(`Всего пользователей: ${users.length}`);
} finally {
  db.close();
}
