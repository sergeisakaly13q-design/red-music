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
function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(feat\.?|ft\.?|featuring)\b/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatchedTrack(db, title, artist) {
  const t = normalizeMatchText(title);
  const a = normalizeMatchText(artist);
  if (!t) return null;

  // Fast exact lookup first.
  let row = db.prepare(`
    SELECT * FROM tracks
    WHERE lower(title)=? AND lower(coalesce(artist,''))=?
    ORDER BY id DESC LIMIT 1
  `).get(cleanText(title, 180).toLowerCase(), cleanText(artist, 180).toLowerCase());
  if (row) return row;

  // Normalize punctuation/feat./diacritics so imported metadata from Spotify,
  // YouTube Music, Apple Music, etc. can still match our own catalog.
  const rows = db.prepare(`SELECT * FROM tracks ORDER BY id DESC LIMIT 5000`).all();
  let best = null;
  let bestScore = 0;
  for (const candidate of rows) {
    const ct = normalizeMatchText(candidate.title);
    if (!ct || ct !== t) continue;
    const ca = normalizeMatchText(candidate.artist);
    if (a && ca === a) return candidate;
    if (!a || !ca) {
      if (bestScore < 2) { best = candidate; bestScore = 2; }
      continue;
    }
    const artistParts = new Set(a.split(" ").filter(Boolean));
    const candidateParts = new Set(ca.split(" ").filter(Boolean));
    const overlap = [...artistParts].filter(x => candidateParts.has(x)).length;
    const score = overlap / Math.max(artistParts.size, candidateParts.size, 1);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

function spotifyPlaylistId(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex(x => x.toLowerCase() === "playlist");
    return i >= 0 && parts[i + 1] ? decodeURIComponent(parts[i + 1]).split("?")[0] : null;
  } catch (_) { return null; }
}

let spotifyTokenCache = { token: "", expiresAt: 0 };

async function getSpotifyApiToken() {
  const clientId = String(process.env.SPOTIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SPOTIFY_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  if (spotifyTokenCache.token && Date.now() < spotifyTokenCache.expiresAt - 30_000) return spotifyTokenCache.token;

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error(`Spotify авторизация вернула HTTP ${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error("Spotify не вернул access token");
  spotifyTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return spotifyTokenCache.token;
}

function spotifyTrackFromApiItem(item) {
  if (!item || typeof item !== "object") return null;
  const track = item.item || item.track || item;
  if (!track || typeof track !== "object") return null;
  const title = track.name || "";
  if (!title) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists.map(a => a?.name).filter(Boolean).join(", ")
    : "";
  const id = track.id || "";
  const sourceUrl = track.external_urls?.spotify || (id ? `https://open.spotify.com/track/${encodeURIComponent(id)}` : "");
  return {
    title: cleanText(title),
    artist: cleanText(artists),
    album: cleanText(track.album?.name || "", 180),
    externalId: cleanText(id, 160),
    sourceUrl: cleanUrl(sourceUrl) || "",
    source: "spotify"
  };
}

async function fetchSpotifyPlaylistViaApi(sourceUrl) {
  const playlistId = spotifyPlaylistId(sourceUrl);
  const token = await getSpotifyApiToken();
  if (!playlistId || !token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { Authorization: `Bearer ${token}`, "User-Agent": "RedMusic/1.0 playlist-import" };
    const infoResponse = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=name,id,external_urls,items.total`, { headers, signal: controller.signal });
    if (!infoResponse.ok) throw new Error(`Spotify playlist вернул HTTP ${infoResponse.status}`);
    const info = await infoResponse.json();
    const tracks = [];
    let next = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items?limit=100&offset=0&additional_types=track`;
    while (next && tracks.length < 10000) {
      const response = await fetch(next, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`Spotify tracks вернул HTTP ${response.status}`);
      const data = await response.json();
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const track = spotifyTrackFromApiItem(item);
        if (track) tracks.push(track);
      }
      next = data.next || null;
    }
    if (!tracks.length) throw new Error("Spotify API не вернул ни одного доступного трека");
    return {
      name: cleanText(info.name || "Импортированный плейлист", 120),
      tracks,
      provider: "spotify",
      sourceUrl,
      total: Number(info.items?.total || tracks.length)
    };
  } finally { clearTimeout(timer); }
}

function parseSpotifyEmbedTracks(html) {
  // IMPORTANT: do not try to reconstruct a playlist by pairing arbitrary
  // "name" / "artist" fields near every spotify:track URI. That heuristic
  // produces duplicates (for example the same track repeated for every URI).
  // A complete Spotify playlist import requires the official Web API path.
  // Keep this fallback intentionally conservative: only accept explicit,
  // self-contained track objects that contain their own Spotify track id.
  const candidates = [];
  const jsons = extractJsonScripts(html);

  function walk(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, seen);
      return;
    }

    const id = value.id || value.trackId || value.uri?.match?.(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
    const title = value.name || value.title;
    const artist = Array.isArray(value.artists)
      ? value.artists.map(a => a?.name).filter(Boolean).join(", ")
      : (value.artist?.name || value.artistName || value.subtitle || "");

    if (typeof title === "string" && title.trim() && typeof id === "string" && /^[A-Za-z0-9]{22}$/.test(id)) {
      candidates.push({
        title,
        artist,
        album: value.album?.name || value.album || "",
        externalId: id,
        sourceUrl: `https://open.spotify.com/track/${id}`,
        source: "spotify"
      });
    }

    for (const child of Object.values(value)) walk(child, seen);
  }

  for (const j of jsons) walk(j);

  const dedup = new Map();
  for (const item of candidates) {
    const title = cleanText(item.title, 180);
    const artist = cleanText(item.artist, 180);
    const id = cleanText(item.externalId, 160);
    if (!title || !id) continue;
    if (!dedup.has(id)) {
      dedup.set(id, {
        title,
        artist,
        album: cleanText(item.album || "", 180),
        externalId: id,
        sourceUrl: `https://open.spotify.com/track/${encodeURIComponent(id)}`,
        source: "spotify"
      });
    }
  }
  return [...dedup.values()].slice(0, 10000);
}

async function fetchSpotifyPlaylist(sourceUrl) {
  const playlistId = spotifyPlaylistId(sourceUrl);
  if (!playlistId) throw new Error("Не удалось распознать ID Spotify-плейлиста");

  // Preferred path when the server has Spotify Web API credentials.
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      const result = await fetchSpotifyPlaylistViaApi(sourceUrl);
      if (result?.tracks?.length) return result;
    } catch (apiError) {
      console.warn("[playlist-import] Spotify Web API failed, trying public embed:", apiError.message);
    }
  }

  // Free fallback: Spotify's public embed page contains __NEXT_DATA__ with
  // playlist track metadata. We only read metadata; no Spotify audio is
  // downloaded or proxied.
  const embedUrl = `https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}`;
  const html = await fetchPlaylistPage(embedUrl);
  const jsons = extractJsonScripts(html);
  const candidates = [];

  function addTrack(item) {
    if (!item || typeof item !== "object") return;
    const id =
      item.id ||
      item.trackId ||
      item.uri?.match?.(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] ||
      item.uri?.match?.(/spotify:track:([A-Za-z0-9]{22})/)?.[1] ||
      item.entityUniqueId?.match?.(/spotify:track:([A-Za-z0-9]{22})/)?.[1];
    const title = item.name || item.title || item.track?.name || item.song?.name;
    const artist = Array.isArray(item.artists)
      ? item.artists.map(a => a?.name || a?.artist?.name).filter(Boolean).join(", ")
      : (item.artist?.name || item.artistName || item.track?.artists?.map?.(a => a?.name).filter(Boolean).join(", ") || "");
    if (!id || !/^[A-Za-z0-9]{22}$/.test(String(id)) || !title) return;
    const album = item.album?.name || item.track?.album?.name || item.albumName || "";
    const images = item.album?.images || item.images || item.track?.album?.images || [];
    const thumbnailUrl = images[0]?.url || item.imageUrl || item.thumbnailUrl || "";
    candidates.push({
      title: cleanText(title),
      artist: cleanText(artist),
      album: cleanText(album, 180),
      externalId: cleanText(String(id), 160),
      sourceUrl: `https://open.spotify.com/track/${encodeURIComponent(String(id))}`,
      thumbnailUrl: cleanUrl(thumbnailUrl) || "",
      source: "spotify"
    });
  }

  function walk(value, depth=0, seen=new Set()) {
    if (!value || depth > 16 || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const x of value) walk(x, depth + 1, seen);
      return;
    }
    // Spotify embed state commonly stores items in entity.trackList.
    if (Array.isArray(value.trackList)) value.trackList.forEach(addTrack);
    if (Array.isArray(value.items)) value.items.forEach(item => {
      addTrack(item);
      if (item?.track) addTrack(item.track);
    });
    addTrack(value);
    for (const child of Object.values(value)) walk(child, depth + 1, seen);
  }

  for (const j of jsons) walk(j);

  const dedup = new Map();
  for (const t of candidates) {
    if (!t.title || !t.externalId || dedup.has(t.externalId)) continue;
    dedup.set(t.externalId, t);
  }

  const tracks = [...dedup.values()].slice(0, 10000);
  if (!tracks.length) {
    throw new Error("Spotify не отдал список треков без API-ключей. Попробуйте публичный плейлист или добавьте Spotify API credentials на сервере.");
  }

  let name = "Импортированный плейлист";
  try {
    const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (titleMatch) name = cleanText(titleMatch[1].replace(/\s*[-|]\s*Spotify.*$/i, ""), 120) || name;
    for (const j of jsons) {
      const n = j?.props?.pageProps?.state?.data?.entity?.name ||
                j?.props?.pageProps?.state?.data?.entity?.title ||
                j?.props?.pageProps?.state?.data?.entity?.playlist?.name;
      if (n) { name = cleanText(n, 120); break; }
    }
  } catch (_) {}

  return { name, tracks, provider: "spotify", sourceUrl, total: tracks.length };
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
  if (!value || depth > 14 || out.length >= 10000) return out;
  if (Array.isArray(value)) { for (const x of value) collectTrackCandidates(x, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  const title = value.title?.simpleText || value.title?.runs?.map(x => x.text).join("") || value.name || value.trackName || value.song?.title || value.entityUniqueId?.split(":").pop();
  const artist = value.artist?.name || value.artistName || value.subtitle?.simpleText || value.artists?.map?.(x => x.name).join(", ") || value.author?.name || "";
  const url = value.url || value.webUrl || value.uri || value.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || "";
  const externalId = value.videoId || value.trackId || value.songId || value.id || "";
  if (title && (externalId || url || artist)) out.push({
    title: cleanText(title),
    artist: cleanText(artist),
    externalId: cleanText(externalId, 160),
    sourceUrl: cleanUrl(url) || "",
    thumbnailUrl: cleanUrl(value.thumbnailUrl || value.imageUrl || value.thumbnail?.url || value.image?.url || value.coverUrl || "") || ""
  });
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
    if (!dedup.has(key) && t.title) dedup.set(key, {
      ...t,
      source: provider,
      sourceUrl: t.sourceUrl || sourceUrl
    });
  }
  const tracks = [...dedup.values()].slice(0, 10000);
  let name = "Импортированный плейлист";
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (titleMatch) name = cleanText(titleMatch[1].replace(/\s*[-|]\s*(Spotify|SoundCloud|YouTube Music|Apple Music|Yandex Music).*$/i, ""), 120) || name;
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
  const cover = track.ogImage || track.coverUri || track.coverUrl || "";
  const normalizedCover = cover
    ? (String(cover).startsWith("http") ? String(cover) : `https://${String(cover).replace(/^https?:\/\//, "")}`)
    : "";
  return {
    title: cleanText(title),
    artist: cleanText(artists),
    album: cleanText(track.albums?.[0]?.title || track.album?.title || "", 180),
    externalId: cleanText(String(id), 160),
    sourceUrl: id ? `https://music.yandex.ru/track/${encodeURIComponent(String(id))}` : "",
    thumbnailUrl: cleanUrl(normalizedCover) || "",
    source: "yandex"
  };
}

