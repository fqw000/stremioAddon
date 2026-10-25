// src/handler/stream.js
// Stream handler
// 职责：loommio_<plID>__<vidID> -> fetchCartoonDetail(plID) -> 定位 vidID -> Stream
//       name = cartoon.name（系列名），title = video.name（单集名）
//       url 清洗 #，过滤空 url；空结果返回 { streams: [] }
// 不负责：Redis 缓存、Meta/Catalog、诊断流

import { fetchCartoonDetail, AdapterError } from '../adapter.js';
import { getOrFetch, prefixKey } from '../cache.js';

const STREAM_TYPE = 'series';
const ID_PREFIX = 'loommio_';
const VIDEO_SEP = '__';

const CACHE_MAX_AGE = 180;         // Stream 3 分钟
const ERROR_CACHE_MAX_AGE = 60;    // 失败短效，避免负优化

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 解析 Stream id：loommio_<plID>__<vidID>
 * 失败返回 null，不抛错。
 */
function parseStreamId(id) {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return null;
  const rest = id.slice(ID_PREFIX.length);
  const sep = rest.indexOf(VIDEO_SEP);
  if (sep <= 0) return null;
  const plID = rest.slice(0, sep);
  const vidID = rest.slice(sep + VIDEO_SEP.length);
  if (!plID || !vidID) return null;
  return { plID, vidID };
}

/**
 * 清洗 url：剥离 #expires=xxx 等 Hash；返回空串表示非法。
 */
function cleanUrl(raw) {
  if (typeof raw !== 'string') return '';
  const u = raw.split('#')[0].trim();
  return u;
}

function buildStream(cartoon, plID, video, url) {
  return {
    name: cartoon.name,       // 系列名，用户确认使用返回值中类似这个名字
    title: video.name,        // 单集名，series 播放时显示为 E1/E2 对应的集标题
    url,
    behaviorHints: {
      bingeGroup: `loommio-${plID}`, // 稳定值，不用含空格的 name
      // 已是 HTTPS MP4，可直接播放，不设 notWebReady
      // 不需要 proxyHeaders，不设 notWebReady: true
    },
  };
}

/**
 * @param {object} args
 * @param {string} args.type
 * @param {string} args.id   loommio_<plID>__<vidID>
 * @returns {Promise<object>} { streams, cacheMaxAge }
 */
export async function streamHandler({ type, id } = {}) {
  if (type !== STREAM_TYPE) {
    return { streams: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }

  const parsed = parseStreamId(id);
  if (!parsed) {
    return { streams: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }

  const { plID, vidID } = parsed;

  try {
    const { cartoon, videos } = await getOrFetch(
      prefixKey('detail', plID),
      () => fetchCartoonDetail(plID),
      { l1TtlMs: 60_000, l2TtlSeconds: 1800, negativeTtlSeconds: 60 }
    );

    const video = videos.find((v) => v && v.vidID === vidID);
    if (!video) {
      console.log(`[stream] ${ts()} id=${id} vidID not found`);
      return { streams: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
    }

    const url = cleanUrl(video.videoUrl);
    if (!url) {
      // 空 url 防御：必须过滤，不返回空 url 的 Stream 对象
      console.log(`[stream] ${ts()} id=${id} empty url, filtered`);
      return { streams: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
    }

    const stream = buildStream(cartoon, plID, video, url);

    console.log(
      `[stream] ${ts()} id=${id} name="${cartoon.name}" title="${video.name}" url=${url}`
    );

    return {
      streams: [stream],
      cacheMaxAge: CACHE_MAX_AGE,
    };
  } catch (e) {
    const code = e instanceof AdapterError ? e.code : 'UNKNOWN';
    console.log(`[stream] ${ts()} id=${id} error code=${code} msg=${e.message}`);
    return { streams: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }
}

export const STREAM_PREFIX = ID_PREFIX;
export const STREAM_SEPARATOR = VIDEO_SEP;