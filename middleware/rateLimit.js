/**
 * Lightweight in-process rate limiting for Red Music.
 * No paid service and no extra dependency required.
 *
 * Limits are tracked separately for IP and authenticated account.
 * This is intentionally conservative for sensitive endpoints and more
 * permissive for the global API so audio playback is not accidentally broken.
 */
function getClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function getAccountKey(req) {
  if (req.userId) return `user:${req.userId}`;
  const bodyUsername = req.body && req.body.username;
  const queryUsername = req.query && req.query.username;
  const username = String(bodyUsername || queryUsername || "").trim().toLowerCase();
  return username ? `account:${username}` : null;
}

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 120,
  keyPrefix = "api",
  message = "Слишком много запросов. Повторите позже.",
  includeAccount = true,
} = {}) {
  const buckets = new Map();

  let lastCleanup = 0;

  function cleanup(now) {
    if (now - lastCleanup < 60 * 1000) return;
    lastCleanup = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    cleanup(now);

    const keys = [`${keyPrefix}:ip:${getClientIp(req)}`];
    const accountKey = includeAccount ? getAccountKey(req) : null;
    if (accountKey) keys.push(`${keyPrefix}:${accountKey}`);

    let retryAfter = 0;

    for (const key of keys) {
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }

      bucket.count += 1;
      if (bucket.count > max) {
        retryAfter = Math.max(retryAfter, Math.ceil((bucket.resetAt - now) / 1000));
      }
    }

    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("X-RateLimit-Limit", String(max));
      return res.status(429).json({ error: message, retryAfter });
    }

    res.setHeader("X-RateLimit-Limit", String(max));
    next();
  };
}

module.exports = { createRateLimiter, getClientIp };
