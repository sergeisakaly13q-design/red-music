require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");

const { db, ensureSchema, STORAGE_DIR } = require("./db/database");
const createAuthRouter = require("./routes/auth");
const createRolesRouter = require("./routes/roles");
const createMusicRouter = require("./routes/music");
const createHistoryRouter = require("./routes/history");
const createPopularRouter = require("./routes/popular");
const createLogsRouter = require("./routes/logs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* Red Music API access from Capacitor/Android. */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    "https://red-music.onrender.com",
    "https://localhost",
    "http://localhost",
    "capacitor://localhost",
    "ionic://localhost"
  ]);
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));
// Музыка хранится в STORAGE_DIR/uploads. Раздаём её и через /uploads,
 // чтобы одинаково работало в браузере и Android WebView.
app.use("/uploads", express.static(path.join(STORAGE_DIR, "uploads"), {
  acceptRanges: true,
  fallthrough: false,
  maxAge: "1h",
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  },
}));

// Каталог музыки, который входит прямо в APK/репозиторий.
// В отличие от /uploads он не зависит от локального телефона пользователя
// и не пропадает после перезапуска бесплатного хостинга.
app.use("/music", express.static(path.join(__dirname, "public", "music"), {
  acceptRanges: true,
  fallthrough: false,
  maxAge: "1h",
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");
  },
}));

// --- REST API (реальный backend: SQLite, авторизация, роли, музыка, история, логи) ---
app.use("/api/auth", createAuthRouter(db));
app.use("/api/roles", createRolesRouter(db));
app.use("/api/music", createMusicRouter(db));
app.use("/api/history", createHistoryRouter(db));
app.use("/api/popular", createPopularRouter(db));
app.use("/api/admin/logs", createLogsRouter(db));

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "Red Music", version: "4.3.0-all-devices" });
});

app.get("/api/music/public-health", (_req, res) => {
  const musicDir = path.join(__dirname, "public", "music");
  let files = [];
  try {
    files = fs.readdirSync(musicDir)
      .filter(name => /\.(mp3|wav|ogg|m4a|flac)$/i.test(name));
  } catch (_) {}

  res.json({
    ok: true,
    publicMusicDirectory: "/music",
    trackFiles: files.length,
    files
  });
});

// Фронтенд (index.html) — как и раньше, отдаётся на все остальные маршруты
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

try {
  ensureSchema();
} catch (e) {
  console.error("[db] Не удалось применить схему БД:", e.message);
}

app.listen(PORT, () => {
  console.log(`Red Music запущен: http://localhost:${PORT}`);
});
