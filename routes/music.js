const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { requireAuth } = require("../middleware/auth");
const { logAction } = require("../db/audit");
const { STORAGE_DIR } = require("../db/database");

const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).slice(0, 10);
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, unique);
  },
});
const ALLOWED_MIME = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/x-m4a", "audio/mp4", "audio/flac"]);
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 МБ на трек
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("Недопустимый формат файла. Разрешены: mp3, wav, ogg, m4a, flac"));
    }
    cb(null, true);
  },
});

module.exports = function createMusicRouter(db) {
  const router = express.Router();

  router.post("/upload", requireAuth, upload.single("audio"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Файл не получен" });
      const title = (req.body.title || req.file.originalname).slice(0, 120);
      const artist = (req.body.artist || "").slice(0, 120);
      const info = db
        .prepare(`INSERT INTO tracks (owner_id, title, artist, filename, mime_type, size_bytes) VALUES (?,?,?,?,?,?)`)
        .run(req.userId, title, artist, req.file.filename, req.file.mimetype, req.file.size);
      const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(info.lastInsertRowid);
      logAction(db, req.userId, "track_upload", `Загружен трек «${title}»`);
      res.json({ track });
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: e.message || "Ошибка загрузки" });
    }
  });

  router.get("/mine", requireAuth, (req, res) => {
    const tracks = db.prepare("SELECT * FROM tracks WHERE owner_id = ? ORDER BY created_at DESC").all(req.userId);
    res.json({ tracks });
  });

  router.get("/:id/stream", (req, res) => {
    const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(req.params.id);
    if (!track) return res.status(404).json({ error: "Трек не найден" });
    const filePath = path.join(UPLOAD_DIR, track.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Файл не найден на диске" });
    res.setHeader("Content-Type", track.mime_type);
    fs.createReadStream(filePath).pipe(res);
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

  router.post("/:id/favorite", requireAuth, (req, res) => {
    db.prepare("INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?,?)").run(req.userId, req.params.id);
    res.json({ ok: true });
  });

  router.delete("/:id/favorite", requireAuth, (req, res) => {
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
