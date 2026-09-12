const express = require("express");
const { requireAuth } = require("../middleware/auth");

module.exports = function createVipRouter(db) {
  const router = express.Router();
  const VIP_ROLES = new Set(["VIP", "RUBY", "CO-CREATOR", "OWNER"]);
  const THEMES = new Set(["default", "red", "pink", "blue", "purple", "green", "black", "yellow"]);
  const SHAPES = new Set(["circle", "square", "flower", "clover"]);
  const getRoles = (id) => db.prepare("SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?").all(id).map(r => String(r.name).toUpperCase());
  const isVip = (id) => getRoles(id).some(r => VIP_ROLES.has(r));

  router.get("/settings", requireAuth, (req, res) => {
    const u = db.prepare("SELECT vip_theme, avatar_shape FROM users WHERE id=?").get(req.userId);
    if (!u) return res.status(404).json({ error: "Пользователь не найден" });
    res.json({ vip: isVip(req.userId), theme: u.vip_theme || "default", avatarShape: u.avatar_shape || "circle" });
  });

  router.post("/settings", requireAuth, (req, res) => {
    if (!isVip(req.userId)) return res.status(403).json({ error: "Настройки доступны только VIP и выше" });
    const theme = String(req.body?.theme || "default");
    const avatarShape = String(req.body?.avatarShape || "circle");
    if (!THEMES.has(theme)) return res.status(400).json({ error: "Недопустимая тема" });
    if (!SHAPES.has(avatarShape)) return res.status(400).json({ error: "Недопустимая форма аватарки" });
    db.prepare("UPDATE users SET vip_theme=?, avatar_shape=? WHERE id=?").run(theme, avatarShape, req.userId);
    res.json({ ok: true, theme, avatarShape });
  });

  return router;
};
