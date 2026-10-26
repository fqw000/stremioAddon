/**
 * IMDb → 站点 vodId 解析器
 * 
 * 关键设计：
 *   - inflight 并发去重：meta/stream 同时请求只解析一次
 *   - 并发拉别名 ∥ 主标题搜索：省 ~2s
 *   - 条件化候选精简：纯中文 ≥ 2 时只搜 top-3 中文 + top-1 其他
 *   - 从 meta.type 读取修正后的类型
 *   - seasonYear：剧集优先用目标季的播出年匹配
 * 
 * @module imdb-resolver
 */

import { CONFIG } from './config.js';
import { fetchImdbMeta, fetchAlternativeTitles } from './tmdb.js';
import { searchVideos } from './adapter.js';
import { getCache, setCache } from './cache.js';
import {
  scoreCandidate,
  parseCastString,
  THRESHOLDS,
} from './matcher.js';

// ==========================================
// 配置
// ==========================================

const CACHE_TTL = 7 * 24 * 60 * 60;
const MAX_SEARCH_TITLES = 6;

/** ★ 进行中的解析（并发去重） */
const inflight = new Map();

// ==========================================
// 主入口（P0-3 修复：先 set 再 await）
// ==========================================

export async function resolveImdbToVod(imdbId, type, season = 1) {
  const cacheKey = `imdb2vod:${imdbId}:${type}:${season}`;

  // ★ 先同步检查 inflight（关键：在 await 之前）
  if (inflight.has(cacheKey)) {
    console.log(`[IMDb→Vod] ⏳ 等待进行中的解析: ${cacheKey}`);
    return inflight.get(cacheKey);
  }

  // ★ 立即同步 set 占位 promise，避免 await getCache 期间被其他请求穿透
  const promise = (async () => {
    const cached = await getCache(cacheKey);
    if (cached) {
      console.log(`[IMDb→Vod] ✅ 缓存命中: vodId=${cached.vodId}`);
      return cached;
    }
    return doResolve(imdbId, type, season, cacheKey);
  })().finally(() => inflight.delete(cacheKey));

  inflight.set(cacheKey, promise);
  return promise;
}

// ==========================================
// 实际解析逻辑（P2-4 分层 1+2）
// ==========================================

async function doResolve(imdbId, type, season, cacheKey) {
  // ===== 1. 元数据 =====
  const meta = await getCachedMeta(imdbId, type);
  if (!meta || !meta.title) {
    console.error(`[IMDb→Vod] ❌ 无元数据`);
    return null;
  }

  // ★ 使用 meta.type（TMDB/Cinemeta fallback 后的真实类型）
  const effectiveType = meta.type || type;
  if (effectiveType !== type) {
    console.log(`[IMDb→Vod] 🔄 使用元数据修正类型: ${type} → ${effectiveType}`);
  }

  // ★ 从 meta.seasons 提取目标季的播出年
  const seasonYear = extractSeasonYear(meta, effectiveType === 'series' ? season : null);

  console.log(
    `[IMDb→Vod] 📝 "${meta.title}" (${meta.year || '?'}) ` +
    `type=${effectiveType} cast=${meta.cast?.length || 0}` +
    (seasonYear ? ` seasonYear=${seasonYear}` : '')
  );

  // ===== 2+3. 并行：拉别名 ∥ 搜主标题 =====
  // ★ 核心优化：不再串行 await 别名拉取
  const t0 = Date.now();
  const [altTitles, primaryResults] = await Promise.all([
    meta.tmdbId
      ? fetchAlternativeTitles(meta.tmdbId, effectiveType).catch(err => {
          console.warn(`[Candidates] 别名获取失败: ${err.message}`);
          return [];
        })
      : Promise.resolve([]),
    searchVideos(meta.title).catch(err => {
      console.warn(`[MultiSearch] 主标题搜索失败: ${err.message}`);
      return [];
    }),
  ]);

  console.log(
    `[IMDb→Vod] ⚡ 别名+主标题并发完成 ${Date.now() - t0}ms ` +
    `(alt=${altTitles.length}, primary=${primaryResults.length})`
  );

  // ===== 3. 组装候选（条件化精简）=====
  const candidateTitles = buildCandidateTitles(meta, altTitles);
  if (candidateTitles.length === 0 && primaryResults.length === 0) {
    console.error(`[IMDb→Vod] ❌ 无候选标题且主标题无结果`);
    return null;
  }
  if (candidateTitles.length > 0) {
    console.log(`[Candidates] 📋 ${candidateTitles.length} 个: ${candidateTitles.join(' | ')}`);
  }

  // ===== 4. 搜索剩余候选（跳过主标题，因为已搜过）=====
  const { results } = await searchWithMultipleTitles(candidateTitles, {
    skipKeyword: meta.title,
    initialResults: primaryResults,
  });
  if (results.length === 0) {
    console.error(`[IMDb→Vod] ❌ 无搜索结果`);
    return null;
  }
  console.log(`[IMDb→Vod] 📋 候选结果数: ${results.length}`);

  // ===== 5. 目标（★ 保证主标题一定在 titles 里）=====
  const targetTitles = [...new Set([meta.title, ...candidateTitles])].filter(Boolean);
  const target = {
    titles: targetTitles,
    year: meta.year,
    seasonYear,
    cast: meta.cast || [],
    type: effectiveType,
    season: effectiveType === 'series' ? season : null,
  };

  // ===== 6. 严格模式 =====
  let winner = pickBest(target, results, {
    minScore: THRESHOLDS.MIN_FINAL_SCORE,
    minTitleSim: THRESHOLDS.MIN_TITLE_SIM,
    skipCastCheck: false,
  });

  // ===== 7. 宽松兜底 =====
  if (!winner) {
    console.log(`[IMDb→Vod] ⚠️ 严格模式无结果，启用宽松兜底...`);
    winner = pickBest(target, results, {
      minScore: 0.40,
      minTitleSim: 0.30,
      skipCastCheck: true,
    });
  }

  if (!winner) {
    console.error(`[IMDb→Vod] ❌ 两种模式均无匹配`);
    return null;
  }

  // ===== 8. 缓存 =====
  const result = {
    vodId: winner.item.vodId,
    title: winner.item.vodName,
    year: winner.item.vodYear,
    imdbId,
    tmdbId: meta.tmdbId || null,
    season,
    type: effectiveType,
  };

  await setCache(cacheKey, result, CACHE_TTL);
  console.log(
    `[IMDb→Vod] ✅ vodId=${result.vodId} ` +
    `score=${winner.detail.score.toFixed(2)} ` +
    `(title=${winner.detail.titleSim.toFixed(2)}, ` +
    `cast=${winner.detail.castEvaluated ? winner.detail.castSim.toFixed(2) : 'n/a'}, ` +
    `year=${winner.detail.yearEvaluated ? winner.detail.yearSim.toFixed(2) : 'n/a'})`
  );

  return result;
}

