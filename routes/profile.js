const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createAntiSpam } = require("../middleware/antiSpam");

const LEVELS = [
  { level: 1, xp: 0, title: "Новичок" },
  { level: 2, xp: 60, title: "Слушатель" },
  { level: 3, xp: 180, title: "Меломан" },
  { level: 4, xp: 400, title: "Знаток" },
  { level: 5, xp: 800, title: "Фанат музыки" },
  { level: 6, xp: 1500, title: "Музыкальный эксперт" },
  { level: 7, xp: 3000, title: "Профи" },
  { level: 8, xp: 6000, title: "Гуру" },
  { level: 9, xp: 12000, title: "Легенда" },
  { level: 10, xp: 25000, title: "Икона Red Music" },
];

function getProfileData(db, userId) {
  const user = db.prepare(`SELECT id, username, display_name, bio, avatar_url, avatar_color, vip_until, created_at, profile_public FROM users WHERE id = ?`).get(userId);
  if (!user) return null;

  const totals = db.prepare(`
    SELECT COUNT(*) AS tracks, COALESCE(SUM(duration_seconds),0) AS seconds,
           COUNT(DISTINCT track_key) AS unique_tracks,
           COUNT(DISTINCT NULLIF(TRIM(artist),'')) AS unique_artists
    FROM listening_events WHERE user_id = ? AND completed = 1
  `).get(userId);

  const favorites = db.prepare(`SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?`).get(userId);
  const localFavs = db.prepare(`SELECT COUNT(*) AS count FROM recommendation_interactions WHERE user_id = ? AND action = 'like'`).get(userId);
  const tracks = Number(totals?.tracks || 0);
  const minutes = Math.floor(Number(totals?.seconds || 0) / 60);
  const likes = Math.max(Number(favorites?.count || 0), Number(localFavs?.count || 0));
  const xp = Math.min(25000, minutes + tracks * 2 + likes * 3);
  let level = LEVELS[0];
  for (const item of LEVELS) if (xp >= item.xp) level = item;
  const next = LEVELS.find(x => x.xp > xp) || null;

  const days = db.prepare(`
    SELECT DISTINCT substr(played_at,1,10) AS day
    FROM listening_events WHERE user_id = ? AND completed = 1
    ORDER BY day DESC LIMIT 366
  `).all(userId).map(x => x.day);
  const daySet = new Set(days);
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0,0,0,0);
  const today = cursor.toISOString().slice(0,10);
  if (!daySet.has(today)) cursor.setDate(cursor.getDate() - 1);
  while (daySet.has(cursor.toISOString().slice(0,10)) && streak < 366) { streak++; cursor.setDate(cursor.getDate() - 1); }

  const milestones = [
    { id: "first-track", title: "Первый трек", desc: "Подтверждённое прослушивание", target: 1, value: tracks },
    { id: "hour", title: "1 час", desc: "1 час прослушивания", target: 60, value: minutes },
    { id: "ten-hours", title: "10 часов", desc: "10 часов прослушивания", target: 600, value: minutes },
    { id: "fifty-hours", title: "50 часов", desc: "50 часов прослушивания", target: 3000, value: minutes },
    { id: "hundred-hours", title: "100 часов", desc: "100 часов прослушивания", target: 6000, value: minutes },
    { id: "five-hundred-tracks", title: "500 треков", desc: "500 завершённых треков", target: 500, value: tracks },
    { id: "thousand-tracks", title: "1000 треков", desc: "1000 завершённых треков", target: 1000, value: tracks },
    { id: "seven-day-streak", title: "Неделя подряд", desc: "7 дней со слушаниями", target: 7, value: streak },
    { id: "thirty-day-streak", title: "Месяц подряд", desc: "30 дней со слушаниями", target: 30, value: streak },
  ].map(a => ({ ...a, unlocked: a.value >= a.target }));

  let earnedStars = 0;
  try {
    const linked = db.prepare(`SELECT telegram_id FROM telegram_users WHERE app_user_id = ? ORDER BY last_seen_at DESC LIMIT 1`).get(userId);
    if (linked) earnedStars = Number(db.prepare(`SELECT earned_stars FROM telegram_user_balance WHERE telegram_id = ?`).get(linked.telegram_id)?.earned_stars || 0);
  } catch (_) {}

  return {
    user: { id: user.id, username: user.username, displayName: user.display_name, bio: user.bio || "", avatarUrl: user.avatar_url || "", avatarColor: user.avatar_color || "", vipUntil: user.vip_until, createdAt: user.created_at, profilePublic: Boolean(user.profile_public) },
    stats: { tracks, minutes, uniqueTracks: Number(totals?.unique_tracks || 0), uniqueArtists: Number(totals?.unique_artists || 0), likes, streak, level: level.level, levelTitle: level.title, xp, nextLevelXp: next?.xp ?? null, earnedStars },
    milestones,
  };
}

module.exports = function createProfileRouter(db) {
  const router = express.Router();
  const antiSpam = createAntiSpam({ windowMs: 60 * 1000, maxActions: 20, cooldownMs: 60 * 1000, keyPrefix: "profile" });

  router.get("/me", requireAuth, (req, res) => {
    const data = getProfileData(db, req.userId);
    if (!data) return res.status(404).json({ error: "Профиль не найден" });
    res.json({ ok: true, ...data });
  });

  router.post("/visibility", requireAuth, antiSpam, (req, res) => {
    const enabled = Boolean(req.body?.public);
    db.prepare("UPDATE users SET profile_public = ? WHERE id = ?").run(enabled ? 1 : 0, req.userId);
    res.json({ ok: true, public: enabled });
  });

  router.get("/public/:username", (req, res) => {
    const username = String(req.params.username || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(username)) return res.status(400).json({ error: "Некорректный username" });
    const user = db.prepare("SELECT id FROM users WHERE lower(username) = ? AND profile_public = 1 AND banned = 0").get(username);
    if (!user) return res.status(404).json({ error: "Публичный профиль не найден" });
    const data = getProfileData(db, user.id);
    const top = db.prepare(`SELECT artist, COUNT(*) AS plays FROM listening_events WHERE user_id = ? AND completed = 1 AND TRIM(artist) <> '' GROUP BY artist ORDER BY plays DESC, artist COLLATE NOCASE LIMIT 5`).all(user.id);
    res.json({ ok: true, profile: data.user, stats: data.stats, milestones: data.milestones, topArtists: top });
  });

  return router;
};
