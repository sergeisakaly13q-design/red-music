const express = require("express");
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { createAntiSpam } = require("../middleware/antiSpam");
const { syncListeningAchievements } = require("../telegramBot");

const MAX_TRACK_SECONDS = 6 * 60 * 60;
const END_TOLERANCE_SECONDS = 6;
const PLAYBACK_TOLERANCE_SECONDS = 8;
const HEARTBEAT_MAX_GAP_SECONDS = 45;

module.exports = function createListeningRewardsRouter(db) {
  const router = express.Router();
  const antiSpam = createAntiSpam({
    windowMs: 60 * 1000,
    maxActions: 30,
    cooldownMs: 60 * 1000,
    keyPrefix: "listening-rewards",
  });

  function cleanDuration(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 5 || n > MAX_TRACK_SECONDS) return 0;
    return n;
  }

  function getStats(userId) {
    return db.prepare(`
      SELECT completed_seconds, updated_at
      FROM listening_reward_stats
      WHERE user_id = ?
    `).get(userId) || { completed_seconds: 0, updated_at: null };
  }

  router.get("/status", requireAuth, (req, res) => {
    const stats = getStats(req.userId);
    const totalSeconds = Math.max(0, Number(stats.completed_seconds) || 0);
    const completedHours = Math.min(6767, Math.floor(totalSeconds / 3600));
    const completedMinutes = Math.floor(totalSeconds / 60);

    res.json({
      ok: true,
      completedSeconds: totalSeconds,
      completedMinutes,
      completedHours,
      maxHours: 6767,
      starsPerHour: 10,
      nextAtMinutes: completedHours < 6767 ? (completedHours + 1) * 60 : null,
    });
  });

  router.post("/start", requireAuth, antiSpam, (req, res) => {
    const duration = cleanDuration(req.body?.duration);
    const type = String(req.body?.type || "");
    const key = String(req.body?.trackKey || "").slice(0, 300);
    const trackIdRaw = Number(req.body?.trackId);
    const trackId = Number.isInteger(trackIdRaw) && trackIdRaw > 0 ? trackIdRaw : null;

    // Achievements are for audio actually played in Red Music, not imported
    // external placeholders, demos or third-party pages.
    if (!["server", "local"].includes(type)) {
      return res.status(400).json({ error: "Этот тип трека не учитывается в достижениях." });
    }
    if (!duration) return res.status(400).json({ error: "Некорректная длительность трека." });

    try {
      db.prepare(`
        UPDATE listening_reward_sessions
        SET ended_at = datetime('now')
        WHERE user_id = ? AND completed = 0 AND ended_at IS NULL
      `).run(req.userId);

      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO listening_reward_sessions
          (id, user_id, track_id, client_track_key, duration_seconds,
           started_at, last_heartbeat_at, last_position, max_position,
           listened_seconds, suspicious, completed)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0, 0, 0, 0, 0)
      `).run(id, req.userId, trackId, key, duration);

      res.json({ ok: true, sessionId: id });
    } catch (error) {
      console.error("[listening-rewards] start:", error);
      res.status(500).json({ error: "Не удалось начать отслеживание прослушивания." });
    }
  });

  router.post("/heartbeat", requireAuth, antiSpam, (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    const position = Number(req.body?.position);
    const playing = Boolean(req.body?.playing);

    if (!sessionId || !Number.isFinite(position)) {
      return res.status(400).json({ error: "Некорректные данные прослушивания." });
    }

    const session = db.prepare(`
      SELECT * FROM listening_reward_sessions
      WHERE id = ? AND user_id = ? AND completed = 0
    `).get(sessionId, req.userId);

    if (!session) return res.status(404).json({ error: "Сессия прослушивания не найдена." });

    const now = Date.now();
    const last = new Date(String(session.last_heartbeat_at).replace(" ", "T") + "Z").getTime();
    let elapsed = (now - last) / 1000;
    if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;

    const safePosition = Math.max(0, Math.min(Number(session.duration_seconds), position));
    let suspicious = Number(session.suspicious) ? 1 : 0;
    let creditedElapsed = 0;

    if (playing && elapsed <= HEARTBEAT_MAX_GAP_SECONDS) {
      const forwardJump = safePosition - Number(session.last_position || 0);
      if (forwardJump > elapsed + PLAYBACK_TOLERANCE_SECONDS) {
        suspicious = 1;
      } else {
        // Count real wall-clock playback time, never the amount the client
        // claims to have jumped over.
        creditedElapsed = Math.min(elapsed, 20);
      }
    }

    const listened = Math.max(0, Number(session.listened_seconds || 0) + creditedElapsed);
    const maxPosition = Math.max(Number(session.max_position || 0), safePosition);

    db.prepare(`
      UPDATE listening_reward_sessions
      SET last_heartbeat_at = datetime('now'),
          last_position = ?,
          max_position = ?,
          listened_seconds = ?,
          suspicious = ?
      WHERE id = ? AND user_id = ? AND completed = 0
    `).run(safePosition, maxPosition, listened, suspicious, sessionId, req.userId);

    res.json({
      ok: true,
      suspicious: Boolean(suspicious),
      listenedSeconds: listened,
      maxPosition,
    });
  });

  router.post("/complete", requireAuth, antiSpam, async (req, res) => {
    const sessionId = String(req.body?.sessionId || "").trim();
    const position = Number(req.body?.position);

    if (!sessionId) return res.status(400).json({ error: "Не указана сессия." });

    const session = db.prepare(`
      SELECT * FROM listening_reward_sessions
      WHERE id = ? AND user_id = ? AND completed = 0
    `).get(sessionId, req.userId);

    if (!session) return res.status(404).json({ error: "Сессия прослушивания не найдена." });

    const duration = Number(session.duration_seconds);
    const safePosition = Number.isFinite(position)
      ? Math.max(0, Math.min(duration, position))
      : Number(session.last_position || 0);

    const maxPosition = Math.max(Number(session.max_position || 0), safePosition);
    const listened = Number(session.listened_seconds || 0);
    const suspicious = Number(session.suspicious) === 1;

    // The track must genuinely reach its end and have almost the whole track
    // covered. A small tolerance prevents false negatives from browser/audio
    // rounding at the final seconds.
    const reachedEnd = maxPosition >= Math.max(0, duration - END_TOLERANCE_SECONDS);
    const enoughPlayback = listened >= Math.max(0, duration - END_TOLERANCE_SECONDS);

    if (!reachedEnd || !enoughPlayback || suspicious) {
      db.prepare(`
        UPDATE listening_reward_sessions
        SET last_heartbeat_at = datetime('now'),
            last_position = ?,
            max_position = ?,
            ended_at = datetime('now')
        WHERE id = ? AND user_id = ? AND completed = 0
      `).run(safePosition, maxPosition, sessionId, req.userId);

      return res.json({
        ok: true,
        counted: false,
        reason: suspicious
          ? "Обнаружен скачок позиции. Трек не засчитан."
          : "Трек прослушан не полностью. Он не засчитан.",
      });
    }

    let totalSeconds = 0;
    let awarded = 0;
    try {
      const transaction = db.transaction(() => {
        const current = db.prepare(`
          SELECT completed_seconds FROM listening_reward_stats WHERE user_id = ?
        `).get(req.userId);

        totalSeconds = Math.max(0, Number(current?.completed_seconds || 0)) + duration;

        db.prepare(`
          INSERT INTO listening_reward_stats (user_id, completed_seconds, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            completed_seconds = excluded.completed_seconds,
            updated_at = datetime('now')
        `).run(req.userId, Math.floor(totalSeconds));

        db.prepare(`
          UPDATE listening_reward_sessions
          SET last_heartbeat_at = datetime('now'),
              last_position = ?,
              max_position = ?,
              listened_seconds = ?,
              completed = 1,
              ended_at = datetime('now')
          WHERE id = ? AND user_id = ? AND completed = 0
        `).run(safePosition, maxPosition, listened, sessionId, req.userId);
      });
      transaction();

      try {
        awarded = await syncListeningAchievements(db, req.userId);
      } catch (e) {
        console.error("[listening-rewards] achievement sync:", e.message);
      }
    } catch (error) {
      console.error("[listening-rewards] complete:", error);
      return res.status(500).json({ error: "Не удалось засчитать прослушивание." });
    }

    const completedMinutes = Math.floor(totalSeconds / 60);
    const completedHours = Math.min(6767, Math.floor(totalSeconds / 3600));

    res.json({
      ok: true,
      counted: true,
      completedSeconds: totalSeconds,
      completedMinutes,
      completedHours,
      awardedStars: awarded,
    });
  });

  return router;
};
