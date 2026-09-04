const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimit");
const {
  PLANS,
  getBotUsername,
  createLinkToken,
} = require("../telegramBot");

module.exports = function createTelegramRouter(db) {
  const router = express.Router();
  const linkLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "telegram-link",
    message: "Слишком много попыток открыть Telegram. Повторите позже.",
    includeAccount: true,
  });

  router.post("/link", requireAuth, linkLimit, async (req, res) => {
    try {
      const planCode = String(req.body?.planCode || "");
      const plan = PLANS[planCode];
      if (!plan) return res.status(400).json({ error: "Неизвестный тариф" });

      const username = await getBotUsername();
      if (!username) {
        return res.status(503).json({
          error: "Telegram-бот пока не настроен на сервере. Добавьте TELEGRAM_BOT_TOKEN.",
        });
      }

      const token = createLinkToken();
      db.prepare(`
        INSERT INTO telegram_link_tokens
          (token, user_id, plan_code, created_at, expires_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now', '+30 minutes'))
      `).run(token, Number(req.userId), plan.code);

      const url = `https://t.me/${username}?start=${encodeURIComponent(token)}`;
      res.json({
        ok: true,
        url,
        plan: { code: plan.code, name: plan.name, stars: plan.stars, days: plan.days },
      });
    } catch (error) {
      console.error("[telegram] link:", error);
      res.status(500).json({ error: "Не удалось создать ссылку на Telegram-бота" });
    }
  });

  return router;
};
