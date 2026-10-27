/**
 * Subtitle Handler
 *
 * 输入 id 格式：
 *   - trybox_{tmdbId}[:season:episode]：走 meta 拿 imdb_id
 *   - tt{imdbId}[:season:episode]：直接用 imdbId
 *
 * 缓存：
 *   - subtitle:{imdbId}:{lang}
 */

import { createLogger } from '../logger.js';
import { TRYBOX_URLS, LANG_MAP, TTL } from '../constants.js';
import { buildApiHeaders } from '../headers.js';
import { getText } from '../http.js';
import { withCache } from '../cache.js';
import { getMeta } from './meta.js';

const log = createLogger('Subtitle');

function normalizeLang(raw) {
  if (!raw) return null;
  return LANG_MAP[raw.toLowerCase().trim()] || null;
}

async function fetchSubtitles(env, headers, imdbId, lang) {
  const key = `subtitle:${imdbId}:${lang || 'all'}`;
  const { value, fromCache } = await withCache({
    env,
    key,
    l1Ttl: TTL.SUBTITLE_L1,
    redisTtl: TTL.SUBTITLE_REDIS,
    fetcher: async () => {
      const params = new URLSearchParams();
      params.set('imdb_id', imdbId);
      params.set('v', '8');
      if (lang) params.set('language', lang);
      const url = `${TRYBOX_URLS.subtitle}?${params.toString()}`;
      const raw = await getText(url, headers);
      const data = JSON.parse(raw);
      return Array.isArray(data.subtitles) ? data.subtitles : [];
    },
  });
  log.info(`字幕 ${fromCache ? '命中缓存' : '回源'}: imdb=${imdbId}`);
  return value;
}

export async function subtitleHandler({ type, id, config, env }) {
  const lang = config.lang || 'zh-CN';
  const headers = buildApiHeaders(lang);

  // 解析 id，决定 imdbId 的来源
  let imdbId = null;

  // 1. tt{imdbId}[:season:episode]
  const imdbMatch = id.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
  if (imdbMatch) {
    imdbId = imdbMatch[1];
    log.info(`收到 tt 格式，直接使用: ${imdbId}`);
  }
  // 2. trybox_{tmdbId}[:season:episode]
  else {
    const tryboxMatch = id.match(/^trybox_(\d+)(?::(\d+):(\d+))?$/);
    if (!tryboxMatch) {
      log.warn(`无法解析 id: ${id}`);
      return { subtitles: [] };
    }
    const tmdbId = tryboxMatch[1];
    const tryboxType = type === 'series' ? 'tv' : 'movie';

    const meta = await getMeta(env, headers, tryboxType, tmdbId);
    imdbId = meta?.imdb_id;
    if (!imdbId) {
      log.warn(`未找到 imdb_id: tmdb=${tmdbId}`);
      return { subtitles: [] };
    }
  }

  // 字幕语言偏好：'zh' | 'en' | 'zh-en'
  const subLang = config.subtitleLang || 'zh-en';

  // // 传给 API 的 language 参数
  let apiLang = null;
  if (subLang === 'zh') apiLang = 'zh-CN';
  else if (subLang === 'en') apiLang = 'en';
// zh-en 保持 null（全量，本地过滤）
  const subs = await fetchSubtitles(env, headers, imdbId, apiLang);

  const result = [];
  for (const s of subs) {
    const normalizedLang = normalizeLang(s.language);
    if (!normalizedLang) continue;

    if (subLang === 'zh' && normalizedLang !== 'zh') continue;
    if (subLang === 'en' && normalizedLang !== 'en') continue;

    const TRYBOX_BASE = 'https://trybox.app';

    function toAbsoluteUrl(raw) {
      if (!raw) return '';
      if (/^https?:\/\//.test(raw)) return raw;
      return `${TRYBOX_BASE}${raw.startsWith('/') ? raw : '/' + raw}`;
    }

    result.push({
      id: s.id || `trybox_${imdbId}_${result.length}`,
      url: toAbsoluteUrl(s.url),
      lang: normalizedLang,
    });
  }

  log.info(`返回 ${result.length}/${subs.length} 条字幕（subLang=${subLang}）`);
  return { subtitles: result };
}