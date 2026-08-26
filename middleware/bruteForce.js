/**
 * Brute-force protection for authentication endpoints.
 *
 * It tracks failures by IP and username. A successful login clears both
 * counters for that identity. Delays and temporary blocks increase with
 * repeated failures, which makes password guessing considerably slower.
 *
 * This is deliberately dependency-free and in-memory for the free tier.
 * Restarting the server clears the temporary counters.
 */
const attempts = new Map();

const MAX_ACCOUNT_FAILURES = 5;
const MAX_IP_FAILURES = 20;
const BASE_BLOCK_MS = 60 * 1000;
const MAX_BLOCK_MS = 30 * 60 * 1000;
let lastCleanup = 0;

function cleanup(now) {
  if (now - lastCleanup < 5 * 60 * 1000) return;
  lastCleanup = now;
  for (const [key, state] of attempts) {
    if (state.blockedUntil <= now && state.lastFailureAt > 0 && now - state.lastFailureAt > MAX_BLOCK_MS) {
      attempts.delete(key);
    }
  }
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function makeKeys(req, username) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown");
  const user = normalize(username);
  return [
    `ip:${ip}`,
    ...(user ? [`user:${user}`, `combo:${ip}:${user}`] : []),
  ];
}

function getState(key, now) {
  let state = attempts.get(key);
  if (!state) {
    state = { failures: 0, blockedUntil: 0, lastFailureAt: 0 };
    attempts.set(key, state);
  }
  if (state.blockedUntil && state.blockedUntil <= now) {
    state.blockedUntil = 0;
  }
  return state;
}

function checkBruteForce(req, username) {
  const now = Date.now();
  cleanup(now);
  let blockedUntil = 0;

  for (const key of makeKeys(req, username)) {
    const state = getState(key, now);
    blockedUntil = Math.max(blockedUntil, state.blockedUntil);
  }

  if (blockedUntil > now) {
    return {
      blocked: true,
      retryAfter: Math.ceil((blockedUntil - now) / 1000),
    };
  }

  return { blocked: false, retryAfter: 0 };
}

function recordFailure(req, username) {
  const now = Date.now();
  cleanup(now);

  for (const key of makeKeys(req, username)) {
    const state = getState(key, now);
    state.failures += 1;
    state.lastFailureAt = now;

    const isIpKey = key.startsWith("ip:");
    const maxFailures = isIpKey ? MAX_IP_FAILURES : MAX_ACCOUNT_FAILURES;

    if (state.failures >= maxFailures) {
      const level = Math.min(state.failures - maxFailures, 5);
      const blockMs = Math.min(
        BASE_BLOCK_MS * (2 ** level),
        MAX_BLOCK_MS
      );
      state.blockedUntil = Math.max(state.blockedUntil, now + blockMs);
    }
  }
}

function clearFailures(req, username) {
  // A successful login proves the username/password pair. Do not clear the
  // IP-wide counter, otherwise an attacker could reset the IP defense simply
  // by logging into any valid account from the same address.
  const keys = makeKeys(req, username).filter((key) => !key.startsWith("ip:"));
  for (const key of keys) attempts.delete(key);
}

function getFailureDelay(req, username) {
  const now = Date.now();
  let failures = 0;

  for (const key of makeKeys(req, username)) {
    failures = Math.max(failures, getState(key, now).failures);
  }

  // Small progressive delay after failed attempts, capped at 3 seconds.
  if (failures <= 0) return 0;
  return Math.min(250 * (2 ** Math.min(failures - 1, 4)), 3000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function protectAuthAttempt(req, res, username) {
  const status = checkBruteForce(req, username);
  if (status.blocked) {
    res.setHeader("Retry-After", String(status.retryAfter));
    res.status(429).json({
      error: "Слишком много неудачных попыток. Вход временно заблокирован.",
      retryAfter: status.retryAfter,
    });
    return false;
  }

  const delay = getFailureDelay(req, username);
  if (delay > 0) await sleep(delay);
  return true;
}

module.exports = {
  protectAuthAttempt,
  recordFailure,
  clearFailures,
  checkBruteForce,
};
