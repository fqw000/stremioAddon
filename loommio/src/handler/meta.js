// src/handler/meta.js
// Meta handler
// 职责：loommio_<plID> -> fetchCartoonDetail(plID) -> Meta Object
//       videos 按数组下标映射 season=1, episode=index+1
//       空结果返回 { meta: null }
// 不负责：Redis 缓存、Catalog、Stream

import { fetchCartoonDetail, AdapterError } from '../adapter.js';
import { getOrFetch, prefixKey } from '../cache.js';

const META_TYPE = 'series';
const ID_PREFIX = 'loommio_';
const VIDEO_SEP = '__';

const CACHE_MAX_AGE = 1800;        // 成功 30 分钟
const STALE_REVALIDATE = 300;      // SWR 5 分钟
const ERROR_CACHE_MAX_AGE = 60;    // 失败短效，避免负优化

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 从 Meta id 中解析出 plID。
 * 合法形态：loommio_<plID>
 * 非本 handler 负责或格式非法时返回 null（不抛错）。
 * 注意：带 __ 后缀的是 Stream id，不是 Meta id，这里视为非法。
 */
function parseMetaId(id) {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return null;
  const rest = id.slice(ID_PREFIX.length);
  if (!rest || rest.includes(VIDEO_SEP)) return null;
  return rest;
}

function toMetaObject(cartoon, plID, videos) {
  return {
    id: `${ID_PREFIX}${plID}`,
    type: META_TYPE,
    name: cartoon.name,
    poster: cartoon.thumbnail,
    description: cartoon.description,
    videos,
    // 不设置 behaviorHints.defaultVideoId：底层无“默认集”信息，不猜；
    // 让 Stremio Core 按官方逻辑（有 videos 用当前选中项，否则用 preview.id）自行决定。
    // 不设置 releaseInfo：createdAt 是时间戳，不是发行年份。
  };
}

function toVideo(plID, v, index) {
  return {
    id: `${ID_PREFIX}${plID}${VIDEO_SEP}${v.vidID}`,
    title: v.name,
    season: 1,
    episode: index + 1, // 用数组下标保证连续，不用 videoUrl 中的文件名序号
    thumbnail: v.thumbnailUrl,
    // released 缺失：底层无播出日期，不猜
  };
}

/**
 * @param {object} args
 * @param {string} args.type
 * @param {string} args.id   loommio_<plID>
 * @returns {Promise<object>} { meta, cacheMaxAge, staleRevalidate }
 */
export async function metaHandler({ type, id } = {}) {
  if (type !== META_TYPE) {
    return { meta: null, cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }

  const plID = parseMetaId(id);
  if (!plID) {
    // 非本 handler 负责或格式非法：返回空，交给路由层
    return { meta: null, cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }

  try {
    const { cartoon, videos } = await getOrFetch(
      prefixKey('detail', plID),
      () => fetchCartoonDetail(plID),
      { l1TtlMs: 60_000, l2TtlSeconds: 1800, negativeTtlSeconds: 60 }
    );

    const mappedVideos = videos.map((v, i) => toVideo(plID, v, i));
    const meta = toMetaObject(cartoon, plID, mappedVideos);

    console.log(
      `[meta] ${ts()} id=${id} name="${cartoon.name}" videos=${mappedVideos.length}`
    );

    return {
      meta,
      cacheMaxAge: CACHE_MAX_AGE,
      staleRevalidate: STALE_REVALIDATE,
    };
  } catch (e) {
    const code = e instanceof AdapterError ? e.code : 'UNKNOWN';
    console.log(`[meta] ${ts()} id=${id} error code=${code} msg=${e.message}`);
    // Meta 空结果按 Stremio 规范返回 { meta: null }，不是 null 本身，也不是 []
    return { meta: null, cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }
}

export const META_PREFIX = ID_PREFIX;
export const VIDEO_SEPARATOR = VIDEO_SEP;