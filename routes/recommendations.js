const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createAntiSpam } = require("../middleware/antiSpam");

module.exports = function createRecommendationsRouter(db) {
  const router = express.Router();
  const antiSpam = createAntiSpam({
    windowMs: 60 * 1000,
    maxActions: 60,
    cooldownMs: 60 * 1000,
    keyPrefix: "recommendations",
  });

  router.get("/signals", requireAuth, (req, res) => {
    const userId = req.userId;
    const history = db.prepare(`
      SELECT track_key AS trackKey, title, artist, played_at AS playedAt,
             COUNT(*) OVER (PARTITION BY track_key) AS plays
      FROM listening_events
      WHERE user_id = ? AND completed = 1
      ORDER BY datetime(played_at) DESC, id DESC
      LIMIT 100
    `).all(userId);

    const follows = db.prepare(`
      SELECT artist_name AS artist, created_at AS createdAt
      FROM artist_follows WHERE user_id = ?
      ORDER BY datetime(created_at) DESC
    `).all(userId);

    const interactions = db.prepare(`
      SELECT track_key AS trackKey, action, updated_at AS updatedAt
      FROM recommendation_interactions
      WHERE user_id = ?
      ORDER BY datetime(updated_at) DESC
      LIMIT 300
    `).all(userId);

    res.json({ ok: true, history, follows, interactions });
  });

  router.post("/interaction", requireAuth, antiSpam, (req, res) => {
    const trackKey = String(req.body?.trackKey || "").trim().slice(0, 180);
    const title = String(req.body?.title || "").trim().slice(0, 160);
    const artist = String(req.body?.artist || "").trim().slice(0, 160);
    const action = String(req.body?.action || "").toLowerCase();
    if (!trackKey || !["like", "skip"].includes(action)) {
      return res.status(400).json({ error: "Некорректное действие" });
    }

    db.prepare(`
      INSERT INTO recommendation_interactions
        (user_id, track_key, title, artist, action, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, track_key) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        action = excluded.action,
        updated_at = datetime('now')
    `).run(req.userId, trackKey, title, artist, action);

    res.json({ ok: true, trackKey, action });
  });

  router.delete("/interaction", requireAuth, antiSpam, (req, res) => {
    const trackKey = String(req.body?.trackKey || "").trim().slice(0, 180);
    if (!trackKey) return res.status(400).json({ error: "Не указан трек" });
    db.prepare("DELETE FROM recommendation_interactions WHERE user_id = ? AND track_key = ?")
      .run(req.userId, trackKey);
    res.json({ ok: true });
  });

  return router;
};
