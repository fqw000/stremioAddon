/**
 * Catalog + RSS Search 处理器
 */

import { getActiveHost, fetchHtml } from '../fetch.js';
import { parseVideoList, parseRss } from '../parser.js';

const CATEGORY_MAP = {
    'mtyy_movie':   { tid: '1',  type: 'movie'  },
    'mtyy_series':  { tid: '2',  type: 'series' },
    'mtyy_anime':   { tid: '3',  type: 'series' },
    'mtyy_variety': { tid: '4',  type: 'series' },
    'mtyy_short':   { tid: '26', type: 'series' },
};

export async function catalogHandler({ id, type, extra = {} }) {
    const cat = CATEGORY_MAP[id];
    if (!cat) return { metas: [] };

    try {
        const host = await getActiveHost();

        // ============================================================
        // 1. RSS 搜索
        // ============================================================
        if (extra.search) {
            const xml = await fetchHtml(`${host}/rss.xml?wd=${encodeURIComponent(extra.search)}`);
            const items = parseRss(xml);
            return {
                metas: items.map(it => ({
                    id: `mtyy_${it.vid}`,
                    type: cat.type,
                    name: it.name,
                    poster: it.pic || undefined,
                })),
            };
        }

        // ============================================================
        // 2. 分类列表
        // ============================================================
        const html = await fetchHtml(`${host}/vodtype/${cat.tid}.html`);
        const items = parseVideoList(html);

        return {
            metas: items.map(it => ({
                id: `mtyy_${it.vid}`,
                type: cat.type,
                name: it.name,
                poster: it.pic || undefined,
                releaseInfo: it.year || undefined,
                description: it.type || undefined,
            })),
        };
    } catch (e) {
        return { metas: [] };
    }
}