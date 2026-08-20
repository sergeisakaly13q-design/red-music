const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { sendVerificationEmail } = require("../email");
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require("../middleware/auth");
const { logAction } = require("../db/audit");
const { createRateLimiter } = require("../middleware/rateLimit");
const {
  protectAuthAttempt,
  recordFailure,
  clearFailures,
} = require("../middleware/bruteForce");

module.exports = function createAuthRouter(db) {
  const router = express.Router();
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 30;
  const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
  const EMAIL_CODE_MAX_ATTEMPTS = 5;
  const EMAIL_REGEX = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/i;

  function cleanEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function hashVerificationCode(code) {
    return crypto.createHash("sha256").update(String(code)).digest("hex");
  }

  const authEndpointLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    keyPrefix: "auth-endpoint",
    message: "Слишком много запросов к авторизации. Повторите позже.",
    includeAccount: true,
  });
  const registerLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyPrefix: "register",
    message: "Слишком много регистраций с этого адреса. Попробуйте позже.",
    includeAccount: false,
  });
  const loginLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 12,
    keyPrefix: "login",
    message: "Слишком много попыток входа. Попробуйте позже.",
    includeAccount: true,
  });
  const syncLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "auth-sync",
    message: "Слишком много запросов синхронизации. Попробуйте позже.",
    includeAccount: true,
  });
  const promoLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 10,
    keyPrefix: "promo",
    message: "Слишком много попыток активации промокода. Попробуйте позже.",
    includeAccount: true,
  });


