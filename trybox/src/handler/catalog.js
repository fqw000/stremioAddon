/**
 * Catalog Handler
 *
 * 统一处理：
 *   1. 普通浏览（无 extra）
 *   2. 搜索（extra.search）
 *   3. Genre 筛选（extra.genre）
 *
 * 缓存：
 *   - catalog:home（所有 page 共享，trybox 一次返回全部板块）
 *   - search:{query}:{type}
 */

import { createLogger } from '../logger.js';
import { TRYBOX_URLS, GENRE_MAP, TTL } from '../constants.js';
import { buildCatalogPayload, buildSearchPayload } from '../payload.js';
import { buildApiHeaders } from '../headers.js';
import { decodeNode } from '../decode.js';
import { getText } from '../http.js';
import { withCache } from '../cache.js';

const log = createLogger('Catalog');

function parseCatalogId(id) {
  return id.replace(/^trybox_/, '');
}

function resolveGenrePreset(stremioType, genre) {
  const map = GENRE_MAP[stremioType];
  if (!map) return null;
  return map[genre] || null;
}

function toMetaPreview(item) {
  const isTV = item.media_type === 'tv' || !!item.first_air_date;
  return {
    id: `trybox_${item.id}`,
    type: isTV ? 'series' : 'movie',
    name: item.title || item.name || '',
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
    background: item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : undefined,
    description: item.overview || '',
    releaseInfo: (item.release_date || item.first_air_date || '').slice(0, 4),
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
  };
}

/**
 * 从缓存或源头获取完整 catalog
 */
async function getFullCatalog(env, headers) {
  const { value, fromCache } = await withCache({
    env,
    key: 'catalog:home',
    l1Ttl: TTL.CATALOG_L1,
    redisTtl: TTL.CATALOG_REDIS,
    fetcher: async () => {
      const payload = buildCatalogPayload('home');
      const url = `${TRYBOX_URLS.catalog}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
      const raw = await getText(url, headers);
      return decodeNode(JSON.parse(raw));
    },
  });
  if (fromCache) log.info('Catalog 命中缓存');
  else log.info('Catalog 回源');
  return value;
}

async function getSearchResult(env, headers, query, tryboxType) {
  const key = `search:${query}:${tryboxType}`;
  const { value, fromCache } = await withCache({
    env,
    key,
    l1Ttl: TTL.SEARCH_L1,
    redisTtl: TTL.SEARCH_REDIS,
    fetcher: async () => {
      const payload = buildSearchPayload(query, tryboxType);
      const url = `${TRYBOX_URLS.search}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
      const raw = await getText(url, headers);
      const decoded = decodeNode(JSON.parse(raw));
      return Array.isArray(decoded.result) ? decoded.result : [];
    },
  });
  log.info(`Search ${fromCache ? '命中缓存' : '回源'}: "${query}" (${tryboxType})`);
  return value;
}

export async function catalogHandler({ type, id, extra = {}, config, env }) {
  const section = parseCatalogId(id);
  const lang = config.lang || 'zh-CN';
  const headers = buildApiHeaders(lang);

  // 1. 搜索（仅在 search 功能启用时处理）
  if (extra.search) {
    if (!config.enabledFeatures?.includes('search')) {
      log.info('Search 功能未启用，返回空');
      return { metas: [] };
    }
    const tryboxType = type === 'series' ? 'tv' : 'movie';
    const results = await getSearchResult(env, headers, extra.search, tryboxType);
    return { metas: results.map(toMetaPreview) };
  }

  // 2. Genre 筛选
  if (extra.genre) {
    const preset = resolveGenrePreset(type, extra.genre);
    if (!preset) {
      log.warn(`未知 genre: ${extra.genre} type=${type}`);
      return { metas: [] };
    }
    const decoded = await getFullCatalog(env, headers);
    const items = decoded.result?.presets?.[preset] || [];
    const filtered = items.filter((it) => {
      const itIsTV = it.media_type === 'tv';
      return type === 'series' ? itIsTV : !itIsTV;
    });
    return { metas: filtered.map(toMetaPreview) };
  }

  // 3. 普通浏览
  log.info(`Catalog 浏览: section=${section} type=${type}`);
  const decoded = await getFullCatalog(env, headers);

  let items = [];
  if (section === 'home' || section === 'trending') {
    items = decoded.result?.trending || [];
  } else if (section === 'popular') {
    items = decoded.result?.popular || [];
  } else if (section === 'topRated') {
    items = decoded.result?.topRated || [];
  } else if (section === 'secondary') {
    items = decoded.result?.secondary || [];
  } else if (section === 'tertiary') {
    items = decoded.result?.tertiary || [];
  } else if (section === 'movie' || section === 'tv') {
    const all = [
      ...(decoded.result?.trending || []),
      ...(decoded.result?.popular || []),
      ...(decoded.result?.topRated || []),
      ...(decoded.result?.secondary || []),
      ...(decoded.result?.tertiary || []),
    ];
    const seen = new Set();
    items = all.filter((it) => {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
  }

  const filtered = items.filter((it) => {
    const itIsTV = it.media_type === 'tv';
    return type === 'series' ? itIsTV : !itIsTV;
  });

  log.info(`Catalog 返回 ${filtered.length} 条`);
  return { metas: filtered.map(toMetaPreview) };
}
