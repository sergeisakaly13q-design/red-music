const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { logAction } = require("../db/audit");

function pairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

module.exports = function createFriendsRouter(db) {
  const router = express.Router();

  router.post("/requests", requireAuth, (req, res) => {
    const toUserId = Number(req.body.toUserId);
    if (!toUserId) return res.status(400).json({ error: "Не указан ID пользователя" });
    if (toUserId === req.userId) return res.status(400).json({ error: "Нельзя добавить самого себя" });

    const target = db.prepare("SELECT id FROM users WHERE id = ?").get(toUserId);
    if (!target) return res.status(404).json({ error: "Пользователь с таким ID не найден" });

    const [a, b] = pairKey(req.userId, toUserId);
    const already = db.prepare("SELECT 1 FROM friendships WHERE user_id_a=? AND user_id_b=?").get(a, b);
    if (already) return res.status(400).json({ error: "Вы уже друзья" });

    try {
      const info = db
        .prepare(`INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES (?,?,'pending')`)
        .run(req.userId, toUserId);
      const request = db.prepare("SELECT * FROM friend_requests WHERE id = ?").get(info.lastInsertRowid);
      logAction(db, req.userId, "friend_request_sent", `Заявка пользователю #${toUserId}`);
      res.json({ request });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) return res.status(400).json({ error: "Заявка уже отправлена" });
      throw e;
    }
  });

  router.get("/requests/incoming", requireAuth, (req, res) => {
    const requests = db
      .prepare(
        `SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.display_name
         FROM friend_requests fr JOIN users u ON u.id = fr.from_user_id
         WHERE fr.to_user_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
      )
      .all(req.userId);
    res.json({ requests });
  });

  router.get("/requests/outgoing", requireAuth, (req, res) => {
    const requests = db
      .prepare(
        `SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.display_name
         FROM friend_requests fr JOIN users u ON u.id = fr.to_user_id
         WHERE fr.from_user_id = ? AND fr.status = 'pending' ORDER BY fr.created_at DESC`
      )
      .all(req.userId);
    res.json({ requests });
  });

  router.post("/requests/:id/accept", requireAuth, (req, res) => {
    const request = db
      .prepare("SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'")
      .get(req.params.id, req.userId);
    if (!request) return res.status(404).json({ error: "Заявка не найдена" });

    const [a, b] = pairKey(request.from_user_id, request.to_user_id);
    const tx = db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO friendships (user_id_a, user_id_b) VALUES (?,?)").run(a, b);
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(request.id);
    });
    tx();
    logAction(db, req.userId, "friend_request_accepted", `Принята заявка от #${request.from_user_id}`);
    res.json({ ok: true });
  });

  router.post("/requests/:id/reject", requireAuth, (req, res) => {
    db.prepare(
      "UPDATE friend_requests SET status = 'rejected' WHERE id = ? AND to_user_id = ? AND status = 'pending'"
    ).run(req.params.id, req.userId);
    logAction(db, req.userId, "friend_request_rejected", `Отклонена заявка #${req.params.id}`);
    res.json({ ok: true });
  });

  router.post("/requests/:id/cancel", requireAuth, (req, res) => {
    db.prepare(
      "UPDATE friend_requests SET status = 'cancelled' WHERE id = ? AND from_user_id = ? AND status = 'pending'"
    ).run(req.params.id, req.userId);
    res.json({ ok: true });
  });

  router.get("/", requireAuth, (req, res) => {
    const friends = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_color
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_id_a = ? THEN f.user_id_b ELSE f.user_id_a END
         WHERE f.user_id_a = ? OR f.user_id_b = ?`
      )
      .all(req.userId, req.userId, req.userId);
    res.json({ friends });
  });

  router.delete("/:friendId", requireAuth, (req, res) => {
    const friendId = Number(req.params.friendId);
    const [a, b] = pairKey(req.userId, friendId);
    db.prepare("DELETE FROM friendships WHERE user_id_a=? AND user_id_b=?").run(a, b);
    logAction(db, req.userId, "friend_removed", `Удалён друг #${friendId}`);
    res.json({ ok: true });
  });

  return router;
};
