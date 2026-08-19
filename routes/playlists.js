const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { logAction } = require("../db/audit");

const PROVIDERS = {
  spotify: { label: "Spotify", hosts: ["open.spotify.com", "spotify.com"] },
  soundcloud: { label: "SoundCloud", hosts: ["soundcloud.com", "snd.sc"] },
  "youtube-music": { label: "YouTube Music", hosts: ["music.youtube.com", "youtube.com", "youtu.be"] },
  apple: { label: "Apple Music", hosts: ["music.apple.com", "itunes.apple.com"] },
  yandex: { label: "Yandex Music", hosts: ["music.yandex.ru", "music.yandex.com", "music.yandex.kz", "music.yandex.ua", "music.yandex.by"] },
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
  const pushJson = (raw) => {
    if (!raw || out.length >= 80) return;
    const text = String(raw).trim();
    try {
      out.push(JSON.parse(text));
      return;
    } catch (_) {}
    // Some providers HTML-escape JSON before putting it into a script tag.
    try {
      const decoded = text
        .replace(/\\\\u0026/g, "&")
        .replace(/\\\\u003c/gi, "<")
        .replace(/\\\\u003e/gi, ">")
        .replace(/\\\\u0027/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      out.push(JSON.parse(decoded));
    } catch (_) {}
  };

  const patterns = [
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["'](?:__NEXT_DATA__|initial-state|data)["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*>\s*(?:window\.)?(?:ytInitialData|ytInitialPlayerResponse)\s*=\s*([\s\S]*?);?\s*<\/script>/gi,
    /<script[^>]*>\s*(?:window\.)?__sc_hydration\s*=\s*([\s\S]*?);?\s*<\/script>/gi,
    /<script[^>]*>\s*(?:window\.)?(?:Spotify|spotify)[^=]*=\s*([\s\S]*?);?\s*<\/script>/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) && out.length < 80) pushJson(m[1]);
  }

  // SoundCloud commonly embeds hydration JSON without a stable script id.
  const hydration = /<script[^>]*>([\s\S]*?__sc_hydration[\s\S]*?)<\/script>/gi;
  let hm;
  while ((hm = hydration.exec(html)) && out.length < 80) {
    const raw = hm[1];
    const marker = raw.indexOf("[");
    if (marker >= 0) pushJson(raw.slice(marker));
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

  // A few providers put useful data in HTML attributes instead of JSON.
  // These are only fallbacks; the normal JSON/continuation parsers run first.
  const absoluteUrls = html.match(/https?:\/\/[^"'<>\s]{10,500}/g) || [];
  for (const rawUrl of absoluteUrls.slice(0, 300)) {
    if (!/(spotify|soundcloud|youtube|music\.apple|yandex)/i.test(rawUrl)) continue;
    const decoded = rawUrl.replace(/&amp;/g, "&");
    const id = decoded.match(/(?:v=|track\/|song\/|video\/|playlist\/|tracks\/)([A-Za-z0-9._:-]{3,160})/i)?.[1] || "";
    if (id) candidates.push({ title: "", artist: "", externalId: id, sourceUrl: cleanUrl(decoded) || "" });
  }

  const dedup = new Map();
  for (const t of candidates) {
    if (!t.title) continue;
    const key = `${t.title.toLowerCase()}|${t.artist.toLowerCase()}|${t.externalId}`;
    if (!dedup.has(key)) dedup.set(key, { ...t, source: provider });
  }

  const tracks = [...dedup.values()].slice(0, 5000);
  let name = "Импортированный плейлист";
  const titleMatch = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  if (titleMatch) {
    name = cleanText(
      titleMatch[1].replace(/\s*[-|]\s*(Spotify|SoundCloud|YouTube Music|Apple Music|Yandex Music).*$/i, ""),
      120
    ) || name;
  }
  return { name, tracks, provider, sourceUrl };
}

function parseYandexPlaylistUrl(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const usersIndex = parts.findIndex(x => x.toLowerCase() === "users");
    if (usersIndex >= 0 && parts[usersIndex + 1] && parts[usersIndex + 2]?.toLowerCase() === "playlists" && parts[usersIndex + 3]) {
      return { owner: decodeURIComponent(parts[usersIndex + 1]), kind: parts[usersIndex + 3] };
    }
    const playlistIndex = parts.findIndex(x => x.toLowerCase() === "playlists");
    if (playlistIndex >= 0 && parts[playlistIndex + 1]) {
      return { uuid: decodeURIComponent(parts[playlistIndex + 1]) };
    }
  } catch (_) {}
  return null;
}

function yandexTrackFromValue(value) {
  if (!value || typeof value !== "object") return null;
  const track = value.track || value;
  const title = track.title || track.name || "";
  const artists = Array.isArray(track.artists) ? track.artists.map(a => a?.name).filter(Boolean).join(", ") : (track.artist?.name || track.artistName || "");
  const id = track.id || track.trackId || "";
  if (!title) return null;
  return {
    title: cleanText(title),
    artist: cleanText(artists),
    externalId: cleanText(String(id), 160),
    sourceUrl: id ? `https://music.yandex.ru/track/${encodeURIComponent(String(id))}` : "",
    source: "yandex"
  };
}

async function fetchYandexPlaylist(sourceUrl) {
  const parsed = parseYandexPlaylistUrl(sourceUrl);
  if (!parsed) throw new Error("Не удалось распознать публичную ссылку Yandex Music");
  const pageSize = 100;
  const all = [];
  let name = "Импортированный плейлист";

  for (let page = 0; page < 50; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      let endpoint;
      const params = new URLSearchParams({
        light: "true",
        madeFor: "",
        withLikesCount: "true",
        lang: "ru",
        "external-domain": "music.yandex.ru",
        overembed: "false",
        page: String(page),
        pageSize: String(pageSize)
      });
      if (parsed.owner && parsed.kind) {
        params.set("owner", parsed.owner);
        params.set("kinds", parsed.kind);
        endpoint = `https://music.yandex.ru/handlers/playlist.jsx?${params.toString()}`;
      } else {
        endpoint = `https://api.music.yandex.net/playlist/${encodeURIComponent(parsed.uuid)}?${params.toString()}`;
      }

      const response = await fetch(endpoint, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "RedMusic/1.0 playlist-import",
          "accept": "application/json,text/plain,*/*"
        }
      });
      if (!response.ok) throw new Error(`Yandex Music вернул HTTP ${response.status}`);

      const json = await response.json();
      const playlist = json?.playlist || json?.result?.playlist || json?.result || json;
      name = cleanText(playlist?.title || playlist?.name || name, 120);

      const rawTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
      const pageTracks = rawTracks.map(yandexTrackFromValue).filter(Boolean);
      const before = all.length;
      const seen = new Set(all.map(t => `${t.externalId}|${t.title}|${t.artist}`));
      for (const t of pageTracks) {
        const key = `${t.externalId}|${t.title}|${t.artist}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(t);
        }
        if (all.length >= 5000) break;
      }

      if (!pageTracks.length || pageTracks.length < pageSize || all.length === before || all.length >= 5000) break;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!all.length) throw new Error("Не удалось найти треки в публичном плейлисте Yandex Music");
  return { name, tracks: all.slice(0, 5000), provider: "yandex", sourceUrl };
}

async function extractYouTubeContinuation(html) {
  // YouTube Music uses the same internal browse API as YouTube. We only use
  // public page data and the continuation token exposed by that page.
  const jsons = extractJsonScripts(html);
  let continuation = null;
  let context = null;
  let apiKey = null;

  const findFirst = (value, predicate, depth = 0) => {
    if (!value || depth > 20) return null;
    if (predicate(value)) return value;
    if (Array.isArray(value)) {
      for (const x of value) {
        const hit = findFirst(x, predicate, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const x of Object.values(value)) {
        const hit = findFirst(x, predicate, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };

  for (const j of jsons) {
    if (!continuation) {
      const hit = findFirst(j, v => v && typeof v === "object" && typeof v.continuationCommand?.token === "string");
      continuation = hit?.continuationCommand?.token || null;
    }
    if (!context) {
      const hit = findFirst(j, v => v && typeof v === "object" && v.client && typeof v.client.clientName === "string");
      context = hit || null;
    }
    if (!apiKey) {
      const hit = findFirst(j, v => typeof v === "string" && /^[A-Za-z0-9_-]{20,}$/.test(v));
      apiKey = hit || null;
    }
  }

  if (!apiKey) {
    const m = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    apiKey = m?.[1] || null;
  }
  if (!context) {
    const m = html.match(/"INNERTUBE_CONTEXT"\s*:\s*(\{[\s\S]*?\})\s*,\s*"INNERTUBE_CONTEXT_CLIENT_NAME"/);
    if (m) {
      try { context = JSON.parse(m[1]); } catch (_) {}
    }
  }
  return { continuation, context, apiKey };
}

async function fetchYouTubeMusicPlaylist(sourceUrl) {
  const firstHtml = await fetchPlaylistPage(sourceUrl);
  const first = parsePage(firstHtml, "youtube-music", sourceUrl);
  const state = await extractYouTubeContinuation(firstHtml);
  const all = [...first.tracks];
  const seen = new Set(all.map(t => `${t.externalId}|${t.title}|${t.artist}`));

  // If the public page already contains everything, avoid unnecessary API calls.
  if (!state.continuation || !state.apiKey || !state.context) {
    return first;
  }

  let token = state.continuation;
  let context = state.context;
  for (let page = 0; page < 100 && token && all.length < 5000; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(
        `https://music.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(state.apiKey)}&prettyPrint=false`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "user-agent": "RedMusic/1.0 playlist-import",
            "accept": "application/json"
          },
          body: JSON.stringify({ context, continuation: token })
        }
      );
      if (!response.ok) break;
      const json = await response.json();

      const candidates = [];
      collectTrackCandidates(json, candidates);
      for (const t of candidates) {
        if (!t.title) continue;
        const key = `${t.title.toLowerCase()}|${t.artist.toLowerCase()}|${t.externalId}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push({ ...t, source: "youtube-music" });
        }
        if (all.length >= 5000) break;
      }

      const next = extractContinuationToken(json);
      if (!next || next === token) break;
      token = next;
    } catch (_) {
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  return { ...first, tracks: all.slice(0, 5000) };
}

function extractContinuationToken(value, depth = 0) {
  if (!value || depth > 20) return null;
  if (Array.isArray(value)) {
    for (const x of value) {
      const hit = extractContinuationToken(x, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.continuationCommand?.token === "string") return value.continuationCommand.token;
  if (typeof value.nextContinuationData?.continuation === "string") return value.nextContinuationData.continuation;
  if (typeof value.continuation === "string" && value.continuation.length > 20) return value.continuation;
  for (const x of Object.values(value)) {
    const hit = extractContinuationToken(x, depth + 1);
    if (hit) return hit;
  }
  return null;
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


const GUEST_COOKIE = "rm_guest";
const GUEST_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function hashGuestToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function getExistingGuestUser(db, req) {
  const token = req.cookies?.[GUEST_COOKIE];
  if (!token || typeof token !== "string" || token.length < 32) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.banned
    FROM guest_sessions gs
    JOIN users u ON u.id = gs.user_id
    WHERE gs.token_hash = ?
    LIMIT 1
  `).get(hashGuestToken(token));
  if (!row || row.banned) return null;
  db.prepare("UPDATE guest_sessions SET last_seen_at=datetime('now') WHERE token_hash=?").run(hashGuestToken(token));
  return row;
}

