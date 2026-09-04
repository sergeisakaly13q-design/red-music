/**
 * Origin-based CSRF protection.
 *
 * Red Music uses HttpOnly authentication cookies. For browser/WebView requests,
 * state-changing API calls must come from one of the application's known origins.
 * Cross-site requests therefore cannot reuse the user's authentication cookie.
 *
 * GET/HEAD/OPTIONS are intentionally excluded because they do not change state.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_ORIGINS = new Set([
  "https://red-music.onrender.com",
  "https://sergeisakaly13q-design.github.io",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost",
]);

function requireCsrfOrigin(req, res, next) {
  const configured = String(process.env.FRONTEND_ORIGIN || "").trim().replace(/\/$/, "");
  if (configured) ALLOWED_ORIGINS.add(configured);
  if (SAFE_METHODS.has(req.method)) return next();

  // Native Red Music clients (Electron/Capacitor) can send an opaque or
  // missing Origin header. The dedicated client header is added by the
  // application itself, so validate it before browser Origin checks.
  const nativeClientHeader = String(req.headers["x-red-music-client"] || "");
  if (nativeClientHeader === "1") return next();

  const origin = req.headers.origin;
  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: "Запрос заблокирован политикой безопасности" });
    }
    return next();
  }

  // Referer is a useful fallback for normal browser form/navigation requests.
  const referer = req.headers.referer;
  if (referer) {
    try {
      const originFromReferer = new URL(referer).origin;
      if (ALLOWED_ORIGINS.has(originFromReferer)) return next();
    } catch (_) {}
    return res.status(403).json({ error: "Недопустимый источник запроса" });
  }

  // Requests without Origin/Referer are otherwise allowed only when they do
  // not carry the browser authentication cookie. This preserves server-to-
  // server and CLI/API integrations while preventing cookie-based CSRF.
  const cookieHeader = String(req.headers.cookie || "");
  const hasAuthCookie = /(?:^|;\s*)rm_token=/.test(cookieHeader);
  if (hasAuthCookie) {
    return res.status(403).json({ error: "Не удалось проверить источник запроса" });
  }

  next();
}

module.exports = { requireCsrfOrigin };