// ==========================================
// 季年份提取
// ==========================================

/**
 * 从 meta.seasons 提取目标季的播出年
 * 
 * 用途：站内每季独立 vodId，同剧不同季的 vodYear 可能不同
 * 用目标季年份匹配能有效区分。
 * 
 * Cinemeta 无 seasons 数组 → 返回 null，只用整剧年份。
 */
function extractSeasonYear(meta, season) {
  if (!season || !Array.isArray(meta.seasons) || meta.seasons.length === 0) {
    return null;
  }
  const s = meta.seasons.find(x => x.seasonNumber === season);
  if (!s || !s.airDate) return null;
  const year = parseInt(String(s.airDate).split('-')[0], 10);
  return isNaN(year) ? null : year;
}

// ==========================================
// 打分选择
// ==========================================

function pickBest(target, results, opts = {}) {
  const minScore = opts.minScore ?? THRESHOLDS.MIN_FINAL_SCORE;
  const minTitleSim = opts.minTitleSim ?? THRESHOLDS.MIN_TITLE_SIM;
  const skipCastCheck = opts.skipCastCheck ?? false;

  let best = null;
  let bestDetail = null;

  for (const r of results) {
    const candidate = {
      title: r.vodName || '',
      year: r.vodYear ? parseInt(r.vodYear, 10) : null,
      cast: parseCastString(r.vodActor || r.actor || ''),
    };

    const detail = scoreCandidate(target, candidate, {
      minTitleSim,
      skipCastCheck,
    });

    if (detail.titleSim > 0.4) {
      console.log(
        `[Match]   "${candidate.title}" (${candidate.year || '?'}) ` +
        `title=${detail.titleSim.toFixed(2)} ` +
        `cast=${detail.castEvaluated ? detail.castSim.toFixed(2) : 'n/a'} ` +
        `year=${detail.yearEvaluated ? detail.yearSim.toFixed(2) : 'n/a'} ` +
        `→ ${detail.rejected ? `❌ ${detail.reason}` : `score=${detail.score.toFixed(2)}`}`
      );
    }

    if (detail.rejected) continue;
    if (detail.score < minScore) continue;

    if (!bestDetail || detail.score > bestDetail.score) {
      best = r;
      bestDetail = detail;
    }
  }

  if (!best) return null;
  return { item: best, detail: bestDetail };
}

// ==========================================
// 候选标题（条件化精简，P2-4 分层 2）
// ==========================================

/**
 * 组装候选标题（纯同步，无网络）
 *
 * 策略：
 *   - 纯中文/中文过半 ≥ 2 个 → 精简为「top-3 中文 + top-1 其他」
 *   - 纯中文/中文过半 < 2 个 → 保留全量 top-6（原逻辑）
 *
 * 理由：
 *   - 中文站点对中文标题收录率最高，多个中文候选命中后无需搜外文
 *   - 中文稀缺时（如日剧/韩剧），保留外文兜底
 *
 * 效果示例：
 *   "阿甘正传"  → [阿甘正传, 阿甘正傳, Forrest Gump]（3 个，原 6 个）
 *   "3 Body Problem" → [三体, 3体, 3 Body Problem]（3 个，原 6 个）
 *   "東京ラブストーリー"（只有 1 个中文名）→ 保留 6 个
 *
 * @param {Object} meta - TMDB/Cinemeta 元数据
 * @param {string[]} altTitles - fetchAlternativeTitles 返回值
 * @returns {string[]}
 */
