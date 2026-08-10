const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../db/audit");

module.exports = function createLogsRouter(db) {
  const router = express.Router();
  const canViewLogs = requireRole(db, "OWNER", "CO-CREATOR");
  const ownerOnly = requireRole(db, "OWNER");

  router.get("/", requireAuth, canViewLogs, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = db
      .prepare(
        `SELECT al.id, al.action, al.details, al.created_at, u.username
         FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
         ORDER BY al.created_at DESC LIMIT ?`
      )
      .all(limit);
    res.json({ logs });
  });

  router.get("/stats", requireAuth, ownerOnly, (req, res) => {
    const users = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const active = db.prepare("SELECT COUNT(*) AS count FROM users WHERE banned = 0").get().count;
    const banned = db.prepare("SELECT COUNT(*) AS count FROM users WHERE banned = 1").get().count;
    const tracks = db.prepare("SELECT COUNT(*) AS count FROM tracks").get().count;
    res.json({ users: Number(users), active: Number(active), banned: Number(banned), tracks: Number(tracks) });
  });

  router.get("/users", requireAuth, ownerOnly, (req, res) => {
    const users = db.prepare(
      `SELECT id, username, display_name, bio, avatar_url, avatar_color, vip_until, banned, password_disabled, created_at
       FROM users ORDER BY id DESC`
    ).all();
    const rolesStmt = db.prepare(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`
    );
    const result = users.map((u) => ({
      ...u,
      banned: !!u.banned,
      roles: rolesStmt.all(u.id).map((r) => r.name),
    }));
    res.json({ users: result });
  });

  router.post("/users/:id/ban", requireAuth, canViewLogs, (req, res) => {
    db.prepare("UPDATE users SET banned = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  router.post("/users/:id/unban", requireAuth, canViewLogs, (req, res) => {
    db.prepare("UPDATE users SET banned = 0 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  router.get("/users/:id/roles", requireAuth, ownerOnly, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID" });
    const roles = db.prepare("SELECT id, name, is_custom FROM roles ORDER BY id").all();
    const assigned = db.prepare("SELECT role_id FROM user_roles WHERE user_id = ?").all(id).map(r => r.role_id);
    res.json({ roles, assigned });
  });

  router.post("/users/:id/roles/toggle", requireAuth, ownerOnly, (req, res) => {
    const id = Number(req.params.id);
    const roleName = String(req.body?.roleName || "").trim().toUpperCase();
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID" });
    if (!roleName) return res.status(400).json({ error: "Роль не указана" });
    if (roleName === "OWNER" && id !== 1) return res.status(403).json({ error: "OWNER доступен только владельцу ID 1" });
    if (roleName === "OWNER" && id === 1) return res.status(400).json({ error: "OWNER закреплён за владельцем" });
    const role = db.prepare("SELECT id, name FROM roles WHERE name = ?").get(roleName);
    if (!role) return res.status(404).json({ error: "Роль не найдена" });
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(id)) return res.status(404).json({ error: "Пользователь не найден" });
    const exists = db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?").get(id, role.id);
    if (exists) db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?").run(id, role.id);
    else db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(id, role.id);
    const assigned = db.prepare("SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? ORDER BY r.id").all(id).map(r=>r.name);
    logAction(db, req.userId, exists ? "role_removed" : "role_added", `Роль ${roleName} ${exists ? "снята с" : "назначена"} пользователя #${id}`);
    res.json({ ok:true, action: exists ? "removed" : "added", roles: assigned });
  });

  router.post("/users/:id/block", requireAuth, ownerOnly, (req, res) => {
    const id=Number(req.params.id);
    if (id === 1) return res.status(400).json({ error: "Нельзя заблокировать владельца" });
    db.prepare("UPDATE users SET banned = CASE WHEN banned=1 THEN 0 ELSE 1 END WHERE id=?").run(id);
    const row=db.prepare("SELECT banned FROM users WHERE id=?").get(id);
    if (!row) return res.status(404).json({error:"Пользователь не найден"});
    logAction(db, req.userId, row.banned ? "admin_user_block" : "admin_user_unblock", `Пользователь #${id}`);
    res.json({ok:true,banned:!!row.banned});
  });

  router.delete("/users/:id", requireAuth, ownerOnly, (req, res) => {
    const id=Number(req.params.id);
    if (id === 1) return res.status(400).json({error:"Нельзя удалить владельца"});
    const info=db.prepare("DELETE FROM users WHERE id=?").run(id);
    if (!info.changes) return res.status(404).json({error:"Пользователь не найден"});
    logAction(db, req.userId, "admin_user_delete", `Удалён пользователь #${id}`);
    res.json({ok:true});
  });

  router.post("/users/:id/delete-password", requireAuth, ownerOnly, (req,res)=>{
    const id=Number(req.params.id);
    if (id === 1) return res.status(400).json({error:"Нельзя удалить пароль владельца"});
    const info=db.prepare("UPDATE users SET password_disabled=1, password_hash='' WHERE id=?").run(id);
    if (!info.changes) return res.status(404).json({error:"Пользователь не найден"});
    logAction(db, req.userId, "admin_password_removed", `Пароль отключён у пользователя #${id}`);
    res.json({ok:true});
  });

  return router;
};
