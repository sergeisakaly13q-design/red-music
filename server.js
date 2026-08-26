require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const { createRateLimiter } = require("./middleware/rateLimit");
const { validateApiRequest } = require("./middleware/apiValidation");
const { securityHeaders } = require("./middleware/securityHeaders");
const { requireCsrfOrigin } = require("./middleware/csrf");
const { createSuspiciousActivityGuard } = require("./middleware/suspiciousActivity");
const { validateProductionSecrets } = require("./middleware/secretGuard");
const { createSecurityMonitor } = require("./middleware/securityMonitor");

const { db, ensureSchema, STORAGE_DIR } = require("./db/database");
const createAuthRouter = require("./routes/auth");
const createRolesRouter = require("./routes/roles");
const createMusicRouter = require("./routes/music");
const createHistoryRouter = require("./routes/history");
const createPopularRouter = require("./routes/popular");
const createLogsRouter = require("./routes/logs");
const createPlaylistsRouter = require("./routes/playlists");
const createTelegramRouter = require("./routes/telegram");
const createListeningRewardsRouter = require("./routes/listeningRewards");
const { startTelegramBot } = require("./telegramBot");
const { registerBackupRoutes } = require("./backup");

validateProductionSecrets();

const app = express();
const PORT = process.env.PORT || 3000;

// Expose the already-open database to authentication middleware without
// changing every route signature. No client input reaches this value.
app.locals.db = db;
registerBackupRoutes(app, db);

// Render/Cloudflare normally sit in front of the app. Trust the first proxy
// so Express can use the real client IP for rate limiting.
app.set("trust proxy", 1);

// Security headers are applied before static files and API routes.
app.use(securityHeaders);

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Validate API input before rate limiting so malformed/polluted requests
// are rejected consistently and cheaply.
app.use("/api", validateApiRequest);
// Block cross-site state-changing requests that try to reuse cookie sessions.
app.use("/api", requireCsrfOrigin);
// Persistent security monitoring and conservative automatic IP blocking.
const securityMonitor = createSecurityMonitor(db);
app.use("/api", securityMonitor.middleware);
// Additional burst detector for state-changing API traffic. Route-specific
// limits remain the primary control; this catches unusually dense bursts.
app.use("/api", createSuspiciousActivityGuard());

// Global API guard. The limit is intentionally high enough for Media3/ExoPlayer
// range requests and normal app activity. Sensitive endpoints have stricter
// route-specific limits below.
app.use("/api", createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  keyPrefix: "api-global",
  message: "Слишком много API-запросов. Повторите через минуту.",
  includeAccount: true,
}));


/* Red Music API access from Capacitor/Android. */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    "https://red-music.onrender.com",
    "https://sergeisakaly13q-design.github.io",
    "https://localhost",
    "http://localhost",
    "capacitor://localhost",
    "ionic://localhost"
  ]);
  const configuredOrigin = String(process.env.FRONTEND_ORIGIN || "").trim().replace(/\/$/, "");
  if (configuredOrigin) allowedOrigins.add(configuredOrigin);
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Red-Music-Client");
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

// Каталог музыки. Файлы могут находиться в public/music, music, tracks,
// audio, assets/music и других папках репозитория. Это важно, когда большие
// MP3 не попадают в подготовленный ZIP, но присутствуют в GitHub.
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;
const AUDIO_ROOTS = [
  path.join(__dirname, "public", "music"),
  path.join(__dirname, "music"),
  path.join(__dirname, "tracks"),
  path.join(__dirname, "audio"),
  path.join(__dirname, "assets", "music"),
  path.join(__dirname, "assets", "audio"),
  path.join(__dirname, "public", "audio"),
  path.join(__dirname, "public", "tracks"),
  path.join(STORAGE_DIR, "music"),
  path.join(STORAGE_DIR, "uploads"),
  path.join(__dirname, "uploads")
];

function safeAudioName(value) {
  const name = path.basename(String(value || ""));
  return name && AUDIO_EXT.test(name) ? name : null;
}

// Нормализация имён аудиофайлов.
// Нужна для случаев, когда в GitHub файл называется, например,
// "Валентин Стрыкало - Всё решено.mp3", а приложение запрашивает
// "valentin-strykalo-vsyo-resheno.mp3".
function normalizeAudioKey(value) {
  const map = {
    "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh",
    "з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o",
    "п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"ts",
    "ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"
  };

  return String(value || "")
    .toLowerCase()
    .replace(/\\.[a-z0-9]+$/i, "")
    .split("")
    .map(ch => map[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^(redmusic|music|audio|track)/, "");
}

function audioKeysMatch(requested, actual) {
  const a = normalizeAudioKey(requested);
  const b = normalizeAudioKey(actual);
  if (!a || !b) return false;
  if (a === b) return true;

  // Частый вариант: имя содержит исполнителя/дополнительный текст.
  // Сравниваем также конец строки, чтобы не путать песни одного исполнителя.
  return a.endsWith(b) || b.endsWith(a);
}

function findAudioFile(filename) {
  const wanted = safeAudioName(filename);
  if (!wanted) return null;

  const direct = AUDIO_ROOTS.map(dir => path.join(dir, wanted));
  for (const file of direct) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch (_) {}
  }

  const visited = new Set();
  function scan(dir, depth) {
    if (depth > 5 || visited.has(dir)) return null;
    visited.add(dir);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }

    for (const entry of entries) {
      if (["node_modules", ".git", "android"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name.toLowerCase() === wanted.toLowerCase()) return full;

        // Fallback: ищем тот же трек по нормализованному имени.
        // Работает с кириллицей, дефисами, пробелами, "ё/е" и
        // добавленным именем исполнителя в названии файла.
        if (AUDIO_EXT.test(entry.name) && audioKeysMatch(wanted, entry.name)) {
          return full;
        }
      }

      if (entry.isDirectory()) {
        const found = scan(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  for (const root of AUDIO_ROOTS) {
    const found = scan(root, 0);
    if (found) return found;
  }
  return null;
}

function audioMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".opus": "audio/opus"
  })[ext] || "application/octet-stream";
}