function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, maxLength);
}

  function cleanUsername(value) {
    return String(value || "").trim().toLowerCase();
  }

  function validatePassword(password) {
    const value = String(password ?? "");
    if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
      return `Пароль должен содержать от ${PASSWORD_MIN} до ${PASSWORD_MAX} символов`;
    }
    return null;
  }

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
      email: row.email || "",
      emailVerified: !!row.email_verified,
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

  router.post("/send-verification", registerLimit, async (req, res) => {
    try {
      const email = cleanEmail(req.body?.email);
      if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Введите корректную почту." });
      }

      const existingEmail = db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email);
      if (existingEmail) {
        return res.status(409).json({ error: "Эта почта уже привязана к аккаунту." });
      }

      const recent = db.prepare(`
        SELECT created_at FROM email_verification_codes
        WHERE email = ? AND used_at IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(email);
      if (recent && (Date.now() - new Date(recent.created_at).getTime()) < 60 * 1000) {
        return res.status(429).json({ error: "Новый код можно запросить через минуту." });
      }

      db.prepare(`
        DELETE FROM email_verification_codes
        WHERE email = ? OR expires_at < ?
      `).run(email, new Date().toISOString());

      const code = String(crypto.randomInt(100000, 1000000));
      const codeHash = hashVerificationCode(code);
      const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();

      db.prepare(`
        INSERT INTO email_verification_codes (email, code_hash, expires_at)
        VALUES (?, ?, ?)
      `).run(email, codeHash, expiresAt);

      await sendVerificationEmail({
        to: email,
        code,
        expiresMinutes: 10,
      });

      res.json({ ok: true, message: "Код подтверждения отправлен на почту." });
    } catch (e) {
      console.error("[email] send verification failed:", e);
      res.status(500).json({ error: "Не удалось отправить код. Проверьте настройки почтового сервера." });
    }
  });

  router.post("/verify-email", registerLimit, (req, res) => {
    try {
      const email = cleanEmail(req.body?.email);
      const code = String(req.body?.code || "").trim();
      if (!EMAIL_REGEX.test(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: "Введите почту и 6-значный код." });
      }

      const row = db.prepare(`
        SELECT * FROM email_verification_codes
        WHERE email = ? AND used_at IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(email);

      if (!row) return res.status(400).json({ error: "Код не найден. Отправьте новый код." });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: "Код истёк. Отправьте новый код." });
      }
      if (Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
        return res.status(429).json({ error: "Слишком много неверных попыток. Отправьте новый код." });
      }

      if (hashVerificationCode(code) !== row.code_hash) {
        db.prepare("UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
        return res.status(400).json({ error: "Неверный код подтверждения." });
      }

      db.prepare("UPDATE email_verification_codes SET used_at = datetime('now') WHERE id = ?").run(row.id);
      res.json({ ok: true, verified: true, email });
    } catch (e) {
      console.error("[email] verify failed:", e);
      res.status(500).json({ error: "Ошибка проверки кода." });
    }
  });

  router.post("/register", registerLimit, async (req, res) => {
    try {
      const { email: rawEmail, codeVerified, username, password, passwordConfirm, name } = req.body || {};
      const email = cleanEmail(rawEmail);
      const normalizedUsername = cleanUsername(username);

      if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Введите корректную почту." });
      }
      if (codeVerified !== true) {
        return res.status(400).json({ error: "Сначала подтвердите почту через код." });
      }
      const verified = db.prepare(`
        SELECT id FROM email_verification_codes
        WHERE email = ? AND used_at IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(email);
      if (!verified) return res.status(400).json({ error: "Почта не подтверждена." });

      const passwordError = validatePassword(password);
      if (!username || !password || !passwordConfirm || !name) {
        return res.status(400).json({ error: "Заполните все поля регистрации." });
      }
      if (password !== passwordConfirm) {
        return res.status(400).json({ error: "Пароли не совпадают." });
      }
      if (passwordError) return res.status(400).json({ error: passwordError });
      if (!/^[a-z0-9_]{3,10}$/.test(normalizedUsername)) {
        return res.status(400).json({ error: "Логин: 3–10 символов, только латинские буквы, цифры и _." });
      }
      if (String(name).length > 10) {
        return res.status(400).json({ error: "Имя — максимум 10 символов." });
      }

      const existingEmail = db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email);
      if (existingEmail) return res.status(409).json({ error: "Эта почта уже привязана к аккаунту." });

      const existing = db.prepare("SELECT * FROM users WHERE username = ?").get(normalizedUsername);

      // Ник Master принадлежит OWNER ID 1. Никогда не создаём второй Master
      // и никогда не снимаем с него OWNER. Если он уже существует, регистрацию
      // с этим ником блокируем, чтобы никто не мог захватить OWNER через форму.
      if (existing) {
        if (Number(existing.id) === 1 && normalizedUsername === "master") {
          return res.status(409).json({ error: "Аккаунт Master уже существует. OWNER сохранён. Используйте вход в существующий аккаунт." });
        }
        return res.status(409).json({ error: "Такой логин уже занят." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const info = db.prepare(`
        INSERT INTO users (username, email, email_verified, password_hash, display_name)
        VALUES (?, ?, 1, ?, ?)
      `).run(normalizedUsername, email, passwordHash, cleanText(name, 10));
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);

      const userRole = db.prepare("SELECT id FROM roles WHERE name = 'USER'").get();
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(user.id, userRole.id);

      const token = signToken(user);
      setAuthCookie(res, token);
      logAction(db, user.id, "register", `Регистрация пользователя ${normalizedUsername} с подтверждённой почтой`);
      res.json({ user: publicUser(user) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Ошибка сервера при регистрации" });
    }
  });

  // Синхронизация локального аккаунта с общей БД Red Music.
  // Не создаёт сессию и используется только для того, чтобы новые аккаунты
  // были видны администратору независимо от устройства/браузера.
  router.post("/sync", syncLimit, async (req, res) => {
    try {
      const { username, password, name } = req.body || {};
      if (!username || !password || !name) {
        return res.status(400).json({ error: "Заполните логин, пароль и имя" });
      }
      const cleanUsername = String(username || "").trim().toLowerCase();
      const cleanName = cleanText(name, 10);
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });
      if (!/^[a-z0-9_]{3,10}$/.test(cleanUsername)) {
        return res.status(400).json({ error: "Некорректный логин" });
      }
      if (cleanName.length > 10) {
        return res.status(400).json({ error: "Имя — максимум 10 символов" });
      }
      const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(cleanUsername);
      if (existing) return res.json({ ok: true, id: existing.id, existing: true });

      const passwordHash = await bcrypt.hash(String(password), 12);
      const info = db.prepare(
        `INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`
      ).run(cleanUsername, passwordHash, cleanName);
      const userRole = db.prepare("SELECT id FROM roles WHERE name = 'USER'").get();
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(info.lastInsertRowid, userRole.id);
      logAction(db, info.lastInsertRowid, "register_sync", `Синхронизация аккаунта ${cleanUsername}`);
      res.json({ ok: true, id: Number(info.lastInsertRowid), existing: false });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Ошибка синхронизации аккаунта" });
    }
  });

  // Синхронизация изменений профиля локального клиента с серверной БД.
  router.post("/sync-profile", syncLimit, async (req, res) => {
    try {
      const { username, password, name, bio, avatar, avatarColor, vipUntil } = req.body || {};
      const cleanUsername = String(username || "").trim().toLowerCase();
      if (!cleanUsername || password === undefined || password === null) return res.status(400).json({ error: "Не хватает данных для синхронизации" });
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });
      const user = db.prepare("SELECT * FROM users WHERE username = ?").get(cleanUsername);
      if (!user) return res.status(404).json({ error: "Пользователь не найден в базе" });
      if (user.password_disabled || !user.password_hash) return res.status(403).json({ error: "Пароль аккаунта отключён" });
      const ok = await bcrypt.compare(String(password), user.password_hash);
      if (!ok) return res.status(401).json({ error: "Не удалось подтвердить владельца аккаунта" });
      if (user.banned) return res.status(403).json({ error: "Аккаунт заблокирован" });
      const roleNames = getUserRoles(user.id).map((r) => String(r).toUpperCase());
      const canUseAnimatedAvatar =
        Number(user.id) === 1 ||
        roleNames.includes("VIP") ||
        roleNames.includes("RUBY") ||
        roleNames.includes("CO-CREATOR") ||
        roleNames.includes("OWNER");
      const requestedAvatar = avatar !== undefined ? String(avatar || "") : user.avatar_url;
      if (/^(?:data:image\/gif|https?:\/\/[^\s]+\.gif(?:\?|$))/i.test(requestedAvatar) && !canUseAnimatedAvatar) {
        return res.status(403).json({ error: "Анимированные аватарки доступны только VIP и выше" });
      }
      const nextName = name !== undefined ? String(name).trim() : user.display_name;
      const nextBio = bio !== undefined ? String(bio) : user.bio;
      const nextAvatar = avatar !== undefined ? String(avatar || "") : user.avatar_url;
      const nextAvatarColor = avatarColor !== undefined ? String(avatarColor || "") : user.avatar_color;
      if (nextName.length < 2 || nextName.length > 32) return res.status(400).json({ error: "Некорректное имя профиля" });
      if (nextBio.length > 5000) return res.status(400).json({ error: "Описание профиля слишком длинное" });
      if (nextAvatar.length > 4 * 1024 * 1024) return res.status(400).json({ error: "Аватар слишком большой" });
      db.prepare(`UPDATE users SET display_name = ?, bio = ?, avatar_url = ?, avatar_color = ?, vip_until = ? WHERE id = ?`).run(nextName, nextBio, nextAvatar, nextAvatarColor, vipUntil !== undefined ? (vipUntil || null) : user.vip_until, user.id);
      logAction(db, user.id, "profile_sync", "Синхронизация профиля из клиента");
      const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
      res.json({ ok: true, user: publicUser(updated) });
    } catch (e) { console.error(e); res.status(500).json({ error: "Ошибка синхронизации профиля" }); }
  });

  // Восстановление аккаунта после потери локальной БД при деплое.
  // Клиент может безопасно передать сохранённые на устройстве учётные данные:
  // если аккаунта нет на сервере — он будет создан; если есть — пароль проверяется.
  router.post("/migrate-login", authEndpointLimit, loginLimit, async (req, res) => {
    try {
      const { username, password, name } = req.body || {};
      const normalizedUsername = cleanUsername(username);
      if (!(await protectAuthAttempt(req, res, normalizedUsername))) return;
      if (!normalizedUsername || !password) {
        return res.status(400).json({ error: "Введите логин и пароль" });
      }
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });
      if (!/^[a-z0-9_]{3,10}$/.test(normalizedUsername)) {
        return res.status(400).json({ error: "Некорректный логин" });
      }

      let user = db.prepare("SELECT * FROM users WHERE username = ?").get(normalizedUsername);
      if (!user) {
        const cleanName = String(name || normalizedUsername).trim().slice(0, 10);
        if (cleanName.length < 2) return res.status(400).json({ error: "Некорректное имя профиля" });
        const passwordHash = await bcrypt.hash(String(password), 12);
        const info = db.prepare(
          `INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`
        ).run(normalizedUsername, passwordHash, cleanName);
        const userRole = db.prepare("SELECT id FROM roles WHERE name = 'USER'").get();
        if (userRole) db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(info.lastInsertRowid, userRole.id);
        user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
        logAction(db, user.id, "account_migrated", `Восстановлен аккаунт ${normalizedUsername} после обновления`);
      } else {
        if (user.password_disabled || !user.password_hash) {
          return res.status(403).json({ error: "Пароль аккаунта отключён. Требуется восстановление профиля." });
        }
        const ok = await bcrypt.compare(String(password), user.password_hash);
        if (!ok) {
          recordFailure(req, normalizedUsername);
          return res.status(401).json({ error: "Неверный логин или пароль" });
        }
        clearFailures(req, normalizedUsername);
        if (typeof bcrypt.getRounds === "function" && bcrypt.getRounds(user.password_hash) < 12) {
          const upgradedHash = await bcrypt.hash(String(password), 12);
          db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(upgradedHash, user.id);
          user.password_hash = upgradedHash;
        }
      }

      if (user.banned) return res.status(403).json({ error: "Аккаунт заблокирован" });
      const token = signToken(user);
      setAuthCookie(res, token);
      res.json({ user: publicUser(user), migrated: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Ошибка восстановления аккаунта" });
    }
  });

  router.post("/login", authEndpointLimit, loginLimit, async (req, res) => {
    try {
      const { email, username, password } = req.body || {};
      const identifier = String(email || username || "").trim().toLowerCase();
      if (!(await protectAuthAttempt(req, res, identifier))) return;
      if (!identifier || !password) return res.status(400).json({ error: "Введите почту и пароль." });
      const passwordError = validatePassword(password);
      if (passwordError) return res.status(400).json({ error: passwordError });

      // Новые аккаунты входят по почте. Для совместимости старый Master
      // продолжает принимать логин, пока его почта не будет привязана.
      const user = db.prepare(`
        SELECT * FROM users
        WHERE lower(email) = ? OR lower(username) = ?
        ORDER BY CASE WHEN lower(email) = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(identifier, identifier, identifier);

      if (!user) {
        recordFailure(req, identifier);
        logAction(db, null, "login_failed", `Неизвестная почта/логин: ${identifier}`);
        return res.status(401).json({ error: "Неверная почта или пароль." });
      }
      if (user.email && !user.email_verified) {
        return res.status(403).json({ error: "Почта аккаунта не подтверждена." });
      }
      if (user.password_disabled || !user.password_hash) {
        return res.status(403).json({ error: "Пароль аккаунта отключён. Требуется восстановление профиля." });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        recordFailure(req, identifier);
        logAction(db, user.id, "login_failed", "Неверный пароль");
        return res.status(401).json({ error: "Неверная почта или пароль." });
      }
      clearFailures(req, identifier);
      if (typeof bcrypt.getRounds === "function" && bcrypt.getRounds(user.password_hash) < 12) {
        const upgradedHash = await bcrypt.hash(String(password), 12);
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(upgradedHash, user.id);
        user.password_hash = upgradedHash;
      }
      if (user.banned) {
        logAction(db, user.id, "login_blocked", "Попытка входа забаненного пользователя");
        return res.status(403).json({ error: "Аккаунт заблокирован." });
      }
      const token = signToken(user);
      setAuthCookie(res, token);
      logAction(db, user.id, "login", "Вход в аккаунт по почте");
      res.json({ user: publicUser(user) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Ошибка сервера при входе" });
    }
  });

  router.post("/logout", requireAuth, (req, res) => {
    db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(req.userId);
    logAction(db, req.userId, "logout", "Выход из аккаунта, сессия отозвана");
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
  router.post("/promo", requireAuth, promoLimit, (req, res) => {
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

  router.get("/status/:username", (req,res)=>{
    const username=String(req.params.username||"").trim().toLowerCase();
    const user=db.prepare("SELECT id, username, banned, password_hash, password_disabled FROM users WHERE username=?").get(username);
    if(!user)return res.status(404).json({error:"Пользователь не найден"});
    const roles = db.prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).all(user.id).map(r => r.name);
    res.json({id:user.id,banned:!!user.banned,passwordRemoved:!!user.password_disabled,roles,vipUntil:user.vip_until||null});
  });

  return router;
};
