/**
 * Subtitle Handler
 *
 * 输入 id 格式：
 *   - trybox_{tmdbId}[:season:episode]：走 meta 拿 imdb_id
 *   - tt{imdbId}[:season:episode]：直接用 imdbId
 *
 * 缓存：
 *   - subtitle:{imdbId}:{lang}
 *
 * 认证：
 *   - subtitle 底层接口与 stream 一致，需要 access_token
 *   - token 获取/刷新统一由 token.js 管理，prefix 必须与 stream 保持一致
 *     （env.APP_PREFIX || 'tryboxStream:prod'），避免各自 refresh 互相顶掉
 *   - token 失败属于全局问题 → fetcher 抛错，不写缓存（不污染 subtitle 缓存）
 */

import { createLogger } from '../logger.js';
import { TRYBOX_URLS, LANG_MAP, TTL } from '../constants.js';
import { buildApiHeaders, buildStreamHeaders } from '../headers.js';
import { getText } from '../http.js';
import { withCache } from '../cache.js';
import { getAccessToken } from '../token.js';
import { getMeta } from './meta.js';

const log = createLogger('Subtitle');

function normalizeLang(raw) {
  if (!raw) return null;
  return LANG_MAP[raw.toLowerCase().trim()] || null;
}

async function fetchSubtitles(env, config, imdbId, lang) {
  log.info('==================== Subtitle 底层接口请求 ==================');
  log.info(`📖 请求字幕: ${TRYBOX_URLS.subtitle}?imdb_id=${imdbId}${lang ? `&language=${lang}` : ''}`);

  const key = `subtitle:${imdbId}:${lang || 'all'}`;
  const { value, fromCache } = await withCache({
    env,
    key,
    l1Ttl: TTL.SUBTITLE_L1,
    redisTtl: TTL.SUBTITLE_REDIS,
    fetcher: async () => {
      // ─── 1. 获取 access_token（与 stream 完全一致，prefix 必须相同以共享 token / refresh 机制）───
      // token 失败属于全局问题：抛错 → withCache 不写缓存，避免把故障缓存住
      let accessToken;
      try {
        accessToken = await getAccessToken(
          env,
          env.APP_PREFIX || 'tryboxStream:prod',
          config
        );
      } catch (e) {
        log.error('获取 access_token 失败:', e.message);
        throw e;
      }
      if (!accessToken) {
        log.error('access_token 为空，imdbId=' + imdbId);
        throw new Error('access_token empty');
      }

      // ─── 2. 使用 stream 的 header 构建方法（含 authorization 等认证字段）───
      const headers = buildStreamHeaders(accessToken, config.lang || 'zh-CN');

      // ─── 3. GET + query（保持原请求方式不变）───
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
  // getMeta 仍使用无认证 header（本次不改 meta 请求）
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

  // 传给 API 的 language 参数
  let apiLang = null;
  if (subLang === 'zh') apiLang = 'zh-CN';
  else if (subLang === 'en') apiLang = 'en';
  // zh-en 保持 null（全量，本地过滤）
  const subs = await fetchSubtitles(env, config, imdbId, apiLang);


// 每个语种最多返回多少条（可被 config 覆盖）
  const perLangLimit = Number(config.subtitlePerLangLimit) || 50;

  const result = [];
  const langCount = { zh: 0, en: 0 };
  let truncated = 0;

  for (const s of subs) {
    const normalizedLang = normalizeLang(s.language);
    if (!normalizedLang) continue;

    if (subLang === 'zh' && normalizedLang !== 'zh') continue;
    if (subLang === 'en' && normalizedLang !== 'en') continue;

    // 每语种配额
    if (langCount[normalizedLang] >= perLangLimit) {
      truncated++;
      continue;
    }
    langCount[normalizedLang]++;

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


    // 用来核对底层接口字幕language类型  临时测试。
  const langDist = {};
  for (const s of subs) {
    const k = JSON.stringify(s.language) + ' | ' + (s.label || s.name || '');
    langDist[k] = (langDist[k] || 0) + 1;
  }
   log.info(
    `返回 ${result.length}/${subs.length} 条字幕（subLang=${subLang}, ` +
    `zh=${langCount.zh}, en=${langCount.en}, 每语种上限=${perLangLimit}, 截断=${truncated}）`
  );
  return { subtitles: result };
}