async function fetchYandexPlaylist(sourceUrl) {
  const parsed = parseYandexPlaylistUrl(sourceUrl);
  if (!parsed) throw new Error("Не удалось распознать публичную ссылку Yandex Music");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    let endpoint;
    if (parsed.owner && parsed.kind) {
      const params = new URLSearchParams({
        owner: parsed.owner,
        kinds: parsed.kind,
        light: "true",
        madeFor: "",
        withLikesCount: "true",
        lang: "ru",
        "external-domain": "music.yandex.ru",
        overembed: "false"
      });
      endpoint = `https://music.yandex.ru/handlers/playlist.jsx?${params.toString()}`;
    } else {
      endpoint = `https://api.music.yandex.net/playlist/${encodeURIComponent(parsed.uuid)}`;
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
    const rawTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
    const tracks = rawTracks.map(yandexTrackFromValue).filter(Boolean).slice(0, 10000);
    const name = cleanText(playlist?.title || playlist?.name || "Импортированный плейлист", 120);
    if (!tracks.length) throw new Error("Не удалось найти треки в публичном плейлисте Yandex Music");
    return { name, tracks, provider: "yandex", sourceUrl };
  } finally { clearTimeout(timer); }
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
      const result = provider === "spotify"
        ? await fetchSpotifyPlaylist(sourceUrl)
        : provider === "yandex"
          ? await fetchYandexPlaylist(sourceUrl)
          : parsePage(await fetchPlaylistPage(sourceUrl), provider, sourceUrl);
      if (!result.tracks.length) return res.status(422).json({ error: `Не удалось найти треки в публичном плейлисте ${PROVIDERS[provider].label}. Проверьте, что ссылка ведёт на публичный плейлист, и попробуйте снова.` });
      const vip = req.userId ? vipUser(db, req.userId) : false;
      const tracks = result.tracks.map((t, i) => {
        const matched = findMatchedTrack(db, t.title, t.artist);
        return {
          ...t,
          position: i,
          matchedTrackId: matched?.id || null,
          playableInRedMusic: !!matched,
          external: !matched,
          externalUrl: matched ? "" : (t.sourceUrl || sourceUrl || ""),
          offlineRequested: vip,
          offlineAvailable: !!(vip && matched),
          offlineNote: vip && matched
            ? "VIP: можно скачать трек Red Music для офлайн-прослушивания"
            : "Офлайн-прослушивание доступно только VIP; внешние треки не скачиваются"
        };
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
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, 10000) : [];
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
    db.prepare(`UPDATE playlist_imports SET status='saved' WHERE user_id=? AND source=? AND source_url=? AND status='preview'`).run(owner.userId, source, sourceUrl);
    logAction(db, owner.userId, "playlist_import", `Импортирован плейлист «${name}» (${source})${owner.guest ? " [guest]" : ""}`);
    const savedRows = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN matched_track_id IS NOT NULL THEN 1 ELSE 0 END) AS matched FROM playlist_tracks WHERE playlist_id=?`).get(playlistId);
    res.json({ ok: true, playlistId, vip, guest: owner.guest, offlineRequested: vip, total: Number(savedRows.total || 0), matched: Number(savedRows.matched || 0), external: Math.max(0, Number(savedRows.total || 0) - Number(savedRows.matched || 0)) });
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
    if (!info.changes) return res.status(404).json({ error: "Плейлист не найден", stale: true });
    res.json({ ok: true });
  });

  return router;
};
