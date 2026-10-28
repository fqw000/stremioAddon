/**
 * 配置层
 * 
 * 优先级：用户配置(?cfg=) > 环境变量 > 默认值
 * 
 * 支持字段：
 *   - cats: string[]     启用的 catalog（movie/series/anime/variety/short）
 *   - tk:   string       自定义 TMDB API Key（覆盖 env）
 *   - lines: string[]    线路黑名单（sid 列表，如 ['4'] 禁用 NBY）
 *   - hl:   boolean      是否隐藏 NBY 加密线路（默认 true）
 */

// ============================================================
// 默认配置（与当前 manifest.js 里的 catalogs 保持一致）
// ============================================================
const DEFAULT_CATS = ['movie', 'series', 'anime', 'variety', 'short'];

// ============================================================
// base64url 解码（Edge Runtime 用 atob）
// ============================================================
function decodeBase64Url(str) {
    if (!str) return {};
    try {
        // 补齐 padding
        let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const json = atob(b64);
        return JSON.parse(json);
    } catch {
        return {};
    }
}

// ============================================================
// 从 URL 提取 cfg 参数并解码
// ============================================================
export function extractUserConfig(url) {
    const cfgParam = url.searchParams.get('cfg');
    if (!cfgParam) return {};
    return decodeBase64Url(cfgParam);
}

// ============================================================
// 合并配置
// ============================================================
/**
 * @param {object} userConfig  从 ?cfg= 解码得到的用户配置
 * @param {object} env         process.env
 * @returns {{
 *   cats: string[],
 *   tmdbKey: string,
 *   lineBlacklist: string[],
 *   hideEncrypted: boolean,
 *   isCustom: boolean,   // 是否有用户自定义配置（决定 URL 是否生成 ?cfg=）
 * }}
 */
export function mergeConfig(userConfig = {}, env = {}) {
    // ─── cats ───
    // 只保留合法值，防止用户传脏数据
    const validCats = ['movie', 'series', 'anime', 'variety', 'short'];
    let cats = DEFAULT_CATS;
    if (Array.isArray(userConfig.cats)) {
        const filtered = userConfig.cats.filter(c => validCats.includes(c));
        // 用户如果传空数组，视为"全部关闭"
        if (filtered.length > 0 || userConfig.cats.length === 0) {
            cats = filtered;
        }
    }

    // ─── tmdbKey ───
    // 用户覆盖 > env > 空
    const tmdbKey = userConfig.tk || env.TMDB_API_KEY || '';

    // ─── lines 黑名单 ───
    // 用户指定禁用某些 sid
    const lineBlacklist = Array.isArray(userConfig.lines) ? userConfig.lines.map(String) : [];

    // ─── hideEncrypted ───
    // 默认 true，用户显式 false 才关闭
    const hideEncrypted = userConfig.hl !== false;

    // ─── isCustom ───
    // 判断用户是否有自定义（决定安装 URL 是否需要 ?cfg=）
    const isCustom = 
        (Array.isArray(userConfig.cats) && 
         JSON.stringify([...cats].sort()) !== JSON.stringify([...DEFAULT_CATS].sort())) ||
        !!userConfig.tk ||
        lineBlacklist.length > 0 ||
        userConfig.hl === false;

    return {
        cats,
        tmdbKey,
        lineBlacklist,
        hideEncrypted,
        isCustom,
    };
}

// ============================================================
// 从 Request 解析完整配置（供 api/index.js 调用）
// ============================================================
export function getConfigFromRequest(req, env) {
    const url = new URL(req.url);
    const userConfig = extractUserConfig(url);
    return mergeConfig(userConfig, env);
}

// ============================================================
// 常量导出（供 configure.js 使用）
// ============================================================
export const CATALOG_META = {
    movie:   { type: 'movie',  label: '🎬 麦田电影' },
    series:  { type: 'series', label: '📺 麦田电视剧' },
    anime:   { type: 'series', label: '🎌 麦田动漫' },
    variety: { type: 'series', label: '🎤 麦田综艺' },
    short:   { type: 'series', label: '🎞️ 麦田短剧' },
};