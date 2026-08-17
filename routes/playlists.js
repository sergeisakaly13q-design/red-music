const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { logAction } = require("../db/audit");

const PROVIDERS = {
  spotify: { label: "Spotify", hosts: ["open.spotify.com", "spotify.com"] },
  soundcloud: { label: "SoundCloud", hosts: ["soundcloud.com", "snd.sc"] },
  "youtube-music": { label: "YouTube Music", hosts: ["music.youtube.com", "youtube.com", "youtu.be"] },
  apple: { label: "Apple Music", hosts: ["music.apple.com", "itunes.apple.com"] },
};

function detectProvider(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase().replace(/^www\./, "");
    return Object.entries(PROVIDERS).find(([, p]) => p.hosts.some(h => host === h || host.endsWith("." + h)))?.[0] || null;
  } catch (_) { return null; }
}

function cleanText(v, max = 180) {
  return String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function cleanUrl(v) {
  try {
    const u = new URL(String(v));
    if (!["https:", "http:"].includes(u.protocol)) return null;
    return u.toString().slice(0, 2048);
  } catch (_) { return null; }
}
function vipUser(db, userId) {
  if (Number(userId) === 1) return true;
  const rows = db.prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?`).all(userId);
  return rows.some(r => ["VIP", "RUBY", "CO-CREATOR", "OWNER"].includes(String(r.name).toUpperCase()));
}
function findMatchedTrack(db, title, artist) {
  const t = cleanText(title, 180).toLowerCase();
  const a = cleanText(artist, 180).toLowerCase();
  if (!t) return null;
  let row = db.prepare(`SELECT * FROM tracks WHERE lower(title)=? AND lower(coalesce(artist,''))=? ORDER BY id DESC LIMIT 1`).get(t, a);
  if (!row) row = db.prepare(`SELECT * FROM tracks WHERE lower(title)=? ORDER BY id DESC LIMIT 1`).get(t);
  return row || null;
}

function extractJsonScripts(html) {
  const out = [];
  const patterns = [
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["'](?:__NEXT_DATA__|initial-state|data)["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*>([\s\S]*?ytInitialData[\s\S]*?)<\/script>/gi,
  ];
  for (const re of patterns) {
    let m; while ((m = re.exec(html)) && out.length < 40) {
      const raw = m[1].trim();
      try { out.push(JSON.parse(raw)); } catch (_) {}
    }
  }
  return out;
}

function collectTrackCandidates(value, out = [], depth = 0) {
  if (!value || depth > 14 || out.length >= 500) return out;
  if (Array.isArray(value)) { for (const x of value) collectTrackCandidates(x, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  const title = value.title?.simpleText || value.title?.runs?.map(x => x.text).join("") || value.name || value.trackName || value.song?.title || value.entityUniqueId?.split(":").pop();
  const artist = value.artist?.name || value.artistName || value.subtitle?.simpleText || value.artists?.map?.(x => x.name).join(", ") || value.author?.name || "";
  const url = value.url || value.webUrl || value.uri || value.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || "";
  const externalId = value.videoId || value.trackId || value.songId || value.id || "";
  if (title && (externalId || url || artist)) out.push({ title: cleanText(title), artist: cleanText(artist), externalId: cleanText(externalId, 160), sourceUrl: cleanUrl(url) || "" });
  for (const v of Object.values(value)) collectTrackCandidates(v, out, depth + 1);
  return out;
}

function parsePage(html, provider, sourceUrl) {
  const jsons = extractJsonScripts(html);
  let candidates = [];
  for (const j of jsons) collectTrackCandidates(j, candidates);
  const dedup = new Map();
  for (const t of candidates) {
    const key = `${t.title.toLowerCase()}|${t.artist.toLowerCase()}|${t.externalId}`;
    if (!dedup.has(key) && t.title) dedup.set(key, { ...t, source: provider });
  }
  const tracks = [...dedup.values()].slice(0, 500);
  let name = "Импортированный плейлист";
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (titleMatch) name = cleanText(titleMatch[1].replace(/\s*[-|]\s*(Spotify|SoundCloud|YouTube Music|Apple Music).*$/i, ""), 120) || name;
  return { name, tracks, provider, sourceUrl };
}

async function fetchPlaylistPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "RedMusic/1.0 playlist-import" },
    });
    if (!response.ok) throw new Error(`Источник вернул HTTP ${response.status}`);
    const html = await response.text();
    if (html.length > 8_000_000) throw new Error("Страница источника слишком большая");
    return html;
  } finally { clearTimeout(timer); }
}

module.exports = function createPlaylistsRouter(db) {
  const router = express.Router();

  router.get("/sources", requireAuth, (_req, res) => {
    res.json({ sources: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.label, linkImport: true, oauth: false })) });
  });

  router.post("/import/preview", requireAuth, async (req, res) => {
    const sourceUrl = cleanUrl(req.body?.url);
    if (!sourceUrl) return res.status(400).json({ error: "Вставьте корректную публичную ссылку на плейлист" });
    const provider = detectProvider(sourceUrl);
    if (!provider) return res.status(400).json({ error: "Этот источник пока не поддерживается" });
    try {
      const html = await fetchPlaylistPage(sourceUrl);
      const result = parsePage(html, provider, sourceUrl);
      if (!result.tracks.length) return res.status(422).json({ error: "Не удалось найти треки в публичном плейлисте. Попробуйте другую публичную ссылку." });
      const vip = vipUser(db, req.userId);
      const tracks = result.tracks.map((t, i) => {
        const matched = findMatchedTrack(db, t.title, t.artist);
        return { ...t, position: i, matchedTrackId: matched?.id || null, playableInRedMusic: !!matched, offlineRequested: vip, offlineAvailable: !!(vip && matched) };
      });
      const info = db.prepare(`INSERT INTO playlist_imports(user_id,source,source_url,playlist_name,track_count,status) VALUES(?,?,?,?,?,?)`).run(req.userId, provider, sourceUrl, result.name, tracks.length, "preview");
      res.json({ ok: true, importId: Number(info.lastInsertRowid), provider, providerName: PROVIDERS[provider].label, playlistName: result.name, vip, tracks });
    } catch (e) {
      res.status(502).json({ error: `Не удалось получить плейлист: ${e.message}` });
    }
  });

  router.post("/import/save", requireAuth, (req, res) => {
    const sourceUrl = cleanUrl(req.body?.sourceUrl);
    const source = detectProvider(sourceUrl || "") || cleanText(req.body?.source, 40).toLowerCase();
    const name = cleanText(req.body?.name, 120) || "Импортированный плейлист";
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, 500) : [];
    if (!sourceUrl || !PROVIDERS[source] || !tracks.length) return res.status(400).json({ error: "Недостаточно данных для сохранения плейлиста" });
    const vip = vipUser(db, req.userId);
    const playlistInfo = db.prepare(`INSERT INTO playlists(user_id,name,source,source_url) VALUES(?,?,?,?)`).run(req.userId, name, source, sourceUrl);
    const playlistId = Number(playlistInfo.lastInsertRowid);
    const insert = db.prepare(`INSERT INTO playlist_tracks(playlist_id,position,title,artist,album,source,external_id,source_url,track_key,matched_track_id,offline_requested,offline_available) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      tracks.forEach((t, i) => {
        const title = cleanText(t.title, 180);
        if (!title) return;
        const artist = cleanText(t.artist, 180);
        const matched = findMatchedTrack(db, title, artist);
        insert.run(playlistId, i, title, artist, cleanText(t.album, 180), source, cleanText(t.externalId,160), cleanUrl(t.sourceUrl) || sourceUrl, cleanText(t.trackKey, 200), matched?.id || null, vip ? 1 : 0, vip && matched ? 1 : 0);
      });
    });
    tx();
    db.prepare(`UPDATE playlist_imports SET status='saved' WHERE user_id=? AND source=? AND source_url=? AND status='preview'`).run(req.userId, source, sourceUrl);
    logAction(db, req.userId, "playlist_import", `Импортирован плейлист «${name}» (${source})`);
    res.json({ ok: true, playlistId, vip, offlineRequested: vip });
  });

  router.get("/mine", requireAuth, (req, res) => {
    const playlists = db.prepare(`SELECT p.*, COUNT(pt.id) AS track_count FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id WHERE p.user_id=? GROUP BY p.id ORDER BY p.updated_at DESC`).all(req.userId);
    res.json({ playlists });
  });

  router.get("/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID плейлиста" });
    const playlist = db.prepare("SELECT * FROM playlists WHERE id=? AND user_id=?").get(id, req.userId);
    if (!playlist) return res.status(404).json({ error: "Плейлист не найден" });
    const tracks = db.prepare(`SELECT pt.*, t.filename AS matched_filename, t.mime_type AS matched_mime FROM playlist_tracks pt LEFT JOIN tracks t ON t.id=pt.matched_track_id WHERE pt.playlist_id=? ORDER BY pt.position`).all(id);
    res.json({ playlist, tracks });
  });

  router.delete("/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID плейлиста" });
    const info = db.prepare("DELETE FROM playlists WHERE id=? AND user_id=?").run(id, req.userId);
    if (!info.changes) return res.status(404).json({ error: "Плейлист не найден" });
    res.json({ ok: true });
  });

  return router;
};
