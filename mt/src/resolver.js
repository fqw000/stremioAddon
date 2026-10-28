/**
 * tt → 麦田 ID 解析器
 * 
 * 输入: tt0109830 + movie → { vid: '12345', sid: '1', nid: '1' }
 * 输入: tt0944947 + series + S01E01 → { vid: '67890', sid: '6', nid: '1' }
 * 
 * 缓存:
 *   - 成功: 7 天（tt + 类型 → 麦田完整映射）
 *   - 失败: 1 小时（防止反复打爆 TMDB）
 */

import { cacheGet, cacheSet, negGet, negSet, withCache } from './cache.js';
import { getActiveHost, fetchHtml, USER_AGENT } from './fetch.js';
import { parseRss, parseDetail } from './parser.js';

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const TTL_SUCCESS = 7 * 24 * 3600;   // 7 天
const TTL_FAIL = 3600;               // 1 小时

// ============================================================
// 主入口
// ============================================================
/**
 * 解析 tt ID 到麦田内部 ID
 * @param {string} ttId - tt0109830
 * @param {string} type - movie / series
 * @param {number} season - 剧集季数（movie 传 undefined）
 * @param {number} episode - 剧集集数（movie 传 undefined）
 * @returns {Promise<{vid, sid, nid} | null>}
 */
export async function resolveImdbToMtyy(ttId, type, season, episode) {
    if (!TMDB_KEY) {
        console.warn('[resolver] TMDB_API_KEY 未配置，tt 支持不可用');
        return null;
    }

    const isMovie = type === 'movie';
    const cacheKey = `tt_map:${ttId}:${type}:${isMovie ? '1:1' : `${season}:${episode}`}`;
    const failKey = `tt_fail:${ttId}:${type}`;

    // 1. 查失败负缓存
    if (await negGet(failKey)) return null;

    // 2. 查成功缓存
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // 3. 实际解析
    try {
        const result = await doResolve(ttId, type, season, episode);
        if (result) {
            await cacheSet(cacheKey, result, TTL_SUCCESS);
            return result;
        }
        // 解析失败 → 短效负缓存
        await negSet(failKey, TTL_FAIL);
        return null;
    } catch (e) {
        console.warn(`[resolver] tt ${ttId} 解析异常: ${e.message}`);
        await negSet(failKey, TTL_FAIL);
        return null;
    }
}

// ============================================================
// 实际解析链路
// ============================================================
async function doResolve(ttId, type, season, episode) {
    // Step 1: TMDB
    const tmdbMeta = await fetchTmdbFind(ttId, type);
    if (!tmdbMeta) {
        console.warn(`[resolver] TMDB find 失败: ${ttId}`);
        return null;
    }
    console.log(`[resolver] TMDB: title="${tmdbMeta.title}", original="${tmdbMeta.originalTitle}"`);

    // Step 2: 麦田搜索
    const host = await getActiveHost();
    const titles = generateCandidateTitles(tmdbMeta);
    console.log(`[resolver] 候选标题: ${titles.join(', ')}`);

    const candidates = [];
    for (const title of titles) {
        const xml = await fetchHtml(`${host}/rss.xml?wd=${encodeURIComponent(title)}`);
        const items = parseRss(xml);
        console.log(`[resolver] 搜索 "${title}" → ${items.length} 条`);
        for (const item of items) {
            if (!candidates.find(c => c.vid === item.vid)) {
                candidates.push({ ...item, searchTitle: title });
            }
        }
        if (candidates.length >= 5) break;
    }

    if (candidates.length === 0) {
        console.warn(`[resolver] 所有标题搜索均无结果`);
        return null;
    }

    // Step 3: 取第一个候选
    const best = candidates[0];
    console.log(`[resolver] 选中 vid=${best.vid} name="${best.name}" (来自搜索 "${best.searchTitle}")`);

    // Step 4: 详情页
    const detailHtml = await fetchHtml(`${host}/voddetail/${best.vid}.html`);
    if (!detailHtml) {
        console.warn(`[resolver] 详情页请求失败: ${host}/voddetail/${best.vid}.html`);
        return null;
    }

    const detail = parseDetail(detailHtml, best.vid);
    console.log(`[resolver] 详情页解析: name="${detail.name}", lines=${detail.lines.length}`);
    if (!detail.lines || detail.lines.length === 0) {
        console.warn(`[resolver] 详情页无线路`);
        return null;
    }

    // 找第一个非加密线路
    const playableLine = detail.lines.find(l => !l.encrypted);
    if (!playableLine) {
        console.warn(`[resolver] 所有线路均加密`);
        return null;
    }
    console.log(`[resolver] 选中线路: ${playableLine.name} sid=${playableLine.sid} 集数=${playableLine.episodes.length}`);

    // 按集数匹配
    if (type === 'movie' || detail.isMovie) {
        const ep = playableLine.episodes[0];
        return { vid: best.vid, sid: ep.sid, nid: ep.nid };
    }

    const ep = playableLine.episodes[episode - 1] || playableLine.episodes[0];
    if (!ep) return null;

    return { vid: best.vid, sid: ep.sid, nid: ep.nid };
}

// ============================================================
// TMDB /find
// ============================================================
async function fetchTmdbFind(ttId, type) {
    const url = `${TMDB_BASE}/find/${ttId}?external_source=imdb_id&language=zh-CN&api_key=${TMDB_KEY}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);

    try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return null;

        const data = await res.json();
        const results = type === 'movie' ? data.movie_results : data.tv_results;
        if (!results || results.length === 0) return null;

        const item = results[0];
        return {
            id: item.id,
            title: type === 'movie' ? item.title : item.name,
            originalTitle: type === 'movie' ? item.original_title : item.original_name,
            releaseDate: type === 'movie' ? item.release_date : item.first_air_date,
        };
    } catch {
        clearTimeout(t);
        return null;
    }
}

// ============================================================
// 候选标题生成
// ============================================================
function generateCandidateTitles(meta) {
    const candidates = new Set();

    if (meta.title) candidates.add(meta.title);
    if (meta.originalTitle && meta.originalTitle !== meta.title) {
        candidates.add(meta.originalTitle);
    }

    // 去掉副标题（"xxx:yyy" → "xxx"）
    if (meta.title && meta.title.includes(':')) {
        candidates.add(meta.title.split(':')[0].trim());
    }

    // 去掉年份后缀（如 "电影名 (2023)"）
    if (meta.title) {
        const clean = meta.title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        if (clean !== meta.title) candidates.add(clean);
    }

    return [...candidates].filter(t => t && t.length > 0);
}