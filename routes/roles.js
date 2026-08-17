const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../db/audit");

const OWNER_ID = 1;

module.exports = function createRolesRouter(db) {
  const router = express.Router();
  const ownerOnly = requireRole(db, "OWNER");

  router.get("/", requireAuth, (req, res) => {
    const roles = db.prepare("SELECT id, name, is_custom FROM roles ORDER BY id").all();
    res.json({ roles });
  });

  router.post("/", requireAuth, ownerOnly, (req, res) => {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Укажите название роли" });
    const cleanName = String(name).trim().toUpperCase().slice(0, 32);
    if (cleanName === "OWNER") return res.status(400).json({ error: "Роль OWNER зарезервирована за владельцем ID 1" });
    db.prepare("INSERT OR IGNORE INTO roles (name, is_custom) VALUES (?, 1)").run(cleanName);
    const role = db.prepare("SELECT * FROM roles WHERE name = ?").get(cleanName);
    logAction(db, req.userId, "role_created", `Создана роль ${cleanName}`);
    res.json({ role });
  });

  router.post("/:userId/toggle", requireAuth, ownerOnly, (req, res) => {
    const targetId = Number(req.params.userId);
    const roleName = String(req.body?.roleName || "").trim().toUpperCase();
    if (!Number.isInteger(targetId) || targetId < 1) return res.status(400).json({ error: "Некорректный ID пользователя" });
    if (!roleName) return res.status(400).json({ error: "Не указана роль" });

    // Никакой пользователь кроме ID 1 физически не может получить OWNER.
    if (roleName === "OWNER" && targetId !== OWNER_ID) {
      return res.status(403).json({ error: "OWNER доступен только владельцу проекта (ID 1)" });
    }
    // Даже владелец не может снять OWNER с самого себя.
    if (roleName === "OWNER" && targetId === OWNER_ID) {
      return res.status(400).json({ error: "OWNER закреплён за владельцем и не может быть снят" });
    }

    const role = db.prepare("SELECT id FROM roles WHERE name = ?").get(roleName);
    if (!role) return res.status(404).json({ error: "Роль не найдена" });
    const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetId);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });

    const existing = db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?").get(targetId, role.id);
    if (existing) {
      db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?").run(targetId, role.id);
      const assigned = db.prepare("SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.id").all(targetId).map(r => r.name);
      logAction(db, req.userId, "role_removed", `Роль ${roleName} снята с пользователя #${targetId}`);
      return res.json({ action: "removed", roleName, roles: assigned });
    }
    db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(targetId, role.id);
    const assigned = db.prepare("SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.id").all(targetId).map(r => r.name);
    logAction(db, req.userId, "role_added", `Роль ${roleName} назначена пользователю #${targetId}`);
    res.json({ action: "added", roleName, roles: assigned });
  });

  return router;
};
