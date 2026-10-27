/**
 * Meta Handler
 *
 * 缓存：
 *   - meta:{type}:{tmdbId}（含 seasons 列表）
 *   - episodes:{tvId}（含所有季，一次缓存全部）
 *
 * 优化：
 *   - episodes 并行请求所有季（Promise.all）
 *   - 合并为一个 key 存储，热请求只读 1 次 Upstash
 */

import { createLogger } from '../logger.js';
import { TRYBOX_URLS, TTL } from '../constants.js';
import { buildMetaPayload, buildEpisodesPayload } from '../payload.js';
import { buildApiHeaders } from '../headers.js';
import { decodeNode } from '../decode.js';
import { getText } from '../http.js';
import { withCache } from '../cache.js';

const log = createLogger('Meta');

function parseTryboxId(id) {
  const m = id.match(/^trybox_(\d+)$/);
  if (m) return { tmdbId: m[1] };
  return null;
}

function toStremioMeta(tryboxMeta, videos = []) {
  const isTV = tryboxMeta.media_type === 'tv';

  // 预告片
  const trailers = (tryboxMeta.videos || [])
    .filter((v) => v.key && (v.type === 'Trailer' || v.type === 'Clip'))
    .map((v) => ({ source: v.key, type: v.type || 'Trailer' }));

  // links（同时保留 genres/cast/director 兼容旧客户端）
  const links = [];
  for (const g of tryboxMeta.genres || []) {
    if (g.name) {
      links.push({
        name: g.name,
        category: 'genre',
        url: `stremio:///discover/${encodeURIComponent(g.name)}`,
      });
    }
  }
  for (const c of (tryboxMeta.cast || []).slice(0, 10)) {
    if (c.name) {
      links.push({
        name: c.name,
        category: 'actor',
        url: `stremio:///search?search=${encodeURIComponent(c.name)}`,
      });
    }
  }
  for (const d of tryboxMeta.directors || []) {
    if (d.name) {
      links.push({
        name: d.name,
        category: 'director',
        url: `stremio:///search?search=${encodeURIComponent(d.name)}`,
      });
    }
  }

  const releaseInfo = isTV
    ? (tryboxMeta.release_date || '').slice(0, 4) +
      (tryboxMeta.status && tryboxMeta.status !== 'Ended' ? '-' : '')
    : (tryboxMeta.release_date || '').slice(0, 4);

  return {
    id: `trybox_${tryboxMeta.id}`,
    type: isTV ? 'series' : 'movie',
    name: tryboxMeta.title || tryboxMeta.name || '',
    poster: tryboxMeta.poster_path
      ? `https://image.tmdb.org/t/p/w500${tryboxMeta.poster_path}`
      : undefined,
    background: tryboxMeta.backdrop_path
      ? `https://image.tmdb.org/t/p/original${tryboxMeta.backdrop_path}`
      : undefined,
    logo: tryboxMeta.logo_path
      ? `https://image.tmdb.org/t/p/w500${tryboxMeta.logo_path}`
      : undefined,
    description: tryboxMeta.overview || '',
    releaseInfo: releaseInfo || undefined,
    released: tryboxMeta.release_date
      ? `${tryboxMeta.release_date}T00:00:00.000Z`
      : undefined,
    runtime: tryboxMeta.runtime ? `${tryboxMeta.runtime}m` : undefined,
    imdbRating: tryboxMeta.vote_average
      ? tryboxMeta.vote_average.toFixed(1)
      : undefined,
    genres: (tryboxMeta.genres || []).map((g) => g.name).filter(Boolean),
    cast: (tryboxMeta.cast || []).slice(0, 15).map((c) => c.name).filter(Boolean),
    director: (tryboxMeta.directors || []).map((d) => d.name).filter(Boolean),
    trailers: trailers.length ? trailers : undefined,
    links: links.length ? links : undefined,
    language: tryboxMeta.original_language || undefined,
    website: tryboxMeta.homepage || undefined,
    videos: isTV && videos.length ? videos : undefined,
  };
}

/**
 * 获取 meta 详情（带缓存）
 */
