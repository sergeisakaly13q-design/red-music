/**
 * Lightweight anomaly detector. It does not permanently ban users/IPs.
 * It temporarily throttles unusually dense state-changing traffic.
 */
const { getClientIp } = require('./rateLimit');

function createSuspiciousActivityGuard({ windowMs = 15 * 1000, maxActions = 35, blockMs = 60 * 1000 } = {}) {
  const buckets = new Map();
  const blocked = new Map();
  let lastCleanup = 0;

  return function suspiciousActivity(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const now = Date.now();
    if (now - lastCleanup > 60 * 1000) {
      lastCleanup = now;
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      for (const [k, v] of blocked) if (v <= now) blocked.delete(k);
    }
    const key = req.userId ? `user:${req.userId}` : `ip:${getClientIp(req)}`;
    const until = blocked.get(key) || 0;
    if (until > now) {
      res.setHeader('Retry-After', String(Math.ceil((until - now) / 1000)));
      return res.status(429).json({ error: 'Слишком высокая активность. Повторите позже.' });
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxActions) {
      blocked.set(key, now + blockMs);
      buckets.delete(key);
      res.setHeader('Retry-After', String(Math.ceil(blockMs / 1000)));
      return res.status(429).json({ error: 'Необычно высокая активность. Действия временно ограничены.' });
    }
    next();
  };
}

module.exports = { createSuspiciousActivityGuard };
