/**
 * Security headers for Red Music.
 * Kept dependency-free so the project remains free and lightweight.
 */
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self' 'unsafe-inline' https:",
    "connect-src 'self' https://red-music.onrender.com https://localhost http://localhost capacitor://localhost ionic://localhost",
    "worker-src 'self' blob:",
  ].join("; "));

  // HSTS is only safe to advertise when the public deployment is HTTPS.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}

module.exports = { securityHeaders };
