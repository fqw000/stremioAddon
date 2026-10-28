/**
 * tt → 麦田 ID 解析器
 * 
 * 输入: tt0109830 + movie → { vid: '1111', sid: '3', nid: '1' }
 * 输入: tt0944947 + series + S01E01 → { vid: '67890', sid: '6', nid: '1' }
 * 
 * 缓存:
 *   - 成功: 7 天（tt + 类型 → 麦田完整映射）
 *   - 失败: 不缓存（下次重试）
 */

import { cacheGet, cacheSet } from './cache.js';
import { getActiveHost, fetchHtml } from './fetch.js';
import { parseRss, parseDetail } from './parser.js';

const TMDB_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const TTL_SUCCESS = 7 * 24 * 3600;   // 7 天

// ============================================================
// 主入口
// ============================================================
export async function resolveImdbToMtyy(ttId, type, season, episode) {
    if (!TMDB_KEY) {
        console.warn('[resolver] TMDB_API_KEY 未配置');
        return null;
    }

    const isMovie = type === 'movie';
    const cacheKey = `tt_map:${ttId}:${type}:${isMovie ? '1:1' : `${season}:${episode}`}`;

    // 查成功缓存
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // 实际解析（失败不缓存，下次重试）
    try {
        const result = await doResolve(ttId, type, season, episode);
        if (result) {
            await cacheSet(cacheKey, result, TTL_SUCCESS);
        }
        return result;
    } catch (e) {
        console.warn(`[resolver] tt ${ttId} 解析异常: ${e.message}`);
        return null;
    }
}

// ============================================================
// 实际解析链路
// ============================================================
async function doResolve(ttId, type, season, episode) {
    // Step 1: TMDB /find 拿标题
    const tmdbMeta = await fetchTmdbFind(ttId, type);
    if (!tmdbMeta) return null;

    // Step 2: 用标题搜麦田 RSS
    const host = await getActiveHost();
    const titles = generateCandidateTitles(tmdbMeta);
    const candidates = [];

    for (const title of titles) {
        const xml = await fetchHtml(`${host}/rss.xml?wd=${encodeURIComponent(title)}`);
        const items = parseRss(xml);
        for (const item of items) {
            if (!candidates.find(c => c.vid === item.vid)) {
                candidates.push({ ...item, searchTitle: title });
            }
        }
        if (candidates.length >= 5) break;
    }

    if (candidates.length === 0) return null;

    // Step 3: 取第一个候选
    const best = candidates[0];

    // Step 4: 详情页解析
    const detailHtml = await fetchHtml(`${host}/voddetail/${best.vid}.html`);
    if (!detailHtml) throw new Error('详情页请求失败');   // 网络问题，抛出异常不缓存

    const detail = parseDetail(detailHtml, best.vid);
    if (!detail.lines || detail.lines.length === 0) return null;

    // 找第一个非加密线路
    const playableLine = detail.lines.find(l => !l.encrypted);
    if (!playableLine) return null;

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
    if (meta.originalTitle && meta.originalTitle !== meta.title) candidates.add(meta.originalTitle);
    if (meta.title && meta.title.includes(':')) candidates.add(meta.title.split(':')[0].trim());
    if (meta.title) {
        const clean = meta.title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        if (clean !== meta.title) candidates.add(clean);
    }
    return [...candidates].filter(t => t && t.length > 0);
}