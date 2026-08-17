/**
 * Red Music anti-spam / suspicious activity guard.
 * In-process and free. Complements route-specific rate limits.
 */
const { getClientIp } = require('./rateLimit');

function createAntiSpam({
  windowMs = 60 * 1000,
  maxActions = 80,
  cooldownMs = 2 * 60 * 1000,
  keyPrefix = 'action',
} = {}) {
  const buckets = new Map();
  const blocked = new Map();
  let lastCleanup = 0;

  function identity(req) {
    const account = req.userId ? `user:${req.userId}` : null;
    const ip = `ip:${getClientIp(req)}`;
    return account ? `${keyPrefix}:${account}` : `${keyPrefix}:${ip}`;
  }

  function cleanup(now) {
    if (now - lastCleanup < 60 * 1000) return;
    lastCleanup = now;
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    for (const [key, until] of blocked) if (until <= now) blocked.delete(key);
  }

  return function antiSpam(req, res, next) {
    const now = Date.now();
    cleanup(now);
    const key = identity(req);
    const blockedUntil = blocked.get(key) || 0;
    if (blockedUntil > now) {
      res.setHeader('Retry-After', String(Math.ceil((blockedUntil - now) / 1000)));
      return res.status(429).json({ error: 'Слишком много одинаковых действий. Повторите позже.' });
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > maxActions) {
      const until = now + cooldownMs;
      blocked.set(key, until);
      buckets.delete(key);
      res.setHeader('Retry-After', String(Math.ceil(cooldownMs / 1000)));
      return res.status(429).json({ error: 'Подозрительно много действий. Доступ временно ограничен.' });
    }
    next();
  };
}

module.exports = { createAntiSpam };
