/**
 * Lightweight dependency-free API input validation.
 *
 * This is not a replacement for route-specific business validation. It
 * rejects malformed object graphs, prototype-pollution keys, oversized
 * values, and invalid numeric identifiers before application code reaches
 * the database.
 */
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_STRING_LENGTH = 4.5 * 1024 * 1024;
const MAX_OBJECT_KEYS = 100;
const MAX_ARRAY_LENGTH = 500;
const MAX_DEPTH = 10;

function inspectValue(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("Слишком глубокая структура данных");

  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new Error("Слишком большое текстовое поле");
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new Error("Слишком большой массив");
    for (const item of value) inspectValue(item, depth + 1);
    return;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) throw new Error("Слишком много параметров");
    for (const key of keys) {
      if (BLOCKED_KEYS.has(key)) throw new Error("Недопустимый параметр");
      inspectValue(value[key], depth + 1);
    }
  }
}

function validateNumericParameter(name, value) {
  if (value === undefined) return null;
  if (!/^(?:id|userId|trackId|roleId)$/.test(name)) return null;
  if (!/^\d+$/.test(String(value))) return "Некорректный идентификатор";
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return "Некорректный идентификатор";
  return null;
}

function validateApiRequest(req, res, next) {
  try {
    if (req.path.startsWith("/auth") || req.method !== "GET") {
      if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
        inspectValue(req.body);
      }
    }

    for (const [name, value] of Object.entries(req.params || {})) {
      const error = validateNumericParameter(name, value);
      if (error) return res.status(400).json({ error });
    }

    for (const [name, value] of Object.entries(req.query || {})) {
      const error = validateNumericParameter(name, value);
      if (error) return res.status(400).json({ error });
      if (Array.isArray(value) && value.length > 100) {
        return res.status(400).json({ error: "Слишком много параметров запроса" });
      }
      if (typeof value === "string" && value.length > 10000) {
        return res.status(400).json({ error: "Параметр запроса слишком длинный" });
      }
    }

    next();
  } catch (error) {
    return res.status(400).json({ error: error.message || "Некорректный запрос" });
  }
}

module.exports = { validateApiRequest };
