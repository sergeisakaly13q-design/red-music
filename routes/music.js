const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAction } = require("../db/audit");
const { STORAGE_DIR } = require("../db/database");
const { createRateLimiter } = require("../middleware/rateLimit");
const { createAntiSpam } = require("../middleware/antiSpam");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${crypto.randomUUID()}${ext}`;
    cb(null, unique);
  },
});

const MIME_TO_EXT = {
  "audio/mpeg": [".mp3"],
  "audio/mp3": [".mp3"],
  "audio/wav": [".wav"],
  "audio/x-wav": [".wav"],
  "audio/ogg": [".ogg"],
  "audio/x-m4a": [".m4a"],
  "audio/mp4": [".m4a", ".mp4"],
  "audio/flac": [".flac"],
};
const ALLOWED_EXT = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);

function hasValidAudioSignature(filePath, ext) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(32);
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    if (bytes < 4) return false;
    if (ext === ".mp3") {
      if (header.subarray(0, 3).toString("ascii") === "ID3") return true;
      return header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
    }
    if (ext === ".wav") return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE";
    if (ext === ".ogg") return header.subarray(0, 4).toString("ascii") === "OggS";
    if (ext === ".flac") return header.subarray(0, 4).toString("ascii") === "fLaC";
    if (ext === ".m4a") return header.subarray(4, 8).toString("ascii") === "ftyp";
    return false;
  } finally { fs.closeSync(fd); }
}

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = MIME_TO_EXT[file.mimetype] || [];
    if (!ALLOWED_EXT.has(ext) || !allowedMimes.includes(ext)) {
      return cb(new Error("Недопустимый формат файла или MIME-тип не соответствует расширению"));
    }
    cb(null, true);
  },
});

function removeUploadedFile(file) {
  if (!file?.path) return;
  try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) {}
}


module.exports = function createMusicRouter(db) {
  const router = express.Router();

  const uploadLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyPrefix: "music-upload",
    message: "Слишком много загрузок. Попробуйте позже.",
    includeAccount: true,
  });
  const antiSpam = createAntiSpam({ windowMs: 60 * 1000, maxActions: 30, cooldownMs: 90 * 1000, keyPrefix: "music-action" });
  const interactionLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 60,
    keyPrefix: "music-interaction",
    message: "Слишком много действий с музыкой. Повторите позже.",
    includeAccount: true,
  });
  const offlineDownloadLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 30,
    keyPrefix: "music-offline-download",
    message: "Слишком много офлайн-загрузок. Попробуйте позже.",
    includeAccount: true,
  });
  const vipOffline = requireRole(db, "VIP", "RUBY", "CO-CREATOR", "OWNER");

  // Public metadata helpers used by the app UI. These do not store third-party
  // media on the Red Music server: they return the source URL to the client.
  router.get("/artist-image", async (req, res) => {
    const name = String(req.query.name || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "Не указан исполнитель" });
    try {
      const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}`;
      const response = await fetch(url, { headers: { "User-Agent": "RedMusic/1.0" } });
      if (!response.ok) return res.json({ image: "" });
      const data = await response.json();
      const artist = Array.isArray(data.data) ? data.data[0] : null;
      const image = String(artist?.picture_big || artist?.picture_medium || artist?.picture || "").trim();
      return res.json({ image });
    } catch (e) {
      console.warn("[Red Music] artist image lookup:", e.message);
      return res.json({ image: "" });
    }
  });

  router.get("/lyrics", async (req, res) => {
    const track = String(req.query.track || "").trim().slice(0, 200);
    const artist = String(req.query.artist || "").trim().slice(0, 160);
    if (!track) return res.status(400).json({ error: "Не указан трек", lyrics: "" });
    try {
      const params = new URLSearchParams({ track_name: track });
      if (artist) params.set("artist_name", artist);
      const url = `https://lrclib.net/api/get?${params.toString()}`;
      const response = await fetch(url, { headers: { "User-Agent": "RedMusic/1.0" } });
      if (!response.ok) return res.json({ lyrics: "", source: "" });
      const data = await response.json();
      const lyrics = String(data?.plainLyrics || "").trim();
      return res.json({ lyrics, source: lyrics ? "lrclib" : "" });
    } catch (e) {
      console.warn("[Red Music] lyrics lookup:", e.message);
      return res.json({ lyrics: "", source: "" });
    }
  });

  router.post("/upload", requireAuth, uploadLimit, antiSpam, upload.single("audio"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Файл не получен" });

      // Optional playlist association. This lets a user attach their own
      // audio file to an imported track that was found by metadata but has
      // no playable Red Music audio yet.
      const playlistId = Number(req.body.playlistId || 0);
      const playlistTrackId = Number(req.body.playlistTrackId || 0);
      let importedTrack = null;

      if (playlistId || playlistTrackId) {
        if (!Number.isInteger(playlistId) || playlistId < 1 ||
            !Number.isInteger(playlistTrackId) || playlistTrackId < 1) {
          removeUploadedFile(req.file);
          return res.status(400).json({ error: "Некорректные данные импортированного трека" });
        }

        importedTrack = db.prepare(`
          SELECT pt.*, p.user_id AS playlist_owner
          FROM playlist_tracks pt
          JOIN playlists p ON p.id = pt.playlist_id
          WHERE pt.id = ? AND pt.playlist_id = ? AND p.user_id = ?
          LIMIT 1
        `).get(playlistTrackId, playlistId, req.userId);

        if (!importedTrack) {
          removeUploadedFile(req.file);
          return res.status(404).json({ error: "Импортированный трек не найден в вашем плейлисте" });
        }
      }

      const ext = path.extname(req.file.filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext) || !hasValidAudioSignature(req.file.path, ext)) {
        removeUploadedFile(req.file);
        return res.status(400).json({ error: "Содержимое файла не соответствует разрешённому аудиоформату" });
      }

      const cleanMeta = (value, fallback, maxLength) => String(value || fallback || "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, maxLength);

      const title = cleanMeta(req.body.title, importedTrack?.title || req.file.originalname, 120);
      const artist = cleanMeta(req.body.artist, importedTrack?.artist || "", 120);

      const tx = db.transaction(() => {
        const info = db
          .prepare(`INSERT INTO tracks (owner_id, title, artist, filename, mime_type, size_bytes) VALUES (?,?,?,?,?,?)`)
          .run(req.userId, title, artist, req.file.filename, req.file.mimetype, req.file.size);

        const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(info.lastInsertRowid);

        if (importedTrack) {
          // The imported playlist keeps its original metadata/source. Only
          // the playable Red Music track is attached here. VIP offline state
          // is inherited from the import record's offline_requested flag.
          db.prepare(`
            UPDATE playlist_tracks
            SET matched_track_id = ?,
                offline_available = CASE WHEN offline_requested = 1 THEN 1 ELSE 0 END
            WHERE id = ? AND playlist_id = ?
          `).run(Number(info.lastInsertRowid), playlistTrackId, playlistId);

          db.prepare(`UPDATE playlists SET updated_at=datetime('now') WHERE id=? AND user_id=?`)
            .run(playlistId, req.userId);
        }

        return track;
      });

      const track = tx();
      logAction(db, req.userId, importedTrack
        ? "playlist_track_audio_upload"
        : "track_upload",
        importedTrack
          ? `Добавлено аудио к импортированному треку «${importedTrack.title}»`
          : `Загружен трек «${title}»`
      );

      res.json({
        track,
        associated: !!importedTrack,
        playlistId: importedTrack ? playlistId : null,
        playlistTrackId: importedTrack ? playlistTrackId : null
      });
    } catch (e) {
      removeUploadedFile(req.file);
      console.error(e);
      res.status(400).json({ error: e.message || "Ошибка загрузки" });
    }
  });

  router.get("/mine", requireAuth, (req, res) => {
    const tracks = db.prepare("SELECT * FROM tracks WHERE owner_id = ? ORDER BY created_at DESC").all(req.userId);
    res.json({ tracks });
  });

  // Full-file download for built-in and uploaded catalog tracks. The filename
  // is always reduced to a basename and resolved only inside known audio roots.
  // This fixes downloads for tracks stored in uploads/ as well as public/music/.
  router.get("/offline/:filename", requireAuth, vipOffline, offlineDownloadLimit, (req, res) => {
    const rawFilename = String(req.params.filename || "");
    const filename = path.basename(rawFilename);
    if (!filename || filename !== rawFilename) {
      return res.status(400).json({ error: "Некорректное имя файла" });
    }

    const roots = [
      path.resolve(path.join(__dirname, "..", "public", "music")),
      path.resolve(path.join(__dirname, "..", "music")),
      path.resolve(path.join(__dirname, "..", "tracks")),
      path.resolve(path.join(__dirname, "..", "audio")),
      path.resolve(path.join(__dirname, "..", "assets", "music")),
      path.resolve(path.join(__dirname, "..", "assets", "audio")),
      path.resolve(path.join(__dirname, "..", "public", "audio")),
      path.resolve(path.join(__dirname, "..", "public", "tracks")),
      path.resolve(path.join(STORAGE_DIR, "music")),
      path.resolve(path.join(STORAGE_DIR, "uploads"))
    ];

    let filePath = null;
    for (const root of roots) {
      const candidate = path.resolve(path.join(root, filename));
      if (!candidate.startsWith(root + path.sep)) continue;
      try {
        if (fs.statSync(candidate).isFile()) { filePath = candidate; break; }
      } catch (_) {}
    }

    if (!filePath) {
      return res.status(404).json({ error: "Файл не найден", filename });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = { ".mp3":"audio/mpeg", ".wav":"audio/wav", ".ogg":"audio/ogg", ".m4a":"audio/mp4", ".flac":"audio/flac", ".aac":"audio/aac", ".opus":"audio/opus" }[ext] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Accept-Ranges", "bytes");
    fs.createReadStream(filePath).pipe(res);
  });

  // Full-file download is deliberately separate from the public stream endpoint.
  // The server, not the client UI, decides whether the account may download offline.
  router.get("/:id/download", requireAuth, vipOffline, offlineDownloadLimit, (req, res) => {
    const trackId = Number(req.params.id);
    if (!Number.isInteger(trackId) || trackId < 1) {
      return res.status(400).json({ error: "Некорректный ID трека" });
    }
    const track = db.prepare("SELECT id, title, artist, filename, mime_type, size_bytes FROM tracks WHERE id = ?").get(trackId);
    if (!track) return res.status(404).json({ error: "Трек не найден" });

    const filePath = path.join(UPLOAD_DIR, track.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Файл не найден на серверном диске" });
    }

    const stat = fs.statSync(filePath);
    const safeName = String(track.title || "red-music-track")
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
      .trim()
      .slice(0, 100) || "red-music-track";
    const ext = path.extname(track.filename).toLowerCase() || ".mp3";

    res.setHeader("Content-Type", track.mime_type || "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName + ext)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Accept-Ranges", "bytes");
    fs.createReadStream(filePath).pipe(res);
  });

  router.get("/:id/stream", (req, res) => {
    const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(req.params.id);
    if (!track) return res.status(404).json({ error: "Трек не найден" });

    const filePath = path.join(UPLOAD_DIR, track.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Файл не найден на серверном диске" });
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", track.mime_type || "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!range) {
      res.setHeader("Content-Length", total);
      return fs.createReadStream(filePath).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : total - 1;
    const end = Math.min(requestedEnd, total - 1);

    if (!Number.isFinite(start) || start < 0 || start >= total || end < start) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      return;
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);

    fs.createReadStream(filePath, { start, end }).pipe(res);
  });

  router.delete("/:id", requireAuth, (req, res) => {
    const track = db.prepare("SELECT * FROM tracks WHERE id = ? AND owner_id = ?").get(req.params.id, req.userId);
    if (!track) return res.status(404).json({ error: "Трек не найден" });
    db.prepare("DELETE FROM tracks WHERE id = ?").run(req.params.id);
    const filePath = path.join(UPLOAD_DIR, track.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    logAction(db, req.userId, "track_delete", `Удалён трек «${track.title}»`);
    res.json({ ok: true });
  });

  router.post("/:id/favorite", requireAuth, antiSpam, interactionLimit, (req, res) => {
    db.prepare("INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?,?)").run(req.userId, req.params.id);
    res.json({ ok: true });
  });

  router.delete("/:id/favorite", requireAuth, antiSpam, interactionLimit, (req, res) => {
    db.prepare("DELETE FROM favorites WHERE user_id = ? AND track_id = ?").run(req.userId, req.params.id);
    res.json({ ok: true });
  });

  router.get("/favorites", requireAuth, (req, res) => {
    const tracks = db
      .prepare(`SELECT t.* FROM favorites f JOIN tracks t ON t.id = f.track_id WHERE f.user_id = ? ORDER BY f.created_at DESC`)
      .all(req.userId);
    res.json({ tracks });
  });

  return router;
};