function getOrCreateGuestUser(db, req, res) {
  if (req.userId) return { userId: Number(req.userId), guest: false };
  const existing = getExistingGuestUser(db, req);
  if (existing) return { userId: Number(existing.id), guest: true };

  const token = crypto.randomBytes(32).toString("hex");
  const username = `guest_${crypto.randomBytes(10).toString("hex")}`;
  const passwordHash = bcrypt.hashSync(crypto.randomBytes(48).toString("hex"), 8);
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO users(username,password_hash,password_disabled,display_name)
      VALUES(?,?,1,?)
    `).run(username, passwordHash, "Гость Red Music");
    const userId = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO guest_sessions(token_hash,user_id) VALUES(?,?)").run(hashGuestToken(token), userId);
    return userId;
  });
  const userId = tx();
  res.cookie(GUEST_COOKIE, token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: GUEST_COOKIE_MAX_AGE_MS,
    path: "/",
  });
  return { userId, guest: true };
}

module.exports = function createPlaylistsRouter(db) {
  const router = express.Router();

  // Public preview does not require a Red Music session — only saving the
  // playlist to a library does. optionalAuth still populates req.userId
  // when a valid session cookie is present, so logged-in users keep VIP
  // offline-matching in the preview, but an expired/missing/invalid
  // session must never surface as "Сессия недействительна" here.
  router.get("/sources", optionalAuth, (_req, res) => {
    res.json({ sources: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.label, linkImport: true, oauth: false })) });
  });

  router.post("/import/preview", optionalAuth, async (req, res) => {
    const sourceUrl = cleanUrl(req.body?.url);
    if (!sourceUrl) return res.status(400).json({ error: "Вставьте корректную публичную ссылку на плейлист" });
    const provider = detectProvider(sourceUrl);
    if (!provider) return res.status(400).json({ error: "Этот источник пока не поддерживается" });
    try {
      const result = provider === "yandex"
        ? await fetchYandexPlaylist(sourceUrl)
        : provider === "youtube-music"
          ? await fetchYouTubeMusicPlaylist(sourceUrl)
          : parsePage(await fetchPlaylistPage(sourceUrl), provider, sourceUrl);
      if (!result.tracks.length) return res.status(422).json({ error: `Не удалось найти треки в публичном плейлисте ${PROVIDERS[provider].label}. Проверьте, что ссылка ведёт на публичный плейлист, и попробуйте снова.` });
      const vip = req.userId ? vipUser(db, req.userId) : false;
      const tracks = result.tracks.map((t, i) => {
        const matched = findMatchedTrack(db, t.title, t.artist);
        return { ...t, position: i, matchedTrackId: matched?.id || null, playableInRedMusic: !!matched, offlineRequested: vip, offlineAvailable: !!(vip && matched) };
      });
      // History of the preview is only recorded for signed-in users —
      // playlist_imports.user_id is NOT NULL, and anonymous preview is
      // intentionally allowed, so there is nothing to log for guests.
      let importId = null;
      if (req.userId) {
        const info = db.prepare(`INSERT INTO playlist_imports(user_id,source,source_url,playlist_name,track_count,status) VALUES(?,?,?,?,?,?)`).run(req.userId, provider, sourceUrl, result.name, tracks.length, "preview");
        importId = Number(info.lastInsertRowid);
      }
      res.json({ ok: true, importId, provider, providerName: PROVIDERS[provider].label, playlistName: result.name, sourceUrl, vip, requiresLoginToSave: false, guestSaveSupported: true, tracks });
    } catch (e) {
      res.status(502).json({ error: `Не удалось получить плейлист из ${PROVIDERS[provider].label}: ${e.message}` });
    }
  });

  // Saving an imported public playlist never requires a Red Music password.
  // Logged-in users keep their account library; everyone else gets a private
  // device-scoped guest identity via an HttpOnly cookie.
  router.post("/import/save", optionalAuth, (req, res) => {
    const sourceUrl = cleanUrl(req.body?.sourceUrl);
    const source = detectProvider(sourceUrl || "") || cleanText(req.body?.source, 40).toLowerCase();
    const name = cleanText(req.body?.name, 120) || "Импортированный плейлист";
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, 5000) : [];
    if (!sourceUrl || !PROVIDERS[source] || !tracks.length) return res.status(400).json({ error: "Недостаточно данных для сохранения плейлиста" });

    const owner = getOrCreateGuestUser(db, req, res);
    const vip = owner.userId ? vipUser(db, owner.userId) : false;
    const playlistInfo = db.prepare(`INSERT INTO playlists(user_id,name,source,source_url) VALUES(?,?,?,?)`).run(owner.userId, name, source, sourceUrl);
    const playlistId = Number(playlistInfo.lastInsertRowid);
    const insert = db.prepare(`INSERT INTO playlist_tracks(playlist_id,position,title,artist,album,source,external_id,source_url,track_key,matched_track_id,offline_requested,offline_available) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      tracks.forEach((t, i) => {
        const title = cleanText(t.title, 180);
        if (!title) return;
        const artist = cleanText(t.artist, 180);
        const matched = findMatchedTrack(db, title, artist);
        // A missing Red Music match is allowed. The imported title/artist and
        // external source URL remain in the user's playlist as metadata.
        insert.run(playlistId, i, title, artist, cleanText(t.album, 180), source, cleanText(t.externalId,160), cleanUrl(t.sourceUrl) || sourceUrl, cleanText(t.trackKey, 200), matched?.id || null, vip ? 1 : 0, vip && matched ? 1 : 0);
      });
    });
    tx();
    const savedCount = Number(db.prepare("SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id=?").get(playlistId)?.c || 0);
    const matchedCount = Number(db.prepare("SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id=? AND matched_track_id IS NOT NULL").get(playlistId)?.c || 0);
    const externalCount = savedCount - matchedCount;
    db.prepare(`UPDATE playlist_imports SET status='saved', track_count=? WHERE user_id=? AND source=? AND source_url=? AND status='preview'`).run(savedCount, owner.userId, source, sourceUrl);
    logAction(db, owner.userId, "playlist_import", `Импортирован плейлист «${name}» (${source}), треков: ${savedCount}${owner.guest ? " [guest]" : ""}`);
    res.json({ ok: true, playlistId, vip, guest: owner.guest, offlineRequested: vip, totalReceived: tracks.length, savedCount, matchedCount, externalCount });
  });

  router.get("/mine", optionalAuth, (req, res) => {
    const owner = req.userId ? { userId: Number(req.userId) } : getExistingGuestUser(db, req);
    if (!owner) return res.json({ playlists: [] });
    const ownerId = Number(owner.userId || owner.id);
    const playlists = db.prepare(`
      SELECT p.*, COUNT(pt.id) AS track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id
      WHERE p.user_id=?
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `).all(ownerId);
    const trackStmt = db.prepare(`
      SELECT pt.*, t.filename AS matched_filename, t.mime_type AS matched_mime
      FROM playlist_tracks pt
      LEFT JOIN tracks t ON t.id=pt.matched_track_id
      WHERE pt.playlist_id=?
      ORDER BY pt.position
    `);
    for (const playlist of playlists) {
      playlist.tracks = trackStmt.all(playlist.id);
    }
    res.json({ playlists });
  });

  router.get("/:id", optionalAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID плейлиста" });
    const owner = req.userId ? { userId: Number(req.userId) } : getExistingGuestUser(db, req);
    if (!owner) return res.status(401).json({ error: "Плейлист недоступен" });
    const ownerId = Number(owner.userId || owner.id);
    const playlist = db.prepare("SELECT * FROM playlists WHERE id=? AND user_id=?").get(id, ownerId);
    if (!playlist) return res.status(404).json({ error: "Плейлист не найден" });
    const tracks = db.prepare(`SELECT pt.*, t.filename AS matched_filename, t.mime_type AS matched_mime FROM playlist_tracks pt LEFT JOIN tracks t ON t.id=pt.matched_track_id WHERE pt.playlist_id=? ORDER BY pt.position`).all(id);
    res.json({ playlist, tracks });
  });

  router.patch("/:id", optionalAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID плейлиста" });
    const owner = req.userId ? { userId: Number(req.userId) } : getExistingGuestUser(db, req);
    if (!owner) return res.status(401).json({ error: "Плейлист недоступен" });
    const ownerId = Number(owner.userId || owner.id);
    const name = cleanText(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: "Введите название плейлиста" });
    const info = db.prepare("UPDATE playlists SET name=?, updated_at=datetime('now') WHERE id=? AND user_id=?").run(name, id, ownerId);
    if (!info.changes) return res.status(404).json({ error: "Плейлист не найден" });
    res.json({ ok: true, name });
  });

  router.delete("/:id", optionalAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Некорректный ID плейлиста" });
    const owner = req.userId ? { userId: Number(req.userId) } : getExistingGuestUser(db, req);
    if (!owner) return res.status(401).json({ error: "Плейлист недоступен" });
    const ownerId = Number(owner.userId || owner.id);
    const info = db.prepare("DELETE FROM playlists WHERE id=? AND user_id=?").run(id, ownerId);
    if (!info.changes) return res.status(404).json({ error: "Плейлист не найден" });
    res.json({ ok: true });
  });

  return router;
};