app.all("/music/:filename", (req, res) => {
  const filename = safeAudioName(req.params.filename);
  if (!filename) return res.status(400).json({ error: "Некорректное имя аудиофайла" });

  const filePath = findAudioFile(filename);
  if (!filePath) {
    return res.status(404).json({
      error: "Аудиофайл не найден на сервере",
      filename,
      hint: "Проверьте, что большой MP3 действительно попал в Render deployment."
    });
  }

  const stat = fs.statSync(filePath);
  const total = stat.size;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", audioMime(filePath));
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (req.method === "HEAD") {
    res.setHeader("Content-Length", total);
    return res.end();
  }

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", total);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return res.status(416).setHeader("Content-Range", `bytes */${total}`).end();

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;

  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(total - suffix, 0);
    end = total - 1;
  }

  end = Math.min(end, total - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end < start) {
    return res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// --- REST API (реальный backend: SQLite, авторизация, роли, музыка, история, логи) ---
app.use("/api/auth", createAuthRouter(db));
app.use("/api/roles", createRolesRouter(db));
app.use("/api/music", createMusicRouter(db));
app.use("/api/history", createHistoryRouter(db));
app.use("/api/popular", createPopularRouter(db));
app.use("/api/admin/logs", createLogsRouter(db));
app.use("/api/playlists", createPlaylistsRouter(db));
app.use("/api/telegram", createTelegramRouter(db));
app.use("/api/listening-rewards", createListeningRewardsRouter(db));

app.get("/health", (_req, res) => {
  res.json({ ok: true, app: "Red Music", version: "4.3.0-all-devices" });
});

app.get("/api/music/catalog", (_req, res) => {
  // Dynamic server catalog: any supported audio file placed in uploads/
  // becomes visible in Red Music without editing public/index.html.
  const roots = [
    path.join(STORAGE_DIR, "uploads"),
    path.join(__dirname, "uploads")
  ];
  const seen = new Set();
  const tracks = [];

  function parseFilename(filename) {
    const base = path.basename(filename, path.extname(filename)).trim();
    const parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) {
      return {
        artist: parts.shift().trim(),
        title: parts.join(" - ").trim() || base
      };
    }
    return { artist: "", title: base || filename };
  }

  function scan(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);

      if (entry.isFile() && AUDIO_EXT.test(entry.name)) {
        const real = path.resolve(full);
        const key = real.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const stat = fs.statSync(full);
        const meta = parseFilename(entry.name);
        tracks.push({
          key: `upload:${entry.name}`,
          title: meta.title,
          artist: meta.artist,
          type: "server",
          dataUrl: `/music/${encodeURIComponent(entry.name)}`,
          uploadFile: entry.name,
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString()
        });
      } else if (entry.isDirectory()) {
        scan(full, depth + 1);
      }
    }
  }

  roots.forEach(dir => scan(dir));
  tracks.sort((a, b) => `${a.artist} ${a.title}`.localeCompare(`${b.artist} ${b.title}`, "ru"));

  res.json({ ok: true, tracks });
});

app.get("/api/music/public-health", (_req, res) => {
  const files = [];
  const seen = new Set();

  function scan(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }

    for (const entry of entries) {
      if (["node_modules", ".git", "android"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isFile() && AUDIO_EXT.test(entry.name)) {
        const key = entry.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          files.push(entry.name);
        }
      } else if (entry.isDirectory()) {
        scan(full, depth + 1);
      }
    }
  }

  AUDIO_ROOTS.forEach(dir => scan(dir));
  files.sort();

  res.json({
    ok: true,
    trackFiles: files.length,
    files,
    message: files.length
      ? "Аудиофайлы найдены на сервере."
      : "Аудиофайлы не найдены в Render deployment."
  });
});

app.get("/api/music/check-many", (req, res) => {
  const raw = String(req.query.files || "");
  const requested = raw.split(",").map(s => safeAudioName(s.trim())).filter(Boolean).slice(0, 100);

  const result = requested.map(filename => {
    const filePath = findAudioFile(filename);
    if (!filePath) return { filename, exists: false };
    const stat = fs.statSync(filePath);
    return {
      filename,
      exists: true,
      size: stat.size,
      mime: audioMime(filePath)
    };
  });

  res.json({ ok: true, files: result });
});

app.get("/api/music/check/:filename", (req, res) => {
  const filename = safeAudioName(req.params.filename);
  if (!filename) return res.status(400).json({ ok: false, error: "Некорректное имя" });

  const filePath = findAudioFile(filename);
  if (!filePath) return res.status(404).json({ ok: false, filename, exists: false });

  const stat = fs.statSync(filePath);
  res.json({
    ok: true,
    filename,
    exists: true,
    size: stat.size,
    mime: audioMime(filePath)
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
  startTelegramBot(db).catch((error) => {
    console.error("[telegram] Ошибка запуска:", error);
  });
});
