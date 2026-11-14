// 成功缓存 TTL（秒）
export const TTL = {
  TMDB_META: 604800,      // imdbid → TMDB 元数据：7 天（ID 映射稳定）
  SOURCE_DETAIL: 1800,    // 源 detail：30 分钟
  SEARCH_RESULTS: 1800,   // 源 search 结果：30 分钟
  STREAM_RESOLVE: 180,    // share 解析结果（含 sign）：3 分钟
};

// 负缓存 TTL（秒）——绝不放进成功 TTL 里
export const NEG_TTL = {
  STREAM_403: 180,        // 分片/清单 403：3 分钟
  SUBTITLE_EMPTY: 3600,   // 空字幕：1 小时
  TMDB_404: 3600,         // TMDB 404：1 小时
  TMDB_NETWORK: 120,      // TMDB 网络错误：2 分钟
};

// Key 规范：{类型}:{源/资源标识}:{参数}
// 最终 Redis key = APP_PREFIX + ":" + 这里的返回值
export const KEY = {
  tmdb: (imdbId, type, season) => `tmdb:${imdbId}:${type}:${season || 0}`,
  search: (srcId, keyword) => `search:${srcId}:${keyword}`,
  catalog: (catalogId, skip, search) => {
    if (search) return `catalog:${catalogId}:search:${search}:skip:${skip || 0}`;
    return `catalog:${catalogId}:skip:${skip || 0}`;
  },
  detail: (srcId, vodId) => `detail:${srcId}:${vodId}`,
  share: (srcId, shareUrl) => {
    const m = String(shareUrl).match(/\/share\/([a-f0-9]+)/i);
    const id = m ? m[1] : String(shareUrl).slice(-32).replace(/[^a-z0-9]/gi, "");
    return `share:${srcId}:${id}`;
  },
};
