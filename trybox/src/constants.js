// packages/src/constants.js

/** trybox 服务端接口 URL */

export const TRYBOX_URLS = {
  catalog: 'https://trybox.app/_serverFn/8071ddde1fc9ba14bf80594e08c4f8cfb030a79f7bcccfe292835b561fae77a4',
  search: 'https://trybox.app/_serverFn/4554bac009cb7b0dd4f23b35e6381cde80f8891f6cd2c529ecb25d91e64f42ba',
  meta: 'https://trybox.app/_serverFn/44b25540de850d9a6aa33c2f3333282561e7954b1805fa7e0ab1e5862f1123bc',
  episodes: 'https://trybox.app/_serverFn/e554914846470475f9970c596196d2e827879f8fdf88f392107c1218acba9687',
  subtitle: 'https://trybox.app/api/public/subtitles',
  stream: 'https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012',
};

/** Supabase 配置（token 刷新用） */
export const TMDB_API = {
  base: 'https://tmdb.demojameson.de5.net/3',
  defaultKey: '',  // 由 env.TMDB_KEY 或用户配置提供
};

export const SUPABASE = {
  url: 'https://saichcuwzbncuqnqhuul.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWNoY3V3emJuY3VxbnFodXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTg4MjUsImV4cCI6MjA5OTk3NDgyNX0.v0KsTzaaiHUTvtA_W-HuAOQul3E7cxnbw4Kiy9hFVus',
};

/** 默认配置 */
export const DEFAULTS = {
  LANG: 'zh-CN',
  REFRESH_TOKEN: 'axmnt7pfwkrx',
  ACCESS_TOKEN: '',
  ENABLED_CATALOGS: ['topRated', 'movie', 'tv'],
  ENABLED_FEATURES: ['catalog', 'search', 'meta', 'subtitle', 'stream'],

  // 字幕首选语言：'zh' | 'en' | 'zh-en'
  SUBTITLE_LANG: 'zh-en',

  // 默认剔除 IP 绑定 URL
  REMOVE_ID_VALIDATION: true,
};

/** Catalog 配置 */
export const CATALOG_CONFIG = {
  home: { id: 'trybox_home', name: 'TryBox 首页', type: 'mixed' },
  movie: { id: 'trybox_movie', name: 'TryBox 电影', type: 'movie' },
  tv: { id: 'trybox_tv', name: 'TryBox 剧集', type: 'series' },
  trending: { id: 'trybox_trending', name: 'TryBox 热门', type: 'mixed' },
  popular: { id: 'trybox_popular', name: 'TryBox 流行', type: 'mixed' },
  topRated: { id: 'trybox_topRated', name: 'TryBox 高分', type: 'mixed' },
  secondary: { id: 'trybox_secondary', name: 'TryBox 剧集精选', type: 'series' },
  tertiary: { id: 'trybox_tertiary', name: 'TryBox 经典剧集', type: 'series' },
};

/** Genre → trybox preset 映射 */
export const GENRE_MAP = {
  movie: {
    '动作': 'movie_action',
    '喜剧': 'movie_comedy',
    '科幻': 'movie_scifi',
    '恐怖': 'movie_horror',
    '家庭': 'movie_family',
  },
  series: {
    '犯罪': 'tv_crime',
    '科幻': 'tv_scifi_fantasy',
  },
};

/** 字幕语言映射（仅保留中英文） */
export const LANG_MAP = {
  zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh',
  'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hk': 'zh',
  en: 'en', eng: 'en', english: 'en',
  'en-us': 'en', 'en-gb': 'en',
};

/** 缓存 TTL（秒） */
export const TTL = {
  // Token
  TOKEN_LOCK: 30,
  TOKEN_MEMORY: 10,

  // Catalog（浏览）
  CATALOG_L1: 60,
  CATALOG_REDIS: 300,
  CATALOG_CDN: 300,

  // Detail（meta 详情）
  DETAIL_L1: 60,
  DETAIL_REDIS: 1800,

  // Episodes（剧集列表）
  EPISODES_L1: 60,
  EPISODES_REDIS: 1800,

  // Search
  SEARCH_L1: 60,
  SEARCH_REDIS: 1800,
  SEARCH_CDN: 300,

  // Subtitle
  SUBTITLE_L1: 60,
  SUBTITLE_REDIS: 86400,
  SUBTITLE_CDN: 3600,

  // Stream
  STREAM_L1: 60,
  STREAM_REDIS: 180,
  STREAM_CDN: 60,

  // Stream negative cache
  STREAM_NEG_REDIS: 300,

  // IMDb → TMDB 映射（规范：IMDb 映射 7 天）
  IMDB_TO_TMDB_L1: 86400,     // 1 天（isolate 内存）
  IMDB_TO_TMDB_REDIS: 604800, // 7 天（Redis）
};