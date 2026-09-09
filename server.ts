import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";
import { sanitizeFileName, filterAndSortEpisodes, ParsedMedia } from "./cleaner.ts";

dotenv.config();

const app = express();

// Configuration du port :
// - Sur Render, Render injecte RENDER=true et la variable PORT (par défaut 10000).
// - Dans le conteneur AI Studio (où le proxy Nginx écoute sur 8080 et redirige vers 3000), le port 3000 est requis.
const isRender = process.env.RENDER === "true" || !!process.env.RENDER;
const PORT = isRender || (process.env.PORT && process.env.PORT !== "8080")
  ? parseInt(process.env.PORT || "10000", 10)
  : 3000;

app.use(cors());
app.use(express.json());

// --- TELEGRAM CLIENT SINGLETON (GramJS MTProto) ---
let tgClient: TelegramClient | null = null;
let tgConnectingPromise: Promise<TelegramClient | null> | null = null;

export async function getTelegramClient(): Promise<TelegramClient | null> {
  if (tgClient && tgClient.connected) {
    return tgClient;
  }
  if (tgConnectingPromise) {
    return tgConnectingPromise;
  }

  const apiId = parseInt(process.env.API_ID || "0", 10);
  const apiHash = process.env.API_HASH || "";
  const sessionStr = process.env.SESSION_STRING || "";

  if (!apiId || !apiHash || !sessionStr) {
    console.warn("Telegram credentials not found in env (API_ID, API_HASH, SESSION_STRING)");
    return null;
  }

  tgConnectingPromise = (async () => {
    try {
      const session = new StringSession(sessionStr);
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
      });
      await client.connect();
      tgClient = client;
      console.log("Connected to Telegram MTProto successfully");
      return client;
    } catch (err: any) {
      console.error("Failed to connect to Telegram MTProto:", err?.message || err);
      return null;
    } finally {
      tgConnectingPromise = null;
    }
  })();

  return tgConnectingPromise;
}

// --- ANTI-BAN / Cache logic matching main.py ---
const SEARCH_CACHE_TTL = 300; // 5 minutes in seconds
const RESULTS_PAGE_SIZE = 100;

export interface EpisodeItem extends ParsedMedia {
  message_id: number;
  title: string;
  file_name: string;
  size_mb: number;
  stream_url: string;
}

interface CacheEntry {
  data: {
    anime_info: AnimeMetadata;
    episodes: EpisodeItem[];
  };
  cached_at: number;
}

const _search_cache = new Map<string, CacheEntry>();

function getCachedSearch(cacheKey: string) {
  const cached = _search_cache.get(cacheKey);
  if (!cached) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now - cached.cached_at > SEARCH_CACHE_TTL) {
    _search_cache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function setCachedSearch(cacheKey: string, data: { anime_info: AnimeMetadata; episodes: EpisodeItem[] }) {
  const now = Math.floor(Date.now() / 1000);
  // Opportunistically drop expired entries
  for (const [k, v] of _search_cache.entries()) {
    if (now - v.cached_at > SEARCH_CACHE_TTL) {
      _search_cache.delete(k);
    }
  }
  _search_cache.set(cacheKey, { data, cached_at: now });
}

// --- Episode number extraction patterns from main.py ---
const EPISODE_NUMBER_PATTERNS = [
  /s(?:eason)?\s*\d{1,2}[\s._-]*(?:e(?:p(?:isode)?)?[\s._-]*)?(\d{1,4})/i, // S01E05, Season 1 Episode 05, Season 3 - 05
  /(?<![A-Za-z0-9])(?:episode|ep)[\s._-]*(\d{1,4})(?:v\d+)?(?![A-Za-z0-9])/i, // Episode 05, Ep.05, Ep_05
  /(?<![A-Za-z0-9])e[\s._-]*(\d{1,4})(?:v\d+)?(?![A-Za-z0-9])/i, // E05
  /(?:^|[\[\(\s._-])(\d{1,4})(?:v\d+)?(?:[\]\)\s._-]|$)/, // standalone "- 05 -", "[05]", "(05)"
];

export function extractEpisodeNumber(fileName: string): number | null {
  for (const pattern of EPISODE_NUMBER_PATTERNS) {
    const match = pattern.exec(fileName);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) {
        return num;
      }
    }
  }
  return null;
}

interface AnimeMetadata {
  title: string;
  cover: string | null;
  banner: string | null;
  synopsis: string;
  score: string;
  genres: string[];
  total_episodes_official: number | null;
  year: number | null;
}

export function getScore(episode: { title?: string; file_name?: string }, query: string): number {
  const q = query.toLowerCase().trim();
  const title = (episode.title || "").toLowerCase().trim();
  const fileName = (episode.file_name || "").toLowerCase().trim();

  if (title === q) return 1000;
  if (title.startsWith(q)) return 900;
  if (title.includes(q)) return 700;
  if (fileName.includes(q)) return 600;
  return 0;
}

