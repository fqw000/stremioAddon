// imdbid → TMDB 标准元数据。无 TMDB_API_KEY 时返回 null，上层优雅降级
import { log } from "../logger.js";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

let warnedNoKey = false;

async function tmdbFetch(path, params = {}) {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    if (!warnedNoKey) { log.warn("[tmdb] TMDB_API_KEY not set, imdbid path disabled"); warnedNoKey = true; }
    return null;
  }
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "zh-CN");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return await res.json();
  } catch (e) {
    log.warn(`[tmdb] ${path} failed: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} imdbId 形如 tt1234567
 * @param {"movie"|"series"} type
 * @param {{ season?: number }} opts
 */
export async function resolveByImdb(imdbId, type, { season } = {}) {
  const found = await tmdbFetch(`/find/${imdbId}`, { external_source: "imdb_id" });
  if (!found) return null;

  const list = type === "movie" ? found.movie_results : found.tv_results;
  if (!list?.length) return null;

  const hit = list[0];
  const tmdbId = hit.id;

  // 取别名（alternative_titles）
  const altPath = type === "movie" ? `/movie/${tmdbId}/alternative_titles` : `/tv/${tmdbId}/alternative_titles`;
  const alt = await tmdbFetch(altPath);
  const aliases = (alt?.titles || alt?.results || [])
    .map((t) => t.title)
    .filter((t) => t && /[\u4e00-\u9fa5]/.test(t));

  const year = (hit.release_date || hit.first_air_date || "").slice(0, 4);

  return {
    tmdbId,
    type,
    name: hit.title || hit.name || "",
    originalName: hit.original_title || hit.original_name || "",
    aliases: [...new Set([hit.name, hit.title, ...aliases].filter(Boolean))],
    year,
    season: type === "series" ? (season || 1) : null,
    overview: hit.overview || "",
    poster: hit.poster_path ? TMDB_IMG + hit.poster_path : "",
    originalLanguage: hit.original_language,
    originCountry: hit.origin_country || [],
  };
}