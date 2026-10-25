/**
 * Stremio Manifest 动态生成
 * 根据用户配置决定暴露哪些 catalog 和功能
 */

import { CATALOG_CONFIG, GENRE_MAP, DEFAULTS } from './constants.js';

const ADDON_ID = 'com.trybox';
const ADDON_VERSION = '1.0.0';

/** 每个 catalog 实际包含的类型（依据 trybox 探针实测） */
const CATALOG_TYPES = {
  topRated: ['movie'],
  popular: ['movie'],
  trending: ['movie', 'series'],
  secondary: ['series'],
  tertiary: ['series'],
  movie: ['movie'],
  tv: ['series'],
  home: ['movie', 'series'],
};

/** 用户配置的 feature key → Stremio 资源名 */
const FEATURE_TO_RESOURCE = {
  catalog: 'catalog',
  meta: 'meta',
  subtitle: 'subtitles',
  stream: 'stream',
};

export function getManifest(userConfig) {
  const enabledCatalogs = userConfig.enabledCatalogs || DEFAULTS.ENABLED_CATALOGS;
  const enabledFeatures = userConfig.enabledFeatures || DEFAULTS.ENABLED_FEATURES;

  // ========== catalogs ==========
  const catalogs = [];
  for (const key of enabledCatalogs) {
    const cfg = CATALOG_CONFIG[key];
    if (!cfg) continue;

    const types = CATALOG_TYPES[key] || ['movie', 'series'];
    for (const type of types) {
      const extra = [];
      // 只有启用了 search 功能，才在 catalog 里暴露 search
      if (enabledFeatures.includes('search')) {
        extra.push({ name: 'search', isRequired: false });
      }
      extra.push({ name: 'skip', isRequired: false });

      const genres = GENRE_MAP[type];
      if (genres) {
        extra.push({
          name: 'genre',
          isRequired: false,
          options: Object.keys(genres),
        });
      }

      catalogs.push({
        type,
        id: cfg.id,
        name: cfg.name,
        extra,
      });
    }
  }

  // ========== resources ==========
  const resources = [];
  for (const feat of enabledFeatures) {
    const resourceName = FEATURE_TO_RESOURCE[feat];
    if (!resourceName) continue;

    if (feat === 'catalog') {
      resources.push({
        name: 'catalog',
        types: ['movie', 'series'],
        idPrefixes: ['trybox_', 'tt'],
      });
    } else if (feat === 'meta') {
      resources.push({
        name: 'meta',
        types: ['movie', 'series'],
        idPrefixes: ['trybox_'],
      });
    } else if (feat === 'subtitle') {
      resources.push({
        name: 'subtitles',
        types: ['movie', 'series'],
        idPrefixes: ['trybox_', 'tt'],
      });
    } else if (feat === 'stream') {
      resources.push({
        name: 'stream',
        types: ['movie', 'series'],
        idPrefixes: ['trybox_', 'tt'],
      });
    }
  }

  const types = new Set();
  for (const r of resources) {
    for (const t of r.types) types.add(t);
  }

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'TryBox',
    description: 'TryBox 影视聚合',
    logo: 'https://trybox.app/favicon.ico',
    catalogs,
    resources,
    types: [...types],
    idPrefixes: ['trybox_'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}
