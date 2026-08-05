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

  router.get("/users", requireAuth, canViewLogs, (req, res) => {
    const users = db.prepare("SELECT * FROM users ORDER BY id").all();
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

  return router;
};
