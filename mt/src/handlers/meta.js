/**
 * Meta 详情处理器
 */

import { getActiveHost, fetchHtml } from '../fetch.js';
import { parseDetail } from '../parser.js';

export async function metaHandler({ id, type }) {
    const m = id.match(/^mtyy_(\d+)$/);
    if (!m) return { meta: null };

    const vid = m[1];

    try {
        const host = await getActiveHost();
        const html = await fetchHtml(`${host}/voddetail/${vid}.html`);
        if (!html) return { meta: null };

        const d = parseDetail(html, vid);
        if (!d.name) return { meta: null };

        // ============================================================
        // videos 数组：只输出非加密线路（NBY 已过滤）
        // id 格式：mtyy_{vid}:{sid}:{nid}
        // ============================================================
        const videos = d.isMovie
            ? undefined
            : d.lines
                .filter(line => !line.encrypted)
                .flatMap(line =>
                    line.episodes.map((ep, idx) => ({
                        id: `mtyy_${ep.vid}:${ep.sid}:${ep.nid}`,
                        title: `${line.name} · ${ep.title}`,
                        season: 1,
                        episode: idx + 1,
                    }))
                );

        return {
            meta: {
                id: `mtyy_${d.vid}`,
                type: d.isMovie ? 'movie' : 'series',
                name: d.name,
                poster: d.pic || undefined,
                description: d.desc || undefined,
                releaseInfo: d.year || undefined,
                imdbRating: d.rating || undefined,
                director: d.directors.length ? d.directors : undefined,
                cast: d.cast.length ? d.cast.slice(0, 10) : undefined,
                genres: d.genres.length ? d.genres : undefined,
                videos,
            },
        };
    } catch (e) {
        return { meta: null };
    }
}