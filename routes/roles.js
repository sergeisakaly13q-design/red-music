const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../db/audit");

const PROTECTED_OWNER_IDS = [1, 2]; // ID 1 и ID 2 всегда OWNER — как в демо-версии

module.exports = function createRolesRouter(db) {
  const router = express.Router();
  const canManageRoles = requireRole(db, "OWNER", "CO-CREATOR");

  router.get("/", requireAuth, (req, res) => {
    const roles = db.prepare("SELECT id, name, is_custom FROM roles ORDER BY id").all();
    res.json({ roles });
  });

  router.post("/", requireAuth, canManageRoles, (req, res) => {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Укажите название роли" });
    const cleanName = String(name).trim().toUpperCase().slice(0, 32);
    db.prepare("INSERT OR IGNORE INTO roles (name, is_custom) VALUES (?, 1)").run(cleanName);
    const role = db.prepare("SELECT * FROM roles WHERE name = ?").get(cleanName);
    logAction(db, req.userId, "role_created", `Создана роль ${cleanName}`);
    res.json({ role });
  });

  router.post("/:userId/toggle", requireAuth, canManageRoles, (req, res) => {
    const targetId = Number(req.params.userId);
    const { roleName } = req.body || {};
    if (!roleName) return res.status(400).json({ error: "Не указана роль" });

    if (PROTECTED_OWNER_IDS.includes(targetId) && roleName.toUpperCase() === "OWNER") {
      return res.status(400).json({ error: "У пользователей ID 1 и ID 2 роль OWNER закреплена навсегда" });
    }

    const role = db.prepare("SELECT id FROM roles WHERE name = ?").get(roleName.toUpperCase());
    if (!role) return res.status(404).json({ error: "Роль не найдена" });

    const existing = db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?").get(targetId, role.id);
    if (existing) {
      db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?").run(targetId, role.id);
      logAction(db, req.userId, "role_removed", `Роль ${roleName} снята с пользователя #${targetId}`);
      res.json({ action: "removed", roleName });
    } else {
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(targetId, role.id);
      logAction(db, req.userId, "role_added", `Роль ${roleName} назначена пользователю #${targetId}`);
      res.json({ action: "added", roleName });
    }
  });

  return router;
};