const POPULAR_ANIME_CATALOG: Record<string, Partial<AnimeMetadata>> = {
  naruto: {
    title: "Naruto",
    cover: "https://media.kitsu.app/anime/poster_images/11/large.jpg",
    banner: "https://media.kitsu.app/anime/cover_images/11/large.jpg",
    synopsis: "Naruto Uzumaki, un jeune ninja farceur du village caché de Konoha, rêve de devenir Hokage, le chef du village.",
    score: "82.5%",
    genres: ["Action", "Aventure", "Ninja"],
    total_episodes_official: 220,
    year: 2002,
  },
  "naruto shippuden": {
    title: "Naruto: Shippuuden",
    cover: "https://media.kitsu.app/anime/poster_images/1555/large.jpg",
    banner: "https://media.kitsu.app/anime/cover_images/1555/large.jpg",
    synopsis: "Deux ans et demi après son départ avec Jiraiya, Naruto revient à Konoha pour affronter l'organisation criminelle Akatsuki.",
    score: "84.1%",
    genres: ["Action", "Aventure", "Shonen"],
    total_episodes_official: 500,
    year: 2007,
  },
  "one piece": {
    title: "One Piece",
    cover: "https://media.kitsu.app/anime/poster_images/12/large.jpg",
    banner: "https://media.kitsu.app/anime/cover_images/12/large.jpg",
    synopsis: "Monkey D. Luffy et son équipage de pirates sillonnent les mers à la recherche du trésor légendaire, le One Piece.",
    score: "85.2%",
    genres: ["Action", "Aventure", "Comédie"],
    total_episodes_official: 1100,
    year: 1999,
  },
  "attack on titan": {
    title: "Attack on Titan (L'Attaque des Titans)",
    cover: "https://media.kitsu.app/anime/poster_images/7442/large.jpg",
    banner: "https://media.kitsu.app/anime/cover_images/7442/large.jpg",
    synopsis: "Dans un monde assiégé par de monstrueux Titans, Eren Jaeger s'enrôle dans le Bataillon d'exploration pour reconquérir la liberté.",
    score: "87.0%",
    genres: ["Action", "Drame", "Mystère"],
    total_episodes_official: 25,
    year: 2013,
  },
  "solo leveling": {
    title: "Solo Leveling",
    cover: "https://media.kitsu.app/anime/poster_images/46123/large.jpg",
    banner: "https://media.kitsu.app/anime/cover_images/46123/large.jpg",
    synopsis: "Sung Jinwoo, chasseur de rang E connu comme le plus faible de toute l'humanité, reçoit une quête secrète qui change son destin.",
    score: "86.4%",
    genres: ["Action", "Fantasy"],
    total_episodes_official: 12,
    year: 2024,
  },
  "demon slayer": {
    title: "Demon Slayer: Kimetsu no Yaiba",
    cover: "https://media.kitsu.app/anime/poster_images/41370/large.jpg",
    banner: "https://media.kitsu.app/anime/cover_images/41370/large.jpg",
    synopsis: "Tanjiro Kamado entreprend un voyage périlleux pour trouver un remède à la malédiction de sa sœur Nezuko, devenue démone.",
    score: "86.8%",
    genres: ["Action", "Démons", "Historique"],
    total_episodes_official: 26,
    year: 2019,
  },
};

// --- Anime Metadata Fetcher (Fast catalog + Kitsu API + AniList Fallback + Local SVG Fallback) ---
async function fetchAnimeMetadata(query: string): Promise<AnimeMetadata> {
  const cleanQ = query.trim();
  const lowerQ = cleanQ.toLowerCase();

  // 1. Instant match in popular catalog
  for (const [key, preset] of Object.entries(POPULAR_ANIME_CATALOG)) {
    if (lowerQ === key || lowerQ.includes(key) || key.includes(lowerQ)) {
      return {
        title: preset.title || cleanQ,
        cover: preset.cover || null,
        banner: preset.banner || null,
        synopsis: preset.synopsis || "Résumé non disponible.",
        score: preset.score || "85%",
        genres: preset.genres || ["Anime"],
        total_episodes_official: preset.total_episodes_official || 24,
        year: preset.year || 2024,
      };
    }
  }

  // 2. Try Kitsu API (Reliable, fast, returns real posters and ratings)
  try {
    const kitsuUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(cleanQ)}&page[limit]=1`;
    const response = await fetch(kitsuUrl, {
      headers: { Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json" },
      signal: AbortSignal.timeout(8000),
    });

    if (response.ok) {
      const json: any = await response.json();
      const item = json?.data?.[0]?.attributes;
      if (item) {
        return {
          title: item.canonicalTitle || cleanQ,
          cover: item.posterImage?.large || item.posterImage?.medium || item.posterImage?.original || null,
          banner: item.coverImage?.large || item.coverImage?.original || null,
          synopsis: item.synopsis || "Aucun résumé disponible.",
          score: item.averageRating ? `${parseFloat(item.averageRating).toFixed(1)}%` : "N/A",
          genres: ["Anime", "Shonen"],
          total_episodes_official: item.episodeCount ?? 24,
          year: item.startDate ? parseInt(item.startDate.split("-")[0], 10) : null,
        };
      }
    }
  } catch (err) {
    console.warn("Kitsu fetch failed or timed out:", err);
  }

  // 3. Try AniList as fallback
  try {
    const graphqlQuery = `
      query ($search: String) {
        Media (search: $search, type: ANIME) {
          title { romaji english }
          coverImage { extraLarge large }
          bannerImage
          description(asHtml: false)
          averageScore genres episodes status seasonYear
        }
      }
    `;
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: graphqlQuery, variables: { search: cleanQ } }),
      signal: AbortSignal.timeout(3000),
    });

    if (response.ok) {
      const json: any = await response.json();
      const media = json?.data?.Media;
      if (media) {
        return {
          title: media.title?.english || media.title?.romaji || cleanQ,
          cover: media.coverImage?.extraLarge || media.coverImage?.large || null,
          banner: media.bannerImage || null,
          synopsis: media.description || "Aucun résumé disponible.",
          score: `${media.averageScore ?? "N/A"}%`,
          genres: media.genres || [],
          total_episodes_official: media.episodes ?? 24,
          year: media.seasonYear ?? null,
        };
      }
    }
  } catch (err) {
    console.warn("AniList fallback also failed:", err);
  }

  // 4. Guaranteed clean SVG fallback cover (never broken, loads instantly)
  const svgCover = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="%23161b22"/><rect x="15" y="15" width="270" height="420" rx="8" fill="%230d1117" stroke="%2330363d" stroke-width="2"/><text x="150" y="210" fill="%2358a6ff" font-size="20" font-family="sans-serif" font-weight="bold" text-anchor="middle">NLSbox Anime</text><text x="150" y="245" fill="%23c9d1d9" font-size="14" font-family="sans-serif" text-anchor="middle">${encodeURIComponent(cleanQ.slice(0, 20))}</text></svg>`;

  return {
    title: cleanQ.charAt(0).toUpperCase() + cleanQ.slice(1),
    cover: svgCover,
    banner: null,
    synopsis: "Catalogue d'épisodes issus des canaux Telegram.",
    score: "85%",
    genres: ["Anime"],
    total_episodes_official: 24,
    year: 2024,
  };
}

