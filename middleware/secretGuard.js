/**
 * Production secret/configuration guard.
 * Fails closed when required credentials are missing or obviously unsafe.
 * No secret values are logged.
 */
function requireSecret(name, { minLength = 32, allowDevelopment = true } = {}) {
  const value = String(process.env[name] || "").trim();
  const production = process.env.NODE_ENV === "production";

  if (!value) {
    if (production || !allowDevelopment) {
      throw new Error(`${name} must be configured in the environment.`);
    }
    return null;
  }

  if (value.length < minLength) {
    throw new Error(`${name} must contain at least ${minLength} characters.`);
  }

  const weakValues = new Set([
    "change-me",
    "change-me-to-a-long-random-string",
    "secret",
    "password",
    "12345678901234567890123456789012",
    "red-music-development-secret-change-me"
  ]);

  if (weakValues.has(value.toLowerCase())) {
    throw new Error(`${name} contains a known unsafe placeholder value.`);
  }

  return value;
}

function validateProductionSecrets() {
  const production = process.env.NODE_ENV === "production";

  requireSecret("JWT_SECRET", { minLength: 32, allowDevelopment: true });

  if (production) {
    requireSecret("MASTER_PASSWORD", { minLength: 12, allowDevelopment: false });

    if (!String(process.env.MASTER_USERNAME || "").trim()) {
      throw new Error("MASTER_USERNAME must be configured in the environment.");
    }
  }
}

module.exports = { requireSecret, validateProductionSecrets };
