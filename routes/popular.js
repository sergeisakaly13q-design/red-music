const express = require("express");
const { requireAuth } = require("../middleware/auth");

module.exports = function createPopularRouter(db) {
  const router = express.Router();

  router.post("/play", requireAuth, (req, res) => {
    res.set("Cache-Control", "no-store");
    const { trackKey, title, artist } = req.body || {};
    if (!trackKey || !title) return res.status(400).json({ error: "Не указан трек" });
    const key = String(trackKey).slice(0, 180);
    const safeTitle = String(title).slice(0, 120);
    const safeArtist = String(artist || "").slice(0, 120);
    db.prepare(`
      INSERT INTO track_play_counts (track_key, title, artist, play_count, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'))
      ON CONFLICT(track_key) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        play_count = track_play_counts.play_count + 1,
        updated_at = datetime('now')
    `).run(key, safeTitle, safeArtist);
    res.json({ ok: true });
  });

  router.get("/", requireAuth, (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const popular = db.prepare(`
      SELECT track_key AS trackKey, title, artist, play_count AS playCount
      FROM track_play_counts
      ORDER BY play_count DESC, updated_at DESC
      LIMIT ?
    `).all(limit);
    res.json({ popular });
  });

  return router;
};
