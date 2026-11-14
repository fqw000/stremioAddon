// imdbid → TMDB 标准元数据
// 缓存：
//   成功 → 7 天
//   404 / 空结果 → 1h 负缓存
//   网络错误 / 5xx → 不缓存
//   用户自定义 TMDB Key 优先（通过 userConfig.tmdbKey 传入）
import { getJSON, setJSON } from "../cache/index.js";
import { KEY, TTL, NEG_TTL } from "../cache/ttl.js";
import { log } from "../logger.js";

const TMDB_BASE = (process.env.TMDB_BASE_URL || "https://api.themoviedb.org").replace(/\/$/, "") + "/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

let warnedNoKey = false;

export function getTMDBStatus(userConfig = {}) {
  return {
    enabled: Boolean(userConfig.tmdbKey || process.env.TMDB_API_KEY),
    base: TMDB_BASE,
    language: "zh-CN",
    source: userConfig.tmdbKey ? "user" : "env",
  };
}

async function tmdbFetch(path, params = {}, apiKey) {
  const key = apiKey || process.env.TMDB_API_KEY;
  if (!key) {
    if (!warnedNoKey) {
      log.warn("[tmdb] TMDB_API_KEY not set, imdbid path disabled");
      warnedNoKey = true;
    }
    return { ok: false, reason: "no-key" };
  }

  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "zh-CN");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 404) return { ok: false, reason: "not-found" };
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : `network-${e.name}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveByImdb(imdbId, type, { season, userConfig = {} } = {}) {
  const cacheKey = KEY.tmdb(imdbId, type, season);
  const apiKey = userConfig.tmdbKey; // 用户指定的 key 优先

  const hit = await getJSON(cacheKey);
  if (hit) {
    if (hit.__negative) {
      log.info(`[tmdb] ${imdbId} ${type} → negative cache hit (${hit.reason})`);
      return null;
    }
    log.info(`[tmdb] ${imdbId} ${type} s${season || 0} → cache hit`);
    return hit;
  }

  const found = await tmdbFetch(`/find/${imdbId}`, { external_source: "imdb_id" }, apiKey);

  if (!found.ok) {
    if (found.reason === "not-found") {
      log.info(`[tmdb] ${imdbId} → 404, negative cache 1h`);
      await setJSON(cacheKey, { __negative: true, reason: "not-found" }, NEG_TTL.TMDB_404);
    } else if (found.reason === "no-key") {
      // already warned
    } else {
      log.warn(`[tmdb] ${imdbId} → ${found.reason}, no cache`);
    }
    return null;
  }

  const list = type === "movie" ? found.data.movie_results : found.data.tv_results;
  if (!list?.length) {
    log.info(`[tmdb] ${imdbId} → empty results, negative cache 1h`);
    await setJSON(cacheKey, { __negative: true, reason: "empty-results" }, NEG_TTL.TMDB_404);
    return null;
  }

  const hitItem = list[0];
  const tmdbId = hitItem.id;

  const altPath = type === "movie"
    ? `/movie/${tmdbId}/alternative_titles`
    : `/tv/${tmdbId}/alternative_titles`;
  const alt = await tmdbFetch(altPath, {}, apiKey);
  const aliases = alt.ok
    ? (alt.data.titles || alt.data.results || [])
        .map((t) => t.title)
        .filter((t) => t && /[\u4e00-\u9fa5]/.test(t))
    : [];

  const year = (hitItem.release_date || hitItem.first_air_date || "").slice(0, 4);

  const result = {
    tmdbId,
    type,
    name: hitItem.title || hitItem.name || "",
    originalName: hitItem.original_title || hitItem.original_name || "",
    aliases: [...new Set([hitItem.name, hitItem.title, ...aliases].filter(Boolean))],
    year,
    season: type === "series" ? (season || 1) : null,
    overview: hitItem.overview || "",
    poster: hitItem.poster_path ? TMDB_IMG + hitItem.poster_path : "",
    originalLanguage: hitItem.original_language,
    originCountry: hitItem.origin_country || [],
  };

  await setJSON(cacheKey, result, TTL.TMDB_META);
  return result;
}