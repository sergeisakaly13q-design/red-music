const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const COOKIE_NAME = "rm_token";

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: "30d",
  });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Требует авторизации. При успехе кладёт req.userId / req.username.
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Не авторизован" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.username = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Сессия недействительна, войдите снова" });
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.username = payload.username;
  } catch (e) {
    // игнорируем невалидный токен
  }
  next();
}

// Фабрика middleware: требует, чтобы у пользователя была одна из указанных ролей.
function requireRole(db, ...allowedRoles) {
  return function (req, res, next) {
    if (!req.userId) return res.status(401).json({ error: "Не авторизован" });
    const rows = db
      .prepare(
        `SELECT r.name FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = ?`
      )
      .all(req.userId);
    const roles = rows.map((r) => r.name);
    if (roles.some((r) => allowedRoles.includes(r))) return next();
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
