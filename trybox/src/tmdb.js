/**
 * TMDB 辅助模块
 *
 * 功能：
 *   - tt{imdbId} → tmdbId 转换
 *   - 结果缓存（L1 + Redis）
 *
 * 依赖：
 *   - config.tmdbKey（env.TMDB_KEY 或用户 ?cfg= 传入）
 */

import { createLogger } from './logger.js';
import { loggedFetch } from './http-log.js';
import { TMDB_API, TTL } from './constants.js';
import { withCache } from './cache.js';

const log = createLogger('TMDB');

/**
 * 判断是否为 IMDb ID 格式（tt + 数字）
 */
export function isImdbId(id) {
  return /^tt\d+$/.test(id);
}

/**
 * 从 IMDb ID 提取纯数字部分
 * 例：'tt0137523' → '0137523'
 */
export function imdbNumericPart(id) {
  return id.replace(/^tt/, '');
}

/**
 * 调 TMDB find API 转换 imdbId → tmdbId
 *
 * @param {string} ttId - 例 'tt0137523'
 * @param {string} tmdbKey
 * @returns {Promise<{tmdbId: number, type: 'movie'|'tv'}|null>}
 */
async function fetchTmdbFind(ttId, tmdbKey) {
  const url = `${TMDB_API.base}/find/${ttId}?external_source=imdb_id&language=zh-CN&api_key=${tmdbKey}`;
  const res = await loggedFetch(url, {}, { tag: 'tmdb', label: 'TMDB find' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TMDB find HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();

  // 优先 movie，其次 tv
  if (data.movie_results?.length) {
    return { tmdbId: data.movie_results[0].id, type: 'movie' };
  }
  if (data.tv_results?.length) {
    return { tmdbId: data.tv_results[0].id, type: 'tv' };
  }
  return null;
}

/**
 * tt → tmdb 转换（带缓存）
 *
 * @returns {Promise<{tmdbId: number, type: 'movie'|'tv'}|null>}
 */
export async function resolveImdbId(env, ttId, tmdbKey) {
  if (!isImdbId(ttId)) {
    log.warn(`非 IMDb 格式: ${ttId}`);
    return null;
  }

  if (!tmdbKey) {
    log.warn('TMDB_KEY 未配置，无法转换');
    return null;
  }

  const cacheKey = `imdb_to_tmdb:${ttId}`;
  const { value, fromCache } = await withCache({
    env,
    key: cacheKey,
    l1Ttl: TTL.IMDB_TO_TMDB_L1,
    redisTtl: TTL.IMDB_TO_TMDB_REDIS,
    fetcher: async () => {
      log.info(`TMDB find: ${ttId}`);
      return await fetchTmdbFind(ttId, tmdbKey);
    },
    // null 结果不缓存（规范要求：不缓存错误数据）
    shouldCache: (v) => v !== null,
  });

  log.info(`resolveImdbId ${fromCache ? '命中缓存' : '回源'}: ${ttId} → ${JSON.stringify(value)}`);
  return value;
}

/**
 * 统一解析 trybox id 或 tt id
 *
 * @returns {Promise<{tmdbId: string, kind: 'movie'|'tv', season?: number, episode?: number}|null>}
 */
export async function parseAnyId(env, id, type, tmdbKey) {
  // 1. trybox_{tmdbId}[:season:episode]
  const tryboxMatch = id.match(/^trybox_(\d+)(?::(\d+):(\d+))?$/);
  if (tryboxMatch) {
    const [, tmdbId, season, episode] = tryboxMatch;
    return {
      tmdbId,
      kind: type === 'series' ? 'tv' : 'movie',
      season: season ? Number(season) : undefined,
      episode: episode ? Number(episode) : undefined,
    };
  }

  // 2. tt{imdbId}[:season:episode]
  const imdbMatch = id.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
  if (imdbMatch) {
    const [, ttId, season, episode] = imdbMatch;
    const resolved = await resolveImdbId(env, ttId, tmdbKey);
    if (!resolved) return null;
    return {
      tmdbId: String(resolved.tmdbId),
      kind: resolved.type,
      season: season ? Number(season) : undefined,
      episode: episode ? Number(episode) : undefined,
    };
  }

  log.warn(`无法解析 id: ${id}`);
  return null;
}
