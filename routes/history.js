const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createAntiSpam } = require("../middleware/antiSpam");

module.exports = function createHistoryRouter(db) {
  const router = express.Router();
  const antiSpam = createAntiSpam({
    windowMs: 60 * 1000,
    maxActions: 40,
    cooldownMs: 60 * 1000,
    keyPrefix: "history",
  });

  const PERIODS = new Set(["today", "week", "month", "year", "all"]);

  function periodWhere(period) {
    switch (period) {
      case "today": return "datetime(e.played_at) >= datetime('now', 'start of day')";
      case "week": return "datetime(e.played_at) >= datetime('now', '-6 days', 'start of day')";
      case "month": return "datetime(e.played_at) >= datetime('now', 'start of month')";
      case "year": return "datetime(e.played_at) >= datetime('now', 'start of year')";
      default: return "1=1";
    }
  }

  // Legacy endpoint retained for compatibility with older clients.
  router.post("/", requireAuth, antiSpam, (req, res) => {
    const { trackId } = req.body || {};
    const id = Number(trackId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный trackId" });
    const track = db.prepare("SELECT id, title, artist FROM tracks WHERE id = ?").get(id);
    if (!track) return res.status(404).json({ error: "Трек не найден" });
    db.prepare(`
      INSERT INTO listening_events
        (user_id, track_id, track_key, title, artist, duration_seconds, listened_seconds, completed)
      VALUES (?, ?, ?, ?, ?, 0, 0, 1)
    `).run(req.userId, track.id, `track:${track.id}`, track.title, track.artist || "");
    res.json({ ok: true });
  });

  router.get("/", requireAuth, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const history = db.prepare(`
      SELECT e.id, e.played_at, e.track_id, e.track_key, e.title, e.artist,
             e.duration_seconds, e.listened_seconds, e.completed
      FROM listening_events e
      WHERE e.user_id = ?
      ORDER BY datetime(e.played_at) DESC, e.id DESC
      LIMIT ?
    `).all(req.userId, limit);
    res.json({ history });
  });

  router.get("/stats", requireAuth, (req, res) => {
    const period = PERIODS.has(String(req.query.period || "all")) ? String(req.query.period || "all") : "all";
    const where = periodWhere(period);
    const base = `FROM listening_events e WHERE e.user_id = ? AND e.completed = 1 AND ${where}`;

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS tracks,
        COALESCE(SUM(e.duration_seconds), 0) AS listened_seconds,
        COUNT(DISTINCT e.track_key) AS unique_tracks,
        COUNT(DISTINCT NULLIF(TRIM(e.artist), '')) AS unique_artists
      ${base}
    `).get(req.userId);

    const topArtists = db.prepare(`
      SELECT e.artist, COUNT(*) AS plays, COALESCE(SUM(e.duration_seconds),0) AS seconds
      ${base} AND TRIM(e.artist) <> ''
      GROUP BY e.artist
      ORDER BY plays DESC, seconds DESC, e.artist COLLATE NOCASE ASC
      LIMIT 10
    `).all(req.userId);

    const topTracks = db.prepare(`
      SELECT e.track_key, e.title, e.artist, COUNT(*) AS plays,
             COALESCE(SUM(e.duration_seconds),0) AS seconds
      ${base}
      GROUP BY e.track_key, e.title, e.artist
      ORDER BY plays DESC, seconds DESC, e.title COLLATE NOCASE ASC
      LIMIT 10
    `).all(req.userId);

    res.json({
      ok: true,
      period,
      stats: {
        tracks: Number(summary.tracks || 0),
        listenedSeconds: Number(summary.listened_seconds || 0),
        minutes: Math.floor(Number(summary.listened_seconds || 0) / 60),
        uniqueTracks: Number(summary.unique_tracks || 0),
        uniqueArtists: Number(summary.unique_artists || 0),
      },
      topArtists,
      topTracks,
    });
  });

  return router;
};
