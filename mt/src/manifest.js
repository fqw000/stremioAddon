/**
 * Manifest 动态生成
 * 根据 config.cats 决定暴露哪些 catalog
 */

import { CATALOG_META } from './config.js';

export function getManifest(config = {}) {
    const cats = config.cats || ['movie', 'series', 'anime', 'variety', 'short'];

    // 根据 cats 动态生成 catalogs
    const catalogs = cats
        .filter(key => CATALOG_META[key])   // 过滤非法值
        .map(key => {
            const meta = CATALOG_META[key];
            return {
                type: meta.type,
                id: `mtyy_${key}`,
                name: meta.label,
                extra: [{ name: 'search', isRequired: false }],
            };
        });

    return {
        id: 'com.mtyy.stremio',
        version: '1.1.0',
        name: '麦田影院',
        description: '麦田影院影视聚合 · 电影/电视剧/动漫/综艺/短剧',
        logo: 'https://mtyy5.com/static/ds6/img/desklogo.png',
        resources: [
            { name: 'catalog', types: ['movie', 'series'] },
            { name: 'meta', types: ['movie', 'series'], idPrefixes: ['mtyy_'] },
            { name: 'stream', types: ['movie', 'series'], idPrefixes: ['mtyy_', 'tt'] },
        ],
        types: ['movie', 'series'],
        catalogs,
        idPrefixes: ['mtyy_', 'tt'],
        behaviorHints: {
            // 有自定义配置 → 显示"配置"按钮；否则不显示
            configurable: !!config.isCustom,
            configurationRequired: false,
        },
    };
}