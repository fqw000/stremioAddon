/**
 * Meta 详情处理器（已接入缓存与负缓存）
 */

import { getActiveHost, fetchHtml } from '../fetch.js';
import { parseDetail } from '../parser.js';
import { withCache, negSet, TTL } from '../cache.js';

export async function metaHandler({ id, type, config = {} }) {
    const m = id.match(/^mtyy_(\d+)$/);
    if (!m) return { meta: null, cacheMaxAge: 60 };

    const vid = m[1];
    const cacheKey = `meta:${vid}`;

    try {
        const host = await getActiveHost();

        // ============================================================
        // 1. 缓存读取或回源
        // ============================================================
        const { value: detail, fromCache } = await withCache(cacheKey, TTL.META, async () => {
            const html = await fetchHtml(`${host}/voddetail/${vid}.html`);
            if (!html) {
                // 请求失败，写负缓存 10 分钟
                await negSet(`meta:${vid}`, TTL.NEG_META);
                return null;
            }

            const d = parseDetail(html, vid);
            if (!d.name) {
                // 解析成功但没拿到有效内容（比如影片被删），写负缓存
                await negSet(`meta:${vid}`, TTL.NEG_META);
                return null;
            }

            return d;
        });

        // ============================================================
        // 2. 空结果处理
        // ============================================================
        if (!detail) {
            return { meta: null, cacheMaxAge: TTL.NEG_META };
        }

        // ============================================================
        // 3. 组装 videos（根据用户配置决定是否输出 NBY）
        // ============================================================
        const hideEncrypted = config.hideEncrypted !== false;
        const videos = detail.isMovie
            ? undefined
            : detail.lines
                .filter(line => !(line.encrypted && hideEncrypted))
                .flatMap(line =>
                    line.episodes.map((ep, idx) => ({
                        id: `mtyy_${ep.vid}:${ep.sid}:${ep.nid}`,
                        title: `${line.name} · ${ep.title}`,
                        season: 1,
                        episode: idx + 1,
                    }))
                );

        // ============================================================
        // 4. 返回 Meta
        // ============================================================
        return {
            meta: {
                id: `mtyy_${detail.vid}`,
                type: detail.isMovie ? 'movie' : 'series',
                name: detail.name,
                poster: detail.pic || undefined,
                description: detail.desc || undefined,
                releaseInfo: detail.year || undefined,
                imdbRating: detail.rating || undefined,
                director: detail.directors.length ? detail.directors : undefined,
                cast: detail.cast.length ? detail.cast.slice(0, 10) : undefined,
                genres: detail.genres.length ? detail.genres : undefined,
                videos,
            },
            cacheMaxAge: TTL.META,
            _fromCache: fromCache,
        };
    } catch (e) {
        // 全局兜底（比如域名全挂）
        return { meta: null, cacheMaxAge: 60 };
    }
}