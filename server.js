require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

const { db, ensureSchema } = require("./db/database");
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
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// --- REST API (реальный backend: SQLite, авторизация, роли, музыка, история, логи) ---
app.use("/api/auth", createAuthRouter(db));
app.use("/api/roles", createRolesRouter(db));
app.use("/api/music", createMusicRouter(db));
app.use("/api/history", createHistoryRouter(db));
app.use("/api/popular", createPopularRouter(db));
app.use("/api/admin/logs", createLogsRouter(db));

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "Red Music", version: "4.1.0-sqlite" });
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
