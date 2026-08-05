const express = require("express");
const bcrypt = require("bcryptjs");
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require("../middleware/auth");
const { logAction } = require("../db/audit");

module.exports = function createAuthRouter(db) {
  const router = express.Router();

  function getUserRoles(userId) {
    return db
      .prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`)
      .all(userId)
      .map((r) => r.name);
  }

  function publicUser(row) {
    return {
      id: row.id,
      username: row.username,
      name: row.display_name,
      bio: row.bio,
      avatarUrl: row.avatar_url,
      avatarColor: row.avatar_color,
      roles: getUserRoles(row.id),
      vipUntil: row.vip_until,
      banned: !!row.banned,
      createdAt: row.created_at,
    };
  }

  router.post("/register", async (req, res) => {
    try {
      const { username, password, name } = req.body || {};
      if (!username || !password || !name) {
        return res.status(400).json({ error: "Заполните логин, пароль и имя" });
      }
      if (String(name).length > 10) {
        return res.status(400).json({ error: "Имя — максимум 10 символов" });
      }
      const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
      if (existing) return res.status(409).json({ error: "Такой логин уже занят" });

      const passwordHash = await bcrypt.hash(password, 10);
      const info = db
        .prepare(`INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`)
        .run(username, passwordHash, name);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);

      const userRole = db.prepare("SELECT id FROM roles WHERE name = 'USER'").get();
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(user.id, userRole.id);

      const token = signToken(user);
      setAuthCookie(res, token);
      logAction(db, user.id, "register", `Регистрация пользователя ${username}`);
      res.json({ user: publicUser(user) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Ошибка сервера при регистрации" });
    }
  });

  router.post("/login", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: "Введите логин и пароль" });

      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      if (!user) {
        logAction(db, null, "login_failed", `Неизвестный логин: ${username}`);
        return res.status(401).json({ error: "Неверный логин или пароль" });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        logAction(db, user.id, "login_failed", "Неверный пароль");
        return res.status(401).json({ error: "Неверный логин или пароль" });
      }
      if (user.banned) {
        logAction(db, user.id, "login_blocked", "Попытка входа забаненного пользователя");
        return res.status(403).json({ error: "Аккаунт заблокирован" });
      }
      const token = signToken(user);
      setAuthCookie(res, token);
      logAction(db, user.id, "login", "Вход в аккаунт");
      res.json({ user: publicUser(user) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Ошибка сервера при входе" });
    }
  });

  router.post("/logout", requireAuth, (req, res) => {
    logAction(db, req.userId, "logout", "Выход из аккаунта");
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  router.get("/me", requireAuth, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    res.json({ user: publicUser(user) });
  });

  router.put("/me", requireAuth, (req, res) => {
    const { name, bio, avatarColor } = req.body || {};
    if (name !== undefined && String(name).length > 10) {
      return res.status(400).json({ error: "Имя — максимум 10 символов" });
    }
    if (bio !== undefined && String(bio).length > 60) {
      return res.status(400).json({ error: "Описание — максимум 60 символов" });
    }
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    db.prepare(`UPDATE users SET display_name = ?, bio = ?, avatar_color = ? WHERE id = ?`).run(
      name !== undefined ? name : current.display_name,
      bio !== undefined ? bio : current.bio,
      avatarColor !== undefined ? avatarColor : current.avatar_color,
      req.userId
    );
    logAction(db, req.userId, "profile_update", "Обновление профиля");
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    res.json({ user: publicUser(updated) });
  });

  // Активация промокода VIP
  router.post("/promo", requireAuth, (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "Введите промокод" });
    const promo = db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(code);
    if (!promo) return res.status(404).json({ error: "Промокод не найден" });
    if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
      return res.status(400).json({ error: "Промокод больше не действует" });
    }
    const already = db
      .prepare("SELECT 1 FROM promo_redemptions WHERE code = ? AND user_id = ?")
      .get(code, req.userId);
    if (already) return res.status(400).json({ error: "Вы уже активировали этот промокод" });

    const tx = db.transaction(() => {
      db.prepare("INSERT INTO promo_redemptions (code, user_id) VALUES (?, ?)").run(code, req.userId);
      db.prepare("UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?").run(code);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
      const base = user.vip_until && new Date(user.vip_until) > new Date() ? new Date(user.vip_until) : new Date();
      base.setDate(base.getDate() + promo.vip_days);
      db.prepare("UPDATE users SET vip_until = ? WHERE id = ?").run(base.toISOString(), req.userId);
      const vipRole = db.prepare("SELECT id FROM roles WHERE name = 'VIP'").get();
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(req.userId, vipRole.id);
    });
    tx();

    logAction(db, req.userId, "promo_activated", `Промокод ${code} (+${promo.vip_days} дн. VIP)`);
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    res.json({ user: publicUser(updated) });
  });

  return router;
};
