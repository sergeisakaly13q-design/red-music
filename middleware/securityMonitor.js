/**
 * Red Music security monitoring and automatic temporary IP blocking.
 * Free, SQLite-backed, and intentionally conservative.
 */
const { getClientIp } = require("./rateLimit");

function createSecurityMonitor(db, {
  windowMinutes = 10,
  strikeThreshold = 10,
  baseBlockMinutes = 5,
  maxBlockMinutes = 60,
  eventRetentionDays = 30,
} = {}) {
  // The server creates this monitor before the final ensureSchema() call.
  // Keep the monitor self-contained so a fresh database can start safely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      user_id INTEGER,
      event_type TEXT NOT NULL,
      path TEXT DEFAULT '',
      method TEXT DEFAULT '',
      status_code INTEGER,
      details TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS security_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT UNIQUE NOT NULL,
      strikes INTEGER NOT NULL DEFAULT 0,
      blocked_until TEXT,
      last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_security_blocks_until ON security_blocks(blocked_until);
  `);

  const eventStmt = db.prepare(`
    INSERT INTO security_events
      (ip, user_id, event_type, path, method, status_code, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const blockStmt = db.prepare(`
    INSERT INTO security_blocks (ip, strikes, blocked_until, last_event_at, reason)
    VALUES (?, 1, datetime('now'), datetime('now'), ?)
    ON CONFLICT(ip) DO UPDATE SET
      strikes = security_blocks.strikes + 1,
      last_event_at = datetime('now'),
      reason = excluded.reason
  `);
  const getBlock = db.prepare(
    "SELECT ip, strikes, blocked_until FROM security_blocks WHERE ip = ?"
  );
  const updateBlock = db.prepare(
    "UPDATE security_blocks SET blocked_until = ?, last_event_at = datetime('now'), reason = ? WHERE ip = ?"
  );
  const resetExpired = db.prepare(
    "DELETE FROM security_blocks WHERE blocked_until IS NOT NULL AND datetime(blocked_until) <= datetime('now') AND last_event_at <= datetime('now', ?)"
  );

  function isBadStatus(status) {
    return status === 401 || status === 429;
  }

  function isProtectedPath(path) {
    return typeof path === "string" && path.startsWith("/api");
  }

  function cleanup() {
    try {
      resetExpired.run(`-${windowMinutes * 3} minutes`);
      db.prepare(
        "DELETE FROM security_events WHERE created_at < datetime('now', ?)"
      ).run(`-${eventRetentionDays} days`);
    } catch (_) {}
  }

  function activeBlock(ip) {
    cleanup();
    const row = getBlock.get(ip);
    if (!row || !row.blocked_until) return null;
    const until = Date.parse(String(row.blocked_until).replace(" ", "T") + "Z");
    if (!Number.isFinite(until) || until <= Date.now()) return null;
    return {
      until,
      retryAfter: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
    };
  }

  function record(req, statusCode, eventType, details = "") {
    const ip = getClientIp(req);
    const userId = req.userId ? Number(req.userId) : null;
    try {
      eventStmt.run(
        ip,
        Number.isInteger(userId) && userId > 0 ? userId : null,
        eventType,
        String(req.originalUrl || req.path || "").slice(0, 500),
        String(req.method || "").slice(0, 12),
        Number(statusCode) || null,
        String(details || "").slice(0, 500)
      );
    } catch (_) {}

    if (!isBadStatus(Number(statusCode)) || !isProtectedPath(req.path)) return;

    try {
      const recent = db.prepare(`
        SELECT COUNT(*) AS count
        FROM security_events
        WHERE ip = ?
          AND created_at >= datetime('now', ?)
          AND status_code IN (401, 429)
      `).get(ip, `-${windowMinutes} minutes`);

      if (Number(recent.count) < strikeThreshold) return;

      const row = getBlock.get(ip);
      const strikes = Number(row?.strikes || 0) + 1;
      const level = Math.min(Math.max(strikes - 1, 0), 6);
      const blockMinutes = Math.min(
        baseBlockMinutes * (2 ** level),
        maxBlockMinutes
      );
      const until = new Date(Date.now() + blockMinutes * 60 * 1000)
        .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

      if (!row) {
        blockStmt.run(ip, "Repeated authentication/rate-limit violations");
      }
      updateBlock.run(
        until,
        `Repeated API violations: ${recent.count} events in ${windowMinutes} minutes`,
        ip
      );
    } catch (_) {}
  }

  function middleware(req, res, next) {
    const ip = getClientIp(req);
    const block = activeBlock(ip);
    if (block) {
      res.setHeader("Retry-After", String(block.retryAfter));
      record(req, 429, "auto_blocked", "Temporary IP block is active");
      return res.status(429).json({
        error: "IP временно заблокирован из-за подозрительной активности.",
        retryAfter: block.retryAfter,
      });
    }

    res.on("finish", () => {
      const status = Number(res.statusCode);
      if (isBadStatus(status) && isProtectedPath(req.path)) {
        const type = status === 401 ? "auth_failure" : "rate_limit";
        record(req, status, type, "Protected API request rejected");
      }
    });
    next();
  }

  return { middleware, record, activeBlock };
}

module.exports = { createSecurityMonitor };