export async function getMeta(env, headers, tryboxType, tmdbId) {
  const key = `meta:${tryboxType}:${tmdbId}`;
  const { value, fromCache } = await withCache({
    env,
    key,
    l1Ttl: TTL.DETAIL_L1,
    redisTtl: TTL.DETAIL_REDIS,
    fetcher: async () => {
      const payload = buildMetaPayload(tryboxType, tmdbId);
      const url = `${TRYBOX_URLS.meta}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
      const raw = await getText(url, headers);
      const decoded = decodeNode(JSON.parse(raw));
      return decoded.result || { __null: true };   // ← 关键：哨兵
    },
    shouldCache: () => true,                        // ← 关键：true
  });
  log.info(`Meta ${fromCache ? '命中缓存' : '回源'}: ${tryboxType}/${tmdbId}`);
  return value && value.__null ? null : value;      // ← 关键：解包
}


/**
 * 获取单季 episodes（内部用，不缓存）
 */
async function fetchOneSeason(headers, tvId, seasonNumber) {
  const payload = buildEpisodesPayload(tvId, seasonNumber);
  const url = `${TRYBOX_URLS.episodes}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const raw = await getText(url, headers);
  const decoded = decodeNode(JSON.parse(raw));
  return Array.isArray(decoded.result) ? decoded.result : [];
}

/**
 * 获取全部季 episodes（合并为一个缓存 key，并行请求）
 */
async function getAllEpisodes(env, headers, tvId, seasons) {
  const key = `episodes:${tvId}`;

  const { value, fromCache } = await withCache({
    env,
    key,
    l1Ttl: TTL.EPISODES_L1,
    redisTtl: TTL.EPISODES_REDIS,
    fetcher: async () => {
      // 并行请求所有季
      const validSeasons = seasons.filter((s) => s.season_number != null);
      const results = await Promise.all(
        validSeasons.map((s) =>
          fetchOneSeason(headers, tvId, s.season_number)
            .then((episodes) => ({ season: s.season_number, episodes }))
            .catch((e) => {
              log.warn(`S${s.season_number} 获取失败: ${e.message}`);
              return { season: s.season_number, episodes: [] };
            })
        )
      );
      // 转成 { [season]: [...] }
      const map = {};
      for (const r of results) map[r.season] = r.episodes;
      return map;
    },
  });

  log.info(`Episodes ${fromCache ? '命中缓存' : '回源'} (${Object.keys(value).length} 季)`);
  return value;
}

/**
 * 把 episodes map 展开成 Stremio videos 数组
 */
function buildVideosFromEpisodes(tvId, episodesMap) {
  const videos = [];
  const seasons = Object.keys(episodesMap).map(Number).sort((a, b) => a - b);
  for (const seasonNumber of seasons) {
    const episodes = episodesMap[seasonNumber] || [];
    for (const ep of episodes) {
      videos.push({
        id: `trybox_${tvId}:${seasonNumber}:${ep.episode_number}`,
        title: ep.name || `第 ${ep.episode_number} 集`,
        season: seasonNumber,
        episode: ep.episode_number,
        released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
        overview: ep.overview || undefined,
        thumbnail: ep.still_path
          ? `https://image.tmdb.org/t/p/w300${ep.still_path}`
          : undefined,
      });
    }
  }
  return videos;
}

export async function metaHandler({ type, id, config, env }) {
  const parsed = parseTryboxId(id);
  if (!parsed) {
    log.warn(`无法解析 id: ${id}`);
    return { meta: null };
  }

  const { tmdbId } = parsed;
  const tryboxType = type === 'series' ? 'tv' : 'movie';
  const lang = config.lang || 'zh-CN';
  const headers = buildApiHeaders(lang);

  const meta = await getMeta(env, headers, tryboxType, tmdbId);
  if (!meta) {
    log.warn(`meta 为空: id=${tmdbId}`);
    return { meta: null };
  }

  let videos = [];
  if (tryboxType === 'tv' && Array.isArray(meta.seasons) && meta.seasons.length) {
    const episodesMap = await getAllEpisodes(env, headers, tmdbId, meta.seasons);
    videos = buildVideosFromEpisodes(tmdbId, episodesMap);
    log.info(`获取到 ${videos.length} 集`);
  }

  return { meta: toStremioMeta(meta, videos) };
}
