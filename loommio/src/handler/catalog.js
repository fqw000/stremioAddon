// src/handler/catalog.js
// Catalog & Search handler
// 职责：loommio_cartoons -> fetchCartoons() -> Meta Preview 映射
//       本地 search 过滤 + skip 切片；空结果返回 { metas: [] }
// 不负责：Redis 缓存、ID 反向解析、Meta/Stream

import { fetchCartoons, AdapterError } from '../adapter.js';
import { getOrFetch, prefixKey } from '../cache.js';

const CATALOG_ID = 'loommio_cartoons';
const CATALOG_TYPE = 'series';
const PAGE_SIZE = 100; // Stremio 标准分页

// 成功缓存 30 分钟，SWR 5 分钟
const CACHE_MAX_AGE = 1800;
const STALE_REVALIDATE = 300;
// 失败/空结果短效缓存，防止负优化，同时避免打爆源站
const ERROR_CACHE_MAX_AGE = 60;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 底层 cartoon -> Stremio Meta Preview Object
 * 只映射探针确认存在的字段，不猜 releaseInfo/background 等
 */
function toMetaPreview(c) {
  return {
    id: `loommio_${c.plID}`,
    type: CATALOG_TYPE,
    name: c.name,
    poster: c.thumbnail,
    description: c.description,
    // 不设置 behaviorHints.defaultVideoId（Catalog 中不允许）
    // 不设置 releaseInfo（createdAt 是时间戳，不是发行年份）
  };
}

function matchesSearch(c, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const name = (c.name || '').toLowerCase();
  const desc = (c.description || '').toLowerCase();
  return name.includes(needle) || desc.includes(needle);
}

function normalizeSkip(extra) {
  const raw = extra && extra.skip;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object} args
 * @param {string} args.type
 * @param {string} args.id       catalog id，应为 loommio_cartoons
 * @param {object} [args.extra]  { search?, skip?, genre? }
 * @returns {Promise<object>}    { metas, cacheMaxAge, staleRevalidate }
 */
export async function catalogHandler({ type, id, extra } = {}) {
  if (type !== CATALOG_TYPE || id !== CATALOG_ID) {
    // 非本 handler 负责的请求，交给路由层；这里返回空，避免误伤
    return { metas: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }

  try {
    const cartoons = await getOrFetch(
      prefixKey('catalog', 'loommio_cartoons'),
      () => fetchCartoons(),
      { l1TtlMs: 60_000, l2TtlSeconds: 1800, negativeTtlSeconds: 60 }
    );

    const search = extra && extra.search ? String(extra.search) : '';
    const skip = normalizeSkip(extra);

    // 先过滤，再分页，保证 skip 语义正确
    const filtered = search
      ? cartoons.filter((c) => matchesSearch(c, search))
      : cartoons;

    const page = filtered.slice(skip, skip + PAGE_SIZE);
    const metas = page.map(toMetaPreview);

    console.log(
      `[catalog] ${ts()} id=${id} search=${search || '-'} skip=${skip} total=${cartoons.length} filtered=${filtered.length} returned=${metas.length}`
    );

    return {
      metas,
      cacheMaxAge: CACHE_MAX_AGE,
      staleRevalidate: STALE_REVALIDATE,
    };
  } catch (e) {
    const code = e instanceof AdapterError ? e.code : 'UNKNOWN';
    console.log(`[catalog] ${ts()} error code=${code} msg=${e.message}`);
    // 空结果必须是 []，不能是 null；并给短效缓存避免负优化
    return { metas: [], cacheMaxAge: ERROR_CACHE_MAX_AGE };
  }
}

export const CATALOG_META = {
  id: CATALOG_ID,
  type: CATALOG_TYPE,
  pageSize: PAGE_SIZE,
};