function buildCandidateTitles(meta, altTitles) {
  const candidates = new Set();

  if (meta.title) candidates.add(meta.title.trim());
  if (meta.originalTitle && meta.originalTitle !== meta.title) {
    candidates.add(meta.originalTitle.trim());
  }
  for (const alt of altTitles || []) {
    if (alt && alt.trim()) candidates.add(alt.trim());
  }

  const sorted = [...candidates].sort(
    (a, b) => getTitlePriority(b) - getTitlePriority(a)
  );

  const highPriority = sorted.filter(t => getTitlePriority(t) >= 2);
  const others = sorted.filter(t => getTitlePriority(t) < 2);

  let limited;
  if (highPriority.length >= 2) {
    // 中文丰富：3 中文 + 1 其他
    limited = [...highPriority.slice(0, 3), ...others.slice(0, 1)];
  } else {
    // 中文稀缺：保留原逻辑（top-6 全量）
    limited = sorted;
  }

  // ★ 保证主标题一定在结果里
  if (meta.title && !limited.includes(meta.title.trim())) {
    limited = [meta.title.trim(), ...limited];
  }

  return limited.slice(0, MAX_SEARCH_TITLES);
}

/**
 * 标题优先级：纯中文 > 中文过半 > 其他
 */
function getTitlePriority(title) {
  if (!title) return -1;
  const cnCount = (title.match(/[\u4e00-\u9fa5]/g) || []).length;
  const total = title.length;
  if (/^[\u4e00-\u9fa5]+$/.test(title)) return 3;
  if (cnCount / total > 0.5) return 2;
  return 0;
}

// ==========================================
// 多标题搜索（支持跳过主标题）
// ==========================================

/**
 * 搜索多个候选标题
 *
 * 优化点：
 *   - 支持传入 initialResults（主标题已搜过的结果，避免重复搜）
 *   - 支持 skipKeyword（跳过已搜过的关键词）
 *   - 保持并行搜索（不引入分批短路，行为与原版等价）
 *
 * @param {string[]} candidateTitles
 * @param {Object} opts
 * @param {string} [opts.skipKeyword]
 * @param {Object[]} [opts.initialResults]
 * @returns {Promise<{ results: Object[], searchedTitles: string[] }>}
 */
async function searchWithMultipleTitles(candidateTitles, opts = {}) {
  const { skipKeyword, initialResults = [] } = opts;

  const allResults = [...initialResults];
  const seenIds = new Set(
    initialResults.map(r => r.vodId).filter(Boolean)
  );
  const searchedTitles = skipKeyword ? [skipKeyword] : [];

  // 过滤掉主标题（已搜过）
  const remaining = candidateTitles.filter(
    k => k && k.length >= 2 && k !== skipKeyword
  );

  if (remaining.length === 0) {
    if (skipKeyword) {
      console.log(
        `[MultiSearch]   "${skipKeyword}"（已搜过）→ ${initialResults.length} 条`
      );
    }
    return { results: allResults, searchedTitles };
  }

  const searchTasks = remaining.map(async keyword => {
    try {
      const results = await searchVideos(keyword);
      return { keyword, results: Array.isArray(results) ? results : [] };
    } catch (err) {
      console.warn(`[MultiSearch] "${keyword}" 失败: ${err.message}`);
      return { keyword, results: [] };
    }
  });

  const settled = await Promise.all(searchTasks);

  for (const { keyword, results } of settled) {
    searchedTitles.push(keyword);
    console.log(`[MultiSearch]   "${keyword}" → ${results.length} 条`);
    for (const r of results) {
      if (r.vodId && !seenIds.has(r.vodId)) {
        seenIds.add(r.vodId);
        allResults.push(r);
      }
    }
  }

  return { results: allResults, searchedTitles };
}

// ==========================================
// 元数据缓存
// ==========================================

async function getCachedMeta(imdbId, type) {
  const cacheKey = `meta:${imdbId}:${type}`;

  const cached = await getCache(cacheKey);
  if (cached) {
    console.log(`[MetaCache] ✅ HIT: ${cacheKey}`);
    return cached;
  }

  console.log(`[MetaCache] ❌ MISS: ${cacheKey}`);
  const meta = await fetchImdbMeta(imdbId, type);
  if (meta) await setCache(cacheKey, meta, CACHE_TTL);
  return meta;
}

// ==========================================
// 调试
// ==========================================

export function clearImdbCache() {
  console.log('[IMDb→Vod] ⚠️ 请通过 Upstash 控制台清空 Redis 缓存');
}

export function getCacheStats() {
  return { message: '缓存已迁移到 Redis，请查看 Upstash 控制台' };
}