// Real MP4 sample buffer generated with ffmpeg for testing Range requests and video streaming
function getSampleVideoBuffer(): Buffer {
  try {
    const samplePath = path.join(process.cwd(), "sample.mp4");
    if (fs.existsSync(samplePath)) {
      return fs.readFileSync(samplePath);
    }
  } catch (err) {
    console.warn("Could not read sample.mp4 from disk, falling back to generated buffer", err);
  }
  return Buffer.alloc(512 * 1024);
}

const sampleVideoData = getSampleVideoBuffer();

// --- ROUTES ---

// 1. Home endpoint - Always renders HTML interactive dashboard unless format=json is explicitly requested
app.get("/", (req: Request, res: Response) => {
  const accept = req.headers.accept || "";
  const wantsJson = req.query.format === "json" || (accept === "application/json" && !accept.includes("text/html"));
  if (wantsJson) {
    return res.json({ status: "En ligne - Sanitizer & Tri V2 OK", app: "NLSbox Backend Pro" });
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Moteur de streaming et recherche d'animes connecté directement à Telegram MTProto avec support des requêtes HTTP Range 206 et dépollution des métadonnées">
  <title>NLSbox Pro Engine</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --accent-hover: #79c0ff;
      --badge-bg: #238636;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 24px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    h1 { font-size: 24px; font-weight: 600; color: #fff; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 20px;
      background: var(--badge-bg);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .search-box {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    input {
      flex: 1;
      min-width: 200px;
      padding: 10px 14px;
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fff;
      font-size: 14px;
    }
    input:focus { outline: none; border-color: var(--accent); }
    button {
      padding: 10px 20px;
      background: #238636;
      border: none;
      border-radius: 6px;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #2ea043; }
    .api-preview {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-family: monospace;
      font-size: 13px;
      overflow-x: auto;
      color: #7ee787;
      margin-top: 12px;
    }
    .anime-card {
      display: flex;
      gap: 20px;
      margin-top: 20px;
    }
    .anime-card img {
      width: 140px;
      height: 200px;
      object-fit: cover;
      border-radius: 6px;
    }
    .anime-details h3 { color: #fff; margin-bottom: 8px; }
    .anime-details p { font-size: 14px; color: var(--text-muted); margin-bottom: 8px; }
    .episodes-list {
      margin-top: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .episode-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 14px;
      transition: border-color 0.2s;
    }
    .episode-item:hover {
      border-color: #388bfd;
    }
    .episode-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tag-ep {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      background: #1f6feb22;
      color: #58a6ff;
      border: 1px solid #1f6feb55;
      font-weight: 600;
      font-size: 12px;
    }
    .tag-quality {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      background: #23863622;
      color: #3fb950;
      border: 1px solid #23863655;
      font-size: 11px;
      font-weight: 600;
    }
    .tag-lang {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      background: #a371f722;
      color: #d2a8ff;
      border: 1px solid #a371f755;
      font-size: 11px;
      font-weight: 600;
    }
    .raw-info {
      font-size: 11px;
      color: #8b949e;
      margin-top: 4px;
      font-family: monospace;
      word-break: break-all;
    }
    .episode-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 13px;
      margin-left: 12px;
    }
    .episode-link:hover { text-decoration: underline; }
    .quick-chips {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .chip {
      padding: 4px 10px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 16px;
      color: #c9d1d9;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .chip:hover {
      background: #30363d;
      color: #fff;
    }
    .feature-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      background: #161b22;
      border: 1px solid #30363d;
      font-size: 12px;
      color: #8b949e;
    }
    .feature-badge strong {
      color: #58a6ff;
    }
    video {
      width: 100%;
      max-height: 360px;
      background: #000;
      border-radius: 6px;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>NLSbox Pro Backend Engine</h1>
        <p style="color: var(--text-muted); font-size: 13px;">Streaming & Téléchargement Universel Telegram : Musique, Vidéos, Films, Séries, Scans, Documents</p>
      </div>
      <div>
        <span class="badge">MTProto Direct • Range 206 Actif</span>
      </div>
    </header>

    <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px;">
      <div class="feature-badge">
        <span>⚡</span> <strong>Streaming Turbo 206</strong> (Scrubbing instantané)
      </div>
      <div class="feature-badge">
        <span>🎵</span> <strong>Lecteur Audio & Vidéo</strong> (MP3, MP4, FLAC, MKV)
      </div>
      <div class="feature-badge">
        <span>📥</span> <strong>Téléchargement Direct</strong> (Fichiers d'origine préservés)
      </div>
      <div class="feature-badge">
        <span>📁</span> <strong>Tous Canaux Telegram</strong> (Multimédia sans limite)
      </div>
    </div>

    <div id="tgAccountBox" style="margin-bottom: 20px; padding: 12px 18px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="height: 10px; width: 10px; border-radius: 50%; background: #3fb950; display: inline-block; box-shadow: 0 0 8px #3fb950;"></span>
        <strong id="tgAccountText" style="color: #fff;">Telegram MTProto : Connexion en cours...</strong>
      </div>
      <span id="tgAccountDetails" style="color: var(--text-muted); font-family: monospace;">Chargement de la session...</span>
    </div>

    <div id="errorBox" style="display: none; padding: 12px 16px; background: #3d1b22; border: 1px solid #da3633; border-radius: 6px; color: #ff7b72; font-size: 14px; margin-bottom: 20px;"></div>

    <div class="card">
      <h2 style="font-size: 16px; margin-bottom: 12px; color: #fff;">Exploration & Recherche Multimédia Telegram</h2>
      
      <div class="search-box">
        <input type="text" id="queryInput" value="" placeholder="Rechercher un fichier, musique, film, série, scan... (ou vide pour tout voir)">
        
        <select id="channelSelect" onchange="onChannelSelected(this.value)" style="padding: 10px 14px; background: #0d1117; border: 1px solid var(--border); color: #c9d1d9; border-radius: 6px; font-size: 14px; min-width: 220px; max-width: 320px;">
          <option value="-1004272203145" selected>📁 NLSbox (-1004272203145)</option>
          <option value="-1003914934147">🎵 NLSmusic1 (-1003914934147)</option>
          <option value="-1003222560776">🎵 Music World (-1003222560776)</option>
          <option value="-1001558851926">🎬 Anime zone VF (-1001558851926)</option>
          <option value="-1002297137971">🎬 Ciné+ VF (-1002297137971)</option>
          <option value="-1001120630831">📄 Scan Zone (-1001120630831)</option>
          <option value="custom">✏️ Saisir un autre ID ou @canal...</option>
        </select>

        <input type="text" id="channelInput" value="-1004272203145" placeholder="ID (ex: -1004272203145) ou @canal..." style="max-width: 220px; display: none;">
        <button id="searchBtn" onclick="runSearch()">Explorer</button>
      </div>

      <!-- Filtres par catégorie -->
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px;">
        <button type="button" class="filter-tab active" id="tab-all" onclick="setFilterType('all')">🌐 Tous les fichiers</button>
        <button type="button" class="filter-tab" id="tab-video" onclick="setFilterType('video')">🎬 Vidéos & Films</button>
        <button type="button" class="filter-tab" id="tab-audio" onclick="setFilterType('audio')">🎵 Musique & Audio</button>
        <button type="button" class="filter-tab" id="tab-document" onclick="setFilterType('document')">📄 Scans & Documents</button>
        <button type="button" class="filter-tab" id="tab-archive" onclick="setFilterType('archive')">📦 Archives & Fichiers</button>
      </div>

      <div class="quick-chips" style="margin-top: 14px;">
        <span style="font-size: 12px; color: var(--text-muted); align-self: center;">Raccourcis rapides :</span>
        <div class="chip" onclick="quickSearch('', '-1004272203145')">📁 Tout NLSbox</div>
        <div class="chip" onclick="quickSearch('', '-1003914934147')">🎵 Tout NLSmusic1</div>
        <div class="chip" onclick="quickSearch('Death Note', '-1004272203145')">Death Note</div>
        <div class="chip" onclick="quickSearch('Ninho', '-1003222560776')">Ninho (Music)</div>
        <div class="chip" onclick="quickSearch('Bleach', '-1003402221387')">Bleach VF</div>
      </div>

      <!-- Zone de lecture active -->
      <div id="playerSection" class="card" style="margin-top: 20px; display: none; background: #11161d; border-color: #388bfd;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: pulse 1.5s infinite;"></span>
            <strong id="nowPlayingTitle" style="color: #fff; font-size: 15px;">En cours de lecture</strong>
          </div>
          <a id="nowPlayingDownloadBtn" href="javascript:void(0)" class="episode-link" style="font-size: 12px; padding: 5px 12px; display: none;">📥 Télécharger ce fichier</a>
        </div>

        <!-- Lecteur Vidéo -->
        <video id="videoPlayer" controls playsinline preload="auto" style="width: 100%; border-radius: 6px; background: #000; max-height: 480px; display: none;">
          Votre navigateur ne supporte pas la balise vidéo.
        </video>

        <!-- Lecteur Audio -->
        <div id="audioContainer" style="display: none; padding: 16px; background: #161b22; border-radius: 8px; border: 1px solid #30363d;">
          <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 12px;">
            <span style="font-size: 32px;">🎵</span>
            <div>
              <div id="audioTrackName" style="color: #fff; font-weight: bold; font-size: 15px;">Piste audio</div>
              <div id="audioTrackArtist" style="color: #58a6ff; font-size: 13px;">Artiste Telegram</div>
            </div>
          </div>
          <audio id="audioPlayer" controls style="width: 100%; border-radius: 4px; outline: none;"></audio>
        </div>
      </div>

      <div id="resultsArea" style="display: none; margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="color: #fff; margin: 0; font-size: 15px;">
            Contenus trouvés (<span id="epCount">0</span>)
          </h4>
          <span id="categoryLabel" style="font-size: 12px; color: #58a6ff; background: #388bfd1a; padding: 2px 10px; border-radius: 4px; border: 1px solid #388bfd44;">Tous types</span>
        </div>
        <div class="episodes-list" id="epList"></div>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size: 16px; margin-bottom: 8px; color: #fff;">Endpoints API Documentés</h2>
      <ul style="font-size: 14px; padding-left: 20px; color: var(--text-muted);">
        <li><code style="color: #58a6ff;">GET /channels</code> - Liste de tous les canaux Telegram de la session active</li>
        <li><code style="color: #58a6ff;">GET /search?q={query}&channel={channel_id}&type={all|video|audio|document}&page={page}</code> - Exploration universelle Telegram</li>
        <li><code style="color: #58a6ff;">GET /download/{channel_id}/{message_id}</code> - Flux streaming direct Range 206 pour lecteurs vidéo et audio</li>
        <li><code style="color: #58a6ff;">GET /download/{channel_id}/{message_id}?dl=1</code> - Téléchargement direct avec Content-Disposition: attachment</li>
      </ul>
      <div class="api-preview">
curl "http://localhost:3000/search?channel=-1004272203145"
curl -I "http://localhost:3000/download/-1004272203145/889" -H "Range: bytes=0-1048575"
      </div>
    </div>
  </div>

  <style>
    .filter-tab {
      padding: 6px 14px;
      font-size: 13px;
      background: #161b22;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .filter-tab:hover {
      border-color: #58a6ff;
      color: #fff;
    }
    .filter-tab.active {
      background: #1f6feb;
      border-color: #388bfd;
      color: #fff;
      font-weight: 500;
    }
    .tag-type {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      text-transform: uppercase;
      margin-right: 6px;
    }
    .tag-video { background: #238636; color: #fff; }
    .tag-audio { background: #8957e5; color: #fff; }
    .tag-doc { background: #da3633; color: #fff; }
    .tag-file { background: #6e7681; color: #fff; }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(63, 185, 80, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(63, 185, 80, 0); }
    }
  </style>

  <script>
    let currentFilterType = 'all';

    function setFilterType(type) {
      currentFilterType = type;
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      const activeBtn = document.getElementById('tab-' + type);
      if (activeBtn) activeBtn.classList.add('active');
      runSearch();
    }

    function showError(msg) {
      const errBox = document.getElementById('errorBox');
      if (errBox) {
        errBox.textContent = msg;
        errBox.style.display = 'block';
      }
    }
    function clearError() {
      const errBox = document.getElementById('errorBox');
      if (errBox) {
        errBox.style.display = 'none';
        errBox.textContent = '';
      }
    }

    function quickSearch(title, channelId) {
      document.getElementById('queryInput').value = title;
      if (channelId) {
        const select = document.getElementById('channelSelect');
        if (select) {
          select.value = channelId;
          onChannelSelected(channelId);
        }
      }
      runSearch();
    }

    async function runSearch() {
      clearError();
      const q = document.getElementById('queryInput').value.trim();
      const channel = document.getElementById('channelInput').value.trim();
      const btn = document.getElementById('searchBtn');

      btn.disabled = true;
      btn.textContent = 'Chargement...';

      try {
        const url = '/search?q=' + encodeURIComponent(q) + '&channel=' + encodeURIComponent(channel) + '&type=' + encodeURIComponent(currentFilterType);
        const res = await fetch(url);
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.detail || 'Erreur réseau (' + res.status + ')');
        }
        const data = await res.json();
        const items = data.results || data.episodes || [];

        document.getElementById('resultsArea').style.display = 'block';
        document.getElementById('epCount').textContent = items.length;
        
        const catLabels = { all: 'Tous types', video: 'Vidéos & Films', audio: 'Musique & Audio', document: 'Documents & Scans', archive: 'Archives' };
        document.getElementById('categoryLabel').textContent = catLabels[currentFilterType] || 'Tous types';

        const epList = document.getElementById('epList');
        epList.innerHTML = '';

        if (items.length === 0) {
          epList.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);">Aucun fichier trouvé pour ces critères dans ce canal.</div>';
          return;
        }

        items.forEach(item => {
          const div = document.createElement('div');
          div.className = 'episode-item';
          
          let typeClass = 'tag-file';
          let typeLabel = 'FICHIER';
          if (item.media_type === 'video') { typeClass = 'tag-video'; typeLabel = 'VIDÉO'; }
          else if (item.media_type === 'audio') { typeClass = 'tag-audio'; typeLabel = 'AUDIO'; }
          else if (item.media_type === 'document') { typeClass = 'tag-doc'; typeLabel = 'DOC'; }
          else if (item.media_type === 'archive') { typeClass = 'tag-file'; typeLabel = 'ARCHIVE'; }

          const canPlay = item.media_type === 'video' || item.media_type === 'audio';

          div.innerHTML = \`
            <div style="flex: 1; min-width: 0;">
              <div class="episode-header">
                <span class="tag-type \${typeClass}">\${typeLabel}</span>
                \${item.episode_number !== null ? \`<span class="tag-ep">EP \${item.episode_number < 10 ? '0' + item.episode_number : item.episode_number}</span>\` : ''}
                <strong style="color: #fff; font-size: 14px;">\${item.title || item.clean_title || item.file_name}</strong>
                \${item.quality ? \`<span class="tag-quality">\${item.quality}</span>\` : ''}
                \${item.language ? \`<span class="tag-lang">\${item.language}</span>\` : ''}
                \${item.codec ? \`<span class="tag-lang" style="background: #30363d; color: #8b949e;">\${item.codec}</span>\` : ''}
                <span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">\${item.size_mb} MB</span>
              </div>
              <div class="raw-info" title="Fichier Telegram original">
                📦 Telegram : \${item.file_name}
              </div>
            </div>
            <div style="display: flex; align-items: center; margin-left: 12px; gap: 8px;">
              \${canPlay ? \`<button class="play-btn" type="button" style="padding: 6px 14px; font-size: 12px; background: #1f6feb; border-radius: 6px; border: none; color: #fff; cursor: pointer; font-weight: 500;">▶️ Lire</button>\` : ''}
              <a href="\${item.download_url}" class="episode-link" style="padding: 6px 12px; font-size: 12px; border-radius: 6px;" download="\${(item.file_name || 'media').replace(/[/\\\\?%*:|<>]/g, '_')}">📥 Télécharger</a>
            </div>
          \`;

          const playBtn = div.querySelector('.play-btn');
          if (playBtn) {
            playBtn.addEventListener('click', () => playMedia(item));
          }

          epList.appendChild(div);
        });
      } catch (err) {
        showError('Erreur lors de la recherche: ' + (err.message || err));
      } finally {
        btn.disabled = false;
        btn.textContent = 'Explorer';
      }
    }

    function playMedia(item) {
      clearError();
      const section = document.getElementById('playerSection');
      const videoPlayer = document.getElementById('videoPlayer');
      const audioContainer = document.getElementById('audioContainer');
      const audioPlayer = document.getElementById('audioPlayer');
      const titleEl = document.getElementById('nowPlayingTitle');
      const dlBtn = document.getElementById('nowPlayingDownloadBtn');

      if (!section) return;
      section.style.display = 'block';

      titleEl.textContent = (item.title || item.clean_title || item.file_name) + ' (' + item.size_mb + ' MB)';
      dlBtn.href = item.download_url;
      dlBtn.setAttribute('download', (item.file_name || 'media').replace(/[/\\?%*:|<>]/g, '_'));
      dlBtn.style.display = 'inline-block';

      videoPlayer.onerror = () => {
        showError("Impossible de décoder cette vidéo directement dans le lecteur web (format MKV ou codec non pris en charge). Utilisez le bouton de téléchargement pour la lire avec VLC.");
      };
      audioPlayer.onerror = () => {
        showError("Impossible de lire ce format audio dans le navigateur. Utilisez le bouton de téléchargement pour l'écouter avec votre lecteur.");
      };

      if (item.media_type === 'audio') {
        videoPlayer.pause();
        videoPlayer.style.display = 'none';

        audioContainer.style.display = 'block';
        document.getElementById('audioTrackName').textContent = item.track_title || item.clean_title || item.file_name;
        document.getElementById('audioTrackArtist').textContent = item.artist ? 'Artiste : ' + item.artist : 'Canal Telegram';

        audioPlayer.src = item.stream_url;
        audioPlayer.load();
        audioPlayer.play().catch(e => console.log('Audio play need interaction:', e));
      } else {
        audioPlayer.pause();
        audioContainer.style.display = 'none';

        videoPlayer.style.display = 'block';
        videoPlayer.src = item.stream_url;
        videoPlayer.load();
        videoPlayer.play().catch(e => console.log('Video play need interaction:', e));
      }

      section.scrollIntoView({ behavior: 'smooth' });
    }

    function onChannelSelected(val) {
      const customInput = document.getElementById('channelInput');
      if (val === 'custom') {
        customInput.style.display = 'inline-block';
        customInput.value = '';
        customInput.focus();
      } else {
        customInput.style.display = 'none';
        customInput.value = val;
        runSearch();
      }
    }

    async function loadTelegramStatus() {
      try {
        const res = await fetch('/channels');
        if (!res.ok) return;
        const data = await res.json();
        if (data.connected) {
          const accountEl = document.getElementById('tgAccountText');
          const detailsEl = document.getElementById('tgAccountDetails');
          if (accountEl) {
            accountEl.textContent = 'Telegram MTProto : Connecté (' + (data.user?.username ? '@' + data.user.username : data.user?.firstName || 'Compte') + ')';
          }
          if (detailsEl) {
            detailsEl.textContent = 'Session active • ' + (data.channels?.length || 0) + ' canaux disponibles';
          }

          const selectEl = document.getElementById('channelSelect');
          if (selectEl && data.channels && data.channels.length > 0) {
            selectEl.innerHTML = '';
            data.channels.forEach(ch => {
              const opt = document.createElement('option');
              opt.value = ch.id;
              opt.textContent = '📁 ' + ch.title + ' (' + ch.id + ')';
              if (ch.id === '-1004272203145' || ch.title === 'NLSbox') {
                opt.selected = true;
              }
              selectEl.appendChild(opt);
            });
            const customOpt = document.createElement('option');
            customOpt.value = 'custom';
            customOpt.textContent = '✏️ Saisir un autre ID ou @canal...';
            selectEl.appendChild(customOpt);

            document.getElementById('channelInput').value = selectEl.value;
          }
        }
      } catch (err) {
        console.warn('Could not load Telegram channels:', err);
      }
    }

    // Auto-run first search and listen to Enter key
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('queryInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runSearch();
      });
      document.getElementById('channelInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runSearch();
      });
      loadTelegramStatus();
      runSearch();
    });
  </script>
</body>
</html>
    `);
});

// Status & Health endpoints (compatibles Render, Docker, Kubernetes, monitoring)
app.get(["/status", "/health", "/healthz"], (req: Request, res: Response) => {
  return res.status(200).json({
    status: "ok",
    message: "En ligne - Sanitizer & Tri V2 OK",
    app: "NLSbox Backend Pro",
    timestamp: new Date().toISOString(),
  });
});

// 1. Get user channels and connection status from Telegram MTProto
app.get("/channels", async (req: Request, res: Response) => {
  try {
    const client = await getTelegramClient();
    if (!client) {
      return res.json({ connected: false, channels: [] });
    }
    const me = await client.getMe();
    const dialogs = await client.getDialogs({ limit: 30 });
    const channels = dialogs
      .filter((d) => d.isChannel || d.isGroup)
      .map((d) => ({
        id: d.id?.toString(),
        title: d.title,
        username: (d.entity as any)?.username || null,
      }));

    return res.json({
      connected: true,
      user: {
        id: me.id?.toString(),
        username: me.username || null,
        firstName: me.firstName || "",
      },
      channels,
    });
  } catch (err: any) {
    console.error("Error fetching Telegram channels:", err);
    return res.status(500).json({ error: err.message });
  }
});

// 2. Universal Search endpoint (Telegram files: Video, Music, Movies, Series, Anime, Scans, Documents)
app.get("/search", async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || "").trim();
    const channel = (req.query.channel as string || "").trim();
    const rawPage = req.query.page as string;
    const filterType = (req.query.type as string || "all").toLowerCase().trim();

    const pageNum = Math.max(1, parseInt(rawPage, 10) || 1);
    const cacheKey = `${channel}:${q.toLowerCase().trim()}:${filterType}`;

    let metadata: AnimeMetadata;
    let items: any[] = [];

    const cached = getCachedSearch(cacheKey);
    if (cached) {
      metadata = cached.anime_info;
      items = cached.episodes;
    } else {
      let rawItems: any[] = [];
      let isRealTelegram = false;

      const client = await getTelegramClient();

      if (client && channel && channel !== "demo" && channel !== "-1001234567890") {
        try {
          console.log(`[Telegram Search] Querying "${q || '<all>'}" in channel "${channel}"...`);
          const entity = await client.getEntity(channel);
          
          // Si une requête q est fournie, recherche textuelle Telegram. Sinon, les 60 derniers messages du canal
          const messages = q && q !== "*"
            ? await client.getMessages(entity, { search: q, limit: 100 })
            : await client.getMessages(entity, { limit: 60 });

          for (const m of messages) {
            const doc = m.media && ("document" in m.media ? (m.media as any).document : "video" in m.media ? (m.media as any).video : null);
            if (doc) {
              const fileNameAttr = doc.attributes?.find((a: any) => a.fileName);
              const audioAttr = doc.attributes?.find((a: any) => a.className === "DocumentAttributeAudio");
              const videoAttr = doc.attributes?.find((a: any) => a.className === "DocumentAttributeVideo");
              
              let fileName = fileNameAttr?.fileName || "";
              if (!fileName && audioAttr && audioAttr.title) {
                fileName = `${audioAttr.performer ? audioAttr.performer + " - " : ""}${audioAttr.title}.mp3`;
              }
              if (!fileName && m.message) {
                fileName = m.message.split("\n")[0].slice(0, 100);
              }
              
              const mimeType = doc.mimeType || (audioAttr ? "audio/mpeg" : videoAttr ? "video/mp4" : "application/octet-stream");
              const sizeBytes = Number(doc.size || 0);
              const sizeMb = parseFloat((sizeBytes / (1024 * 1024)).toFixed(1));

              rawItems.push({
                message_id: m.id,
                channel_id: channel,
                file_name: fileName,
                caption: m.message || "",
                size_mb: sizeMb,
                mime_type: mimeType,
                audio_attr: audioAttr ? { title: audioAttr.title, performer: audioAttr.performer } : null,
                duration: audioAttr?.duration || videoAttr?.duration || null,
              });
            }
          }
          isRealTelegram = true;
          console.log(`[Telegram Search] Found ${rawItems.length} media messages in channel "${channel}"`);
        } catch (err: any) {
          console.warn(`[Telegram Search] Failed to search channel ${channel}:`, err.message);
          return res.status(404).json({
            detail: `Impossible d'accéder au canal "${channel}": ${err.message}.`,
            anime_info: {
              title: q || "Contenu Telegram",
              synopsis: "Erreur d'accès au canal",
              cover: null,
              score: null,
              genres: [],
              year: null,
              total_episodes_official: null,
            },
            results: [],
            episodes: [],
            episodes_found: 0,
          });
        }
      }

      // Si mode démo ou aucun client Telegram
      if (!isRealTelegram) {
        for (let i = 12; i >= 1; i--) {
          const epNumStr = i < 10 ? `0${i}` : `${i}`;
          const rawFileName = `[Team-Fansub] @AnimeFR_Death_Note_-_${epNumStr}_[1080p_x264_VOSTFR]_t.me_animenz.mp4`;
          rawItems.push({
            message_id: 1000 + i,
            channel_id: channel || "-1004272203145",
            file_name: rawFileName,
            caption: `Death Note Episode ${epNumStr} disponible !`,
            size_mb: parseFloat((320.5 + (i % 5) * 15.2).toFixed(1)),
            mime_type: "video/mp4",
            audio_attr: null,
            duration: 1420,
          });
        }
      }

      // Nettoyage intelligent universel (Musique, Vidéos, Films, Séries, Scans, Documents)
      const cleaned = filterAndSortEpisodes(rawItems, q);

      // Si des épisodes avec numérotation d'anime/série sont détectés et qu'une recherche q existe, on tente AniList
      const isAnimeSeries = cleaned.some(c => c.episode_number !== null);
      if (isAnimeSeries && q && q.length > 2) {
        try {
          metadata = await fetchAnimeMetadata(q);
        } catch {
          metadata = {
            title: q,
            synopsis: `Contenu multimédia Telegram NLSbox (${cleaned.length} éléments trouvés).`,
            cover: null,
            score: null,
            genres: ["Telegram", "NLSbox"],
            year: new Date().getFullYear(),
            total_episodes_official: cleaned.length,
          };
        }
      } else {
        metadata = {
          title: q || "Bibliothèque Multimédia NLSbox",
          synopsis: `Exploration Telegram NLSbox : ${cleaned.length} fichiers répertoriés (vidéos, musique, documents).`,
          cover: null,
          score: null,
          genres: ["Telegram", "Media", "NLSbox"],
          year: new Date().getFullYear(),
          total_episodes_official: cleaned.length,
        };
      }

      items = cleaned.map(item => {
        const rawFileName = item.file_name || `${item.clean_title || "media"}.${item.media_type === "audio" ? "mp3" : "mp4"}`;
        const cleanSafeName = rawFileName.replace(/[/\\?%*:|"<>]/g, "_").trim();
        const encodedFileName = encodeURIComponent(cleanSafeName);
        const channelParam = encodeURIComponent(item.channel_id || channel || "-1004272203145");

        return {
          ...item,
          title: item.clean_title,
          stream_url: `/download/${channelParam}/${item.message_id}/${encodedFileName}`,
          download_url: `/download/${channelParam}/${item.message_id}/${encodedFileName}?dl=1`,
        };
      });

      if (items.length > 0) {
        setCachedSearch(cacheKey, { anime_info: metadata, episodes: items });
      }
    }

    // Filtrer par type si demandé (vidéo, audio, document, archive)
    let filteredItems = items;
    if (filterType && filterType !== "all") {
      filteredItems = items.filter(it => it.media_type === filterType);
    }

    const totalResults = filteredItems.length;
    const totalPages = Math.max(1, Math.ceil(totalResults / RESULTS_PAGE_SIZE));
    const finalPage = Math.min(pageNum, totalPages);
    const start = (finalPage - 1) * RESULTS_PAGE_SIZE;
    const pageItems = filteredItems.slice(start, start + RESULTS_PAGE_SIZE);

    return res.json({
      query: q,
      anime_info: metadata,
      results: pageItems,
      episodes: pageItems, // Compatibilité ascendante NLSbox
      episodes_found: totalResults,
      total_found: totalResults,
      page: finalPage,
      total_pages: totalPages,
      has_next: finalPage < totalPages,
      has_prev: finalPage > 1,
    });
  } catch (err: any) {
    console.error("Search error:", err);
    return res.status(500).json({ detail: err.message || "Internal server error" });
  }
});

// 3. Download / Stream endpoint with Telegram MTProto streaming + Range Header (206) support
app.get(["/download/:channel_id/:message_id", "/download/:channel_id/:message_id/:filename"], async (req: Request, res: Response) => {
  const { channel_id, message_id } = req.params;
  const msgIdNum = parseInt(message_id, 10);
  const isDownload = req.query.dl === "1";

  const client = await getTelegramClient();

  // Si canal et message Telegram réels
  if (client && channel_id && channel_id !== "-1001234567890" && !isNaN(msgIdNum)) {
    try {
      const entity = await client.getEntity(channel_id);
      const [msg] = await client.getMessages(entity, { ids: [msgIdNum] });

      const doc = msg?.media && ("document" in msg.media ? (msg.media as any).document : "video" in msg.media ? (msg.media as any).video : null);

      if (!msg || !doc) {
        return res.status(404).send("Média ou message Telegram introuvable dans ce canal.");
      }

      const totalSize = Number(doc.size || 0);
      const audioAttr = doc.attributes?.find((a: any) => a.className === "DocumentAttributeAudio");
      const videoAttr = doc.attributes?.find((a: any) => a.className === "DocumentAttributeVideo");
      const fileNameAttr = doc.attributes?.find((a: any) => a.fileName);

      let fileName = fileNameAttr?.fileName;
      if (!fileName && audioAttr && audioAttr.title) {
        fileName = `${audioAttr.performer ? audioAttr.performer + " - " : ""}${audioAttr.title}.mp3`;
      } else if (!fileName && msg.message) {
        const firstLine = msg.message.split("\n")[0].trim();
        if (firstLine.length > 3) {
          fileName = `${firstLine}.${audioAttr ? "mp3" : "mp4"}`;
        }
      }
      if (!fileName) {
        fileName = audioAttr ? `audio_${message_id}.mp3` : `video_${message_id}.mp4`;
      }

      // Nettoyer strictement les caractères interdits pour les systèmes d'exploitation (Windows, Mac, Linux, Android)
      // Caractères interdits : \ / : * ? " < > |
      const sanitizedName = fileName
        .replace(/[/\\?%*:|"<>]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
      const asciiName = sanitizedName.replace(/[^\x20-\x7E]/g, "_").slice(0, 120);
      const encodedName = encodeURIComponent(sanitizedName);

      // Détecter ou affiner le type MIME
      let mimeType = doc.mimeType;
      const lowerName = sanitizedName.toLowerCase();
      if (!mimeType || mimeType === "application/octet-stream") {
        if (lowerName.endsWith(".mp4")) mimeType = "video/mp4";
        else if (lowerName.endsWith(".mp3")) mimeType = "audio/mpeg";
        else if (lowerName.endsWith(".mkv")) mimeType = "video/x-matroska";
        else if (lowerName.endsWith(".webm")) mimeType = "video/webm";
        else if (lowerName.endsWith(".flac")) mimeType = "audio/flac";
        else if (lowerName.endsWith(".pdf")) mimeType = "application/pdf";
        else if (audioAttr) mimeType = "audio/mpeg";
        else if (videoAttr) mimeType = "video/mp4";
        else mimeType = "application/octet-stream";
      }

      const disposition = isDownload
        ? `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
        : `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;

      res.setHeader("Content-Disposition", disposition);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, Content-Disposition");
      res.setHeader("X-Content-Type-Options", "nosniff");

      const rangeHeader = req.headers.range;
      const requestSize = 512 * 1024; // 512KB Telegram chunk optimal

      if (rangeHeader) {
        let start = 0;
        let end = totalSize - 1;

        const parts = rangeHeader.replace(/bytes=/, "").trim().split("-");
        const partStart = parts[0];
        const partEnd = parts[1];

        if (partStart === "" && partEnd !== "") {
          // Suffix byte range: e.g. bytes=-500000 (derniers 500KB pour lire le box MOOV en fin de fichier MP4)
          const suffixLength = parseInt(partEnd, 10);
          start = Math.max(0, totalSize - suffixLength);
          end = totalSize - 1;
        } else {
          start = partStart ? parseInt(partStart, 10) : 0;
          end = partEnd ? parseInt(partEnd, 10) : totalSize - 1;
        }

        if (isNaN(start) || isNaN(end) || start >= totalSize || start > end) {
          res.setHeader("Content-Range", `bytes */${totalSize}`);
          return res.status(416).send("Range Not Satisfiable");
        }

        const chunkLength = end - start + 1;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        res.setHeader("Content-Length", chunkLength.toString());
        res.setHeader("Content-Type", mimeType);

        if (req.method === "HEAD") {
          return res.end();
        }

        const numChunks = Math.ceil(chunkLength / requestSize) + 1;

        const iter = client.iterDownload({
          file: msg.media,
          offset: bigInt(start),
          limit: numChunks,
          requestSize: requestSize,
        });

        let bytesSent = 0;
        let closed = false;
        req.on("close", () => {
          closed = true;
        });

        for await (const chunk of iter) {
          if (closed) break;
          const remaining = chunkLength - bytesSent;
          if (remaining <= 0) break;
          const toWrite = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          const canContinue = res.write(toWrite);
          bytesSent += toWrite.length;
          if (bytesSent >= chunkLength) break;
          if (!canContinue && !closed) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        return res.end();
      } else {
        // Direct download complet ou streaming sans en-tête Range
        res.status(200);
        res.setHeader("Content-Length", totalSize.toString());
        res.setHeader("Content-Type", mimeType);

        if (req.method === "HEAD") {
          return res.end();
        }

        const numChunks = Math.ceil(totalSize / requestSize) + 1;

        const iter = client.iterDownload({
          file: msg.media,
          offset: bigInt(0),
          limit: numChunks,
          requestSize: requestSize,
        });

        let bytesSent = 0;
        let closed = false;
        req.on("close", () => {
          closed = true;
        });

        for await (const chunk of iter) {
          if (closed) break;
          const remaining = totalSize - bytesSent;
          if (remaining <= 0) break;
          const toWrite = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          const canContinue = res.write(toWrite);
          bytesSent += toWrite.length;
          if (bytesSent >= totalSize) break;
          if (!canContinue && !closed) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        return res.end();
      }
    } catch (err: any) {
      console.error(`Download/Stream error for channel ${channel_id} msg ${message_id}:`, err?.message || err);
      if (!res.headersSent) {
        return res.status(500).send(`Erreur lors du streaming ou téléchargement Telegram: ${err.message || err}`);
      }
      return res.end();
    }
  }

  // Fallback vidéo de test si démonstration
  const totalSize = sampleVideoData.length;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = totalSize - 1;
  let statusCode = 200;

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (match) {
      if (match[1]) start = parseInt(match[1], 10);
      if (match[2]) end = parseInt(match[2], 10);
      statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    }
  }

  const chunkLength = end - start + 1;
  res.status(statusCode);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", chunkLength.toString());
  res.send(sampleVideoData.subarray(start, end + 1));
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`NLSbox Pro Engine running at http://0.0.0.0:${PORT} (env: ${process.env.NODE_ENV || "development"})`);
});

// Arrêt propre (Graceful Shutdown) pour les déploiements Render
process.on("SIGTERM", () => {
  console.log("SIGTERM reçu : fermeture progressive du serveur HTTP...");
  server.close(() => {
    console.log("Serveur HTTP fermé proprement.");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  server.close(() => {
    process.exit(0);
  });
});
