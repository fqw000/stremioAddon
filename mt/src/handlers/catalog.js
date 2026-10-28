/**
 * Catalog + RSS Search 处理器（已接入 L1/L2 缓存与负缓存）
 */

import { getActiveHost, fetchHtml } from '../fetch.js';
import { parseVideoList, parseRss } from '../parser.js';
import { withCache, negSet, TTL } from '../cache.js';

const CATEGORY_MAP = {
    'mtyy_movie':   { tid: '1',  type: 'movie'  },
    'mtyy_series':  { tid: '2',  type: 'series' },
    'mtyy_anime':   { tid: '3',  type: 'series' },
    'mtyy_variety': { tid: '4',  type: 'series' },
    'mtyy_short':   { tid: '26', type: 'series' },
};

export async function catalogHandler({ id, type, extra = {} }) {
    const cat = CATEGORY_MAP[id];
    if (!cat) return { metas: [], cacheMaxAge: 60 };

    const host = await getActiveHost();

    // ============================================================
    // 1. RSS 搜索
    // ============================================================
    if (extra.search) {
        const cacheKey = `search:${cat.tid}:${extra.search}`;
        
        const { value: items, fromCache } = await withCache(cacheKey, TTL.SEARCH, async () => {
            const xml = await fetchHtml(`${host}/rss.xml?wd=${encodeURIComponent(extra.search)}`);
            const list = parseRss(xml);
            if (list.length === 0) {
                // 结果为空，写入负缓存 10 分钟
                await negSet(`search:${cat.tid}:${extra.search}`, TTL.NEG_EMPTY);
            }
            return list;
        });

        const metas = (items || []).map(it => ({
            id: `mtyy_${it.vid}`,
            type: cat.type,
            name: it.name,
            poster: it.pic || undefined,
        }));

        return {
            metas,
            cacheMaxAge: TTL.SEARCH,
            _fromCache: fromCache, // 调试用
        };
    }

    // ============================================================
    // 2. 分类列表
    // ============================================================
    const cacheKey = `catalog:${cat.tid}`;
    
    const { value: items, fromCache } = await withCache(cacheKey, TTL.CATALOG, async () => {
        const html = await fetchHtml(`${host}/vodtype/${cat.tid}.html`);
        const list = parseVideoList(html);
        if (list.length === 0) {
            // 抓取失败或解析为空，写负缓存
            await negSet(`catalog:${cat.tid}`, TTL.NEG_EMPTY);
        }
        return list;
    });

    const metas = (items || []).map(it => ({
        id: `mtyy_${it.vid}`,
        type: cat.type,
        name: it.name,
        poster: it.pic || undefined,
        releaseInfo: it.year || undefined,
        description: it.type || undefined,
    }));

    return {
        metas,
        cacheMaxAge: TTL.CATALOG,
        _fromCache: fromCache,
    };
}