const express = require("express");
const { requireAuth } = require("../middleware/auth");

module.exports = function createHistoryRouter(db) {
  const router = express.Router();

  router.post("/", requireAuth, (req, res) => {
    const { trackId } = req.body || {};
    if (!trackId) return res.status(400).json({ error: "Не указан trackId" });
    db.prepare("INSERT INTO listening_history (user_id, track_id) VALUES (?,?)").run(req.userId, trackId);
    res.json({ ok: true });
  });

  router.get("/", requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const history = db
      .prepare(
        `SELECT h.id, h.played_at, t.id AS track_id, t.title, t.artist
         FROM listening_history h JOIN tracks t ON t.id = h.track_id
         WHERE h.user_id = ? ORDER BY h.played_at DESC LIMIT ?`
      )
      .all(req.userId, limit);
    res.json({ history });
  });

  return router;
};
