mkdir -p src/cache src/utils
cat > src/cache/ttl.js << 'EOF'
// 各类缓存的 TTL（秒）
export const TTL = {
  TMDB_META: 86400,       // imdbid → TMDB 元数据：24h
  SOURCE_DETAIL: 21600,   // 源 detail：6h
  SEARCH_RESULTS: 1800,   // 源 search 结果：30min
  STREAM_RESOLVE: 300,    // resolveStream 结果（含 sign）：5min
};

// 统一 key 前缀，便于在 Redis 里区分
export const KEY = {
  tmdb: (imdbId, type, season) => `tmdb:${imdbId}:${type}:${season || 0}`,
  search: (srcId, keyword) => `search:${srcId}:${keyword}`,
  detail: (srcId, vodId) => `detail:${srcId}:${vodId}`,
  stream: (srcId, vodId, season, episode) => `stream:${srcId}:${vodId}:${season || 0}:${episode || 0}`,
};
EOF