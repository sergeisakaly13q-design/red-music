const jwt = require("jsonwebtoken");

const JWT_SECRET = String(process.env.JWT_SECRET || "").trim();
if (process.env.NODE_ENV === "production" && JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to a random secret of at least 32 characters in production.");
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || "red-music-development-secret-change-me";
const COOKIE_NAME = "rm_token";
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function signToken(user) {
  const sessionVersion = Number.isInteger(Number(user.session_version))
    ? Number(user.session_version)
    : 1;

  return jwt.sign(
    { id: Number(user.id), username: String(user.username || ""), sv: sessionVersion },
    EFFECTIVE_JWT_SECRET,
    {
      expiresIn: "30d",
      issuer: "red-music",
      audience: "red-music-client",
    }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TOKEN_MAX_AGE_MS,
    path: "/",
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

function getDb(req) {
  return req.app?.locals?.db || null;
}

// Requires authentication and verifies that the session is still current.
// The client never supplies or controls the role. The current account state
// comes from SQLite on every protected request.
function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\\s+/i.test(header)) return "";
  return header.replace(/^Bearer\\s+/i, "").trim();
}

function requireAuth(req, res, next) {
  // Browser clients use the HttpOnly cookie. Capacitor/Electron clients can
  // additionally authenticate with the JWT returned by login/register,
  // because cross-origin WebView cookies may not persist reliably.
  const token = (req.cookies && req.cookies[COOKIE_NAME]) || getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Не авторизован" });

  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET, {
      issuer: "red-music",
      audience: "red-music-client",
    });

    const userId = Number(payload.id);
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(401).json({ error: "Сессия недействительна, войдите снова" });
    }

    const db = getDb(req);
    if (!db) return res.status(500).json({ error: "Ошибка конфигурации авторизации" });

    const user = db
      .prepare("SELECT id, username, banned, password_hash, password_disabled, session_version FROM users WHERE id = ?")
      .get(userId);

    if (!user) return res.status(401).json({ error: "Аккаунт не найден" });
    if (user.banned) return res.status(403).json({ error: "Аккаунт заблокирован" });
    if (user.password_disabled || !user.password_hash) {
      return res.status(403).json({ error: "Пароль аккаунта отключён" });
    }

    const tokenVersion = Number(payload.sv);
    const currentVersion = Number(user.session_version || 1);
    if (!Number.isInteger(tokenVersion) || tokenVersion !== currentVersion) {
      return res.status(401).json({ error: "Сессия отозвана, войдите снова" });
    }

    req.userId = userId;
    req.username = String(user.username || "");
    req.sessionVersion = currentVersion;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Сессия недействительна, войдите снова" });
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();

  try {
    const payload = jwt.verify(token, EFFECTIVE_JWT_SECRET, {
      issuer: "red-music",
      audience: "red-music-client",
    });
    const db = getDb(req);
    if (db) {
      const userId = Number(payload.id);
      const user = db.prepare("SELECT id, username, banned, session_version FROM users WHERE id = ?").get(userId);
      if (
        user &&
        !user.banned &&
        Number(payload.sv) === Number(user.session_version || 1)
      ) {
        req.userId = userId;
        req.username = String(user.username || "");
      }
    }
  } catch (e) {
    // Invalid optional sessions are ignored.
  }
  next();
}

function requireRole(db, ...allowedRoles) {
  const normalizedAllowed = allowedRoles.map((role) => String(role).trim().toUpperCase());

  return function (req, res, next) {
    if (!req.userId) return res.status(401).json({ error: "Не авторизован" });

    const user = db
      .prepare("SELECT id, username, banned FROM users WHERE id = ?")
      .get(req.userId);

    if (!user) return res.status(401).json({ error: "Аккаунт не найден" });
    if (user.banned) return res.status(403).json({ error: "Аккаунт заблокирован" });

    const rows = db
      .prepare(
        `SELECT r.name FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ?`
      )
      .all(req.userId);

    const roles = rows.map((r) => String(r.name).toUpperCase());

    // Роль OWNER действительна только для аккаунта ID 1. Если она каким-то
    // образом оказалась у другого пользователя (старая база, прямой SQL),
    // мы просто игнорируем её, а не блокируем запрос целиком — иначе аккаунт
    // терял бы доступ и к тому, на что имеет право по остальным ролям.
    const effectiveRoles = Number(req.userId) === 1
      ? roles
      : roles.filter((role) => role !== "OWNER");

    if (normalizedAllowed.includes("OWNER") && Number(req.userId) === 1) {
      return next();
    }

    if (effectiveRoles.some((role) => normalizedAllowed.includes(role))) return next();
    return res.status(403).json({ error: "Недостаточно прав" });
  };
}

module.exports = {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  optionalAuth,
  requireRole,
  COOKIE_NAME,
};
