// Запись действия в журнал (таблица audit_log).
// userId может быть null (например, неудачная попытка входа неизвестным логином).
function logAction(db, userId, action, details = "") {
  try {
    db.prepare(
      "INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)"
    ).run(userId, action, details);
  } catch (e) {
    console.error("[audit] Не удалось записать лог:", e.message);
  }
}

module.exports = { logAction };
