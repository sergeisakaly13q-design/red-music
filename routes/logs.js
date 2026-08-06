const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");

module.exports = function createLogsRouter(db) {
  const router = express.Router();
  const canViewLogs = requireRole(db, "OWNER", "CO-CREATOR");

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

  router.get("/users", (req, res) => {
    // Текущий интерфейс Red Music использует локальную авторизацию, поэтому
    // для админского списка передаётся ID текущего администратора.
    const adminId = Number(req.get("x-redmusic-admin-id"));
    if (![1, 2].includes(adminId)) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }

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

  function requireHeaderAdmin(req, res) {
    const adminId = Number(req.get("x-redmusic-admin-id"));
    if (![1, 2].includes(adminId)) { res.status(403).json({ error: "Недостаточно прав" }); return false; }
    return true;
  }

  router.get("/users/:id/roles", (req, res) => {
    if (!requireHeaderAdmin(req, res)) return;
    const id = Number(req.params.id);
    const roles = db.prepare("SELECT id, name, is_custom FROM roles ORDER BY id").all();
    const assigned = db.prepare("SELECT role_id FROM user_roles WHERE user_id = ?").all(id).map(r => r.role_id);
    res.json({ roles, assigned });
  });

  router.post("/users/:id/roles/toggle", (req, res) => {
    if (!requireHeaderAdmin(req, res)) return;
    const id = Number(req.params.id);
    const roleName = String(req.body?.roleName || "").trim().toUpperCase();
    if (!roleName) return res.status(400).json({ error: "Роль не указана" });
    const role = db.prepare("SELECT id, name FROM roles WHERE name = ?").get(roleName);
    if (!role) return res.status(404).json({ error: "Роль не найдена" });
    if (id === 2 && roleName === "OWNER") return res.status(400).json({ error: "Роль OWNER у ID 2 закреплена" });
    const exists = db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?").get(id, role.id);
    if (exists) db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?").run(id, role.id);
    else db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(id, role.id);
    const assigned = db.prepare("SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? ORDER BY r.id").all(id).map(r=>r.name);
    res.json({ ok:true, action: exists ? "removed" : "added", roles: assigned });
  });

  router.post("/users/:id/block", (req, res) => {
    if (!requireHeaderAdmin(req, res)) return;
    const id = Number(req.params.id);
    if ([1,2].includes(id)) return res.status(400).json({ error: "Нельзя заблокировать защищённый аккаунт" });
    db.prepare("UPDATE users SET banned = CASE WHEN banned=1 THEN 0 ELSE 1 END WHERE id=?").run(id);
    const row=db.prepare("SELECT banned FROM users WHERE id=?").get(id);
    logAction(db, adminId, row?.banned ? "admin_user_block" : "admin_user_unblock", `Пользователь #${id}`);
    res.json({ok:true,banned:!!row?.banned});
  });

  router.delete("/users/:id", (req, res) => {
    if (!requireHeaderAdmin(req, res)) return;
    const id=Number(req.params.id);
    if ([1,2].includes(id)) return res.status(400).json({error:"Нельзя удалить защищённый аккаунт"});
    const info=db.prepare("DELETE FROM users WHERE id=?").run(id);
    if (!info.changes) return res.status(404).json({error:"Пользователь не найден"});
    logAction(db, adminId, "admin_user_delete", `Удалён пользователь #${id}`);
    res.json({ok:true});
  });

  router.post("/users/:id/delete-password", (req,res)=>{
    if (!requireHeaderAdmin(req,res)) return;
    const id=Number(req.params.id);
    if ([1,2].includes(id)) return res.status(400).json({error:"Нельзя удалить пароль защищённого аккаунта"});
    const info=db.prepare("UPDATE users SET password_disabled=1, password_hash='' WHERE id=?").run(id);
    if (!info.changes) return res.status(404).json({error:"Пользователь не найден"});
    logAction(db, adminId, "admin_password_removed", `Пароль отключён у пользователя #${id}`);
    res.json({ok:true});
  });

  return router;
};
