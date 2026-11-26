// TMDB / Cinemeta 元数据与 ID 双向映射
// - 支持三种凭据模式：带 Key、免密代理（服务端内置 Key）、自定义代理 + Key
// - ttid -> 站内条目：标准片名/年份匹配；站内条目 -> ttid：TMDB search + external_ids
import { cached } from './cache.js';
import { getCatalogItems } from './adapter.js';
import { hashId, log, normalizeText, yearFromName } from './helper.js';
import { loggedFetch } from './http-log.js';
import { webDetail, webSearch } from './tmdb-web.js';

const DAY = 86400000;
export const DEFAULT_PROXY = 'https://api.tmdb.org/3';
const CINEMETA = 'https://v3-cinemeta.strem.io';

function timeoutFetch(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return loggedFetch(url, { signal: ctrl.signal }, { tag: 'tmdb', label: 'TMDB API' }).finally(() =>
    clearTimeout(timer),
  );
}

function languageOf(config) {
  return config.language === 'original' ? 'en-US' : config.language || 'zh-CN';
}

function scope(config) {
  return hashId(
    `${config.tmdbApiKey || ''}|${config.tmdbProxy || ''}|${config.tmdbKeyless ? 'keyless' : 'key'}`,
  ).slice(0, 6);
}

// 是否具备 TMDB 查询能力：显式 Key、免密模式，或用户自定义代理（假定服务端已处理凭据）
export function tmdbEnabled(config) {
  if (!config) return false;
  if (config.tmdbApiKey || config.tmdbKeyless) return true;
  const p = String(config.tmdbProxy || '').trim().replace(/\/+$/, '');
  return !!p && p.toLowerCase() !== DEFAULT_PROXY.toLowerCase();
}

// 请求路径拼接：保留代理自带查询参数；官方域名自动补 /3；自定义代理按填写路径原样拼接
export function buildTmdbUrl(config, path, params = {}) {
  const raw = String(config.tmdbProxy || DEFAULT_PROXY).trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (!/^https?:$/i.test(u.protocol)) return '';
  if (/(^|\.)themoviedb\.org$|(^|\.)tmdb\.org$/i.test(u.hostname)) {
    if (!/^\/(v3|3)(\/|$)/i.test(u.pathname)) {
      u.pathname = `/3${u.pathname === '/' ? '' : u.pathname}`;
    }
  }
  const seg = String(path).replace(/^\/+/, '').replace(/\/+$/, '');
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${seg}`;
  for (const [k, v] of new URLSearchParams(params)) u.searchParams.set(k, v);
  if (config.tmdbApiKey) u.searchParams.set('api_key', config.tmdbApiKey);
  return u.toString();
}

async function tmdbGet(config, path, params = {}, timeoutMs = 6000) {
  if (!tmdbEnabled(config)) return null;
  const url = buildTmdbUrl(config, path, params);
  if (!url) return null;
  try {
    const r = await timeoutFetch(url, timeoutMs);
    if (!r.ok) {
      log('tmdb', `${path} HTTP ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    log('tmdb', `${path} ${e.message}`);
    return null;
  }
}

function imageUrl(path, size = 'w500') {
  const p = String(path ?? '');
  if (!p) return '';
  return p.startsWith('/') ? `https://image.tmdb.org/t/p/${size}${p}` : p;
}

function extractYear(date) {
  const n = Number.parseInt(String(date ?? '').slice(0, 4), 10);
  return Number.isFinite(n) ? n : null;
}

function hasCjk(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ''));
}

function people(credits, job) {
  const list = Array.isArray(credits?.cast) ? credits.cast : [];
  const crew = Array.isArray(credits?.crew) ? credits.crew : [];
  if (job) return crew.filter((p) => p.job === job).slice(0, 5).map((p) => p.name).filter(Boolean);
  return list.slice(0, 12).map((p) => p.name).filter(Boolean);
}

function normalizeResult(r, mediaType, imdbId = '') {
  if (!r) return null;
  const credits = r.credits || {};
  return {
    imdbId: imdbId || r.imdb_id || '',
    tmdbId: r.id || null,
    type: mediaType === 'tv' ? 'series' : 'movie',
    title: r.title || r.name || '',
    originalTitle: r.original_title || r.original_name || '',
    year: extractYear(r.release_date || r.first_air_date),
    releaseDate: r.release_date || r.first_air_date || '',
    overview: String(r.overview || '').slice(0, 1200),
    poster: imageUrl(r.poster_path, 'w500'),
    background: imageUrl(r.backdrop_path, 'w780'),
    rating: Number(r.vote_average) || 0,
    genres: Array.isArray(r.genres) ? r.genres.map((g) => g.name).filter(Boolean) : [],
    cast: people(credits),
    director: people(credits, 'Director'),
    runtime: Number(r.runtime) || null,
    altTitles: Array.isArray(r.altTitles) ? r.altTitles : [],
  };
}

// 站点片名为葡语：补充 TMDB 的 pt-BR / pt-PT 译名，供 ttid -> 站内条目精确匹配
async function fetchAltTitles(config, media, tmdbId) {
  if (!tmdbId) return [];
  const data = await cached(
    `tt:i18n:${scope(config)}:${media}:${tmdbId}`,
    7 * DAY,
    () => tmdbGet(config, `${media}/${tmdbId}/translations`),
    { negativeTtlMs: DAY },
  );
  const list = Array.isArray(data?.translations) ? data.translations : [];
  const titles = [];
  for (const t of list) {
    const country = String(t?.iso_3166_1 || '');
    const lang = String(t?.iso_639_1 || '');
    if (!/^(BR|PT)$/i.test(country) && !/^pt/i.test(lang)) continue;
    const value = String(t?.data?.title || t?.data?.name || '').trim();
    if (value && !titles.includes(value)) titles.push(value);
  }
  return titles;
}

// ttid -> 标准元数据（TMDB 优先，Cinemeta 免 Key 兜底）
export async function fetchImdbMeta(imdbId, type, config, withDetail = false, withAliases = false) {
  const id = String(imdbId || '');
  if (!/^tt\d{5,10}$/i.test(id) || type === 'channel') return null;
  const lang = languageOf(config);
  const media = type === 'series' ? 'tv' : 'movie';

  const found = await cached(
    `tt:find:${scope(config)}:${id}:${lang}`,
    7 * DAY,
    () => tmdbGet(config, `find/${id}`, { external_source: 'imdb_id', language: lang }),
    { negativeTtlMs: 3600000 },
  );
  let result =
    (media === 'tv' ? found?.tv_results?.[0] : found?.movie_results?.[0]) ||
    found?.movie_results?.[0] ||
    found?.tv_results?.[0];

  if (result && withDetail) {
    const detail = await cached(
      `tt:detail:${scope(config)}:${media}:${result.id}:${lang}`,
      7 * DAY,
      () => tmdbGet(config, `${media}/${result.id}`, { append_to_response: 'external_ids,credits', language: lang }),
      { negativeTtlMs: 3600000 },
    );
    if (detail && typeof detail === 'object') result = { ...result, ...detail };
  }
  if (result) {
    const aliasSource = String(result.title || result.name || '');
    if (config.language === 'zh-CN' && !hasCjk(aliasSource)) {
      const hit = (await webSearch(aliasSource, media, config, 1))[0];
      if (hit && hasCjk(hit.title)) {
        result = {
          ...result,
          ...hit,
          title: hit.title,
          poster_path: hit.poster || result.poster_path,
          backdrop_path: hit.background || result.backdrop_path,
        };
      }
    }
    const normalized = normalizeResult(result, media, id);
    if (withAliases && result.id) {
      const titles = await fetchAltTitles(config, media, result.id);
      if (titles.length) normalized.altTitles = [...new Set([aliasSource, ...titles])].filter(Boolean);
    }
    return normalized;
  }

  const cine = await cached(
    `tt:cinemeta:${id}`,
    7 * DAY,
    () => timeoutFetch(`${CINEMETA}/meta/${media === 'tv' ? 'series' : 'movie'}/${id}.json`).then((r) =>
      r.ok ? r.json() : null,
    ),
    { negativeTtlMs: 3600000 },
  );
  const m = cine?.meta;
  if (!m?.name) return null;

  // 无 API 凭据时，用 Cinemeta 的片名去 TMDB 中文网页反查，拿中文标题/简介/海报
  if (config.language !== 'original') {
    const hit = (await webSearch(m.name, media, config, 1))[0];
    if (hit) {
      const detail = withDetail ? await webDetail(hit.tmdbId, media, config) : null;
      return {
        ...hit,
        ...(detail || {}),
        imdbId: id,
        title: detail?.title || hit.title || m.name,
        year: detail?.year || hit.year || Number(m.year) || null,
      };
    }
  }

  return {
    imdbId: id,
    tmdbId: null,
    type: media === 'tv' ? 'series' : 'movie',
    title: m.name,
    originalTitle: m.name,
    year: Number(m.year) || null,
    overview: String(m.description || '').slice(0, 1200),
    poster: m.poster || '',
    background: m.background || '',
    rating: Number(m.imdbRating) || 0,
    genres: Array.isArray(m.genres) ? m.genres : [],
    cast: Array.isArray(m.cast) ? m.cast.slice(0, 12) : String(m.cast || '').split(',').map((x) => x.trim()).filter(Boolean),
    director: Array.isArray(m.director) ? m.director : String(m.director || '').split(',').map((x) => x.trim()).filter(Boolean),
    runtime: Number(m.runtime) || null,
  };
}

// 站内条目 -> TMDB 标准元数据（含中文标题、imdb_id）
export async function searchByTitle(title, year, kind, config, withImdb = false) {
  if (!title) return null;
  if (!tmdbEnabled(config) && config.language === 'original') return null;
  const lang = languageOf(config);
  const media = kind === 'series' ? 'tv' : 'movie';
  const clean = String(title).replace(/\((19|20)\d{2}\)/, '').trim();
  const params = { query: clean, language: lang };
  if (year) params[media === 'tv' ? 'first_air_date_year' : 'year'] = year;
  const key = `tt:search:${scope(config)}:${media}:${normalizeText(clean)}:${year || ''}:${lang}:${withImdb ? 'full' : 'short'}`;

  const data = await cached(key, 7 * DAY, () => tmdbGet(config, `search/${media}`, params), {
    negativeTtlMs: 3600000,
  });
  let first = data?.results?.[0];
  let fromWeb = false;
  if (!first && config.language !== 'original') {
    const hits = await webSearch(clean, kind, config, 1);
    if (hits[0]) {
      first = hits[0];
      fromWeb = true;
    }
  }
  if (!first) return null;

  if (fromWeb) {
    const detail = withImdb ? await webDetail(first.tmdbId, media, config) : null;
    return {
      ...first,
      ...(detail || {}),
      type: media === 'tv' ? 'series' : 'movie',
      imdbId: detail?.imdbId || first.imdbId || '',
    };
  }

  let detail = {};
  let imdbId = '';
  if (withImdb) {
    detail = await cached(
      `tt:detail:${scope(config)}:${media}:${first.id}:${lang}`,
      7 * DAY,
      () => tmdbGet(config, `${media}/${first.id}`, { append_to_response: 'external_ids,credits', language: lang }),
      { negativeTtlMs: 3600000 },
    ) || {};
    imdbId = detail?.external_ids?.imdb_id || '';
  }
  let merged = { ...first, ...detail };
  // API 命中但没有中文标题时，用 zh-CN 网页结果覆盖标题/简介/海报
  if (config.language === 'zh-CN' && !hasCjk(merged.title || merged.name)) {
    const hit = (await webSearch(clean, kind, config, 1))[0];
    if (hit && hasCjk(hit.title)) {
      merged = {
        ...merged,
        ...hit,
        title: hit.title,
        poster_path: hit.poster || merged.poster_path,
        backdrop_path: hit.background || merged.backdrop_path,
      };
    }
  }
  return normalizeResult(merged, media, imdbId);
}

// 搜索增强：返回多个候选（中文标题 + 原名 + imdb_id），供站内片名匹配
export async function searchTmdbMulti(query, kind, config, limit = 8) {
  if (!query) return [];
  if (!tmdbEnabled(config) && config.language === 'original') return [];
  const lang = languageOf(config);
  const media = kind === 'series' ? 'tv' : 'movie';
  const clean = String(query).trim();
  const data = await cached(
    `tt:multi:${scope(config)}:${media}:${normalizeText(clean)}:${lang}`,
    DAY,
    () => tmdbGet(config, `search/${media}`, { query: clean, language: lang, include_adult: false }),
    { negativeTtlMs: 3600000 },
  );
  const apiResults = (data?.results || []).slice(0, limit).map((r) => normalizeResult(r, media));
  if (apiResults.length || config.language === 'original') return apiResults;
  return webSearch(clean, kind, config, limit);
}

// Xtream get_vod_info 会给出 info.tmdb_id，用 external_ids 反查 imdb_id 比片名匹配可靠得多
export async function fetchImdbIdByTmdbId(tmdbId, media, config) {
  const id = Number(tmdbId);
  if (!Number.isFinite(id) || id <= 0) return '';
  const data = await cached(
    `tt:extids:${scope(config)}:${media}:${id}`,
    7 * DAY,
    () => tmdbGet(config, `${media}/${id}/external_ids`),
    { negativeTtlMs: DAY },
  );
  const value = String(data?.imdb_id || '');
  return /^tt\d{5,10}$/i.test(value) ? value : '';
}

// ttid -> TMDB ID（vidzee 字幕源按 TMDB ID 索引）
export async function fetchTmdbIdByImdb(imdbId, media, config) {
  const id = String(imdbId || '');
  if (!/^tt\d{5,10}$/i.test(id)) return 0;
  if (!tmdbEnabled(config)) return 0;
  const found = await cached(
    `tt:findid:${scope(config)}:${id}`,
    7 * DAY,
    () => tmdbGet(config, `find/${id}`, { external_source: 'imdb_id' }),
    { negativeTtlMs: DAY },
  );
  const tv = media === 'series' || media === 'tv';
  const hit = tv ? (found?.tv_results?.[0] || found?.movie_results?.[0]) : (found?.movie_results?.[0] || found?.tv_results?.[0]);
  return Number(hit?.id) || 0;
}

// 站内条目 -> imdb_id（字幕接口的入口）
export async function resolveImdbIdForItem(item, kind, config) {
  if (!item) return '';
  const direct = String(item.imdb_id || item.imdbId || '');
  if (/^tt\d{5,10}$/i.test(direct)) return direct;
  const meta = await searchByTitle(item.title || item.name, item.year || yearFromName(item.name), kind, config, true);
  return meta?.imdbId || '';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'or', 'in', 'on', 'at', 'to', 'for',
  'o', 'os', 'a', 'as', 'e', 'de', 'da', 'do', 'das', 'dos', 'um', 'uma',
  'uns', 'umas', 'no', 'na', 'em', 'com', 'por', 'para', 'que', 'i',
]);

function stripName(s) {
  return normalizeText(s)
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return [...new Set(stripName(s).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w)))];
}

function buildIndex(items) {
  const map = new Map();
  for (const item of items) {
    for (const raw of [item.title, item.name]) {
      if (!raw) continue;
      const k = stripName(raw);
      if (k && !map.has(k)) map.set(k, { item, words: tokens(k) });
    }
  }
  return map;
}

function yearMatches(item, year, strict = false) {
  if (!year) return true;
  const y = Number(item.year || yearFromName(item.name));
  // 站内条目没有年份时只允许精确匹配，避免 "The Good Life" 误命中 "The Good Dinosaur"
  if (!y) return !strict;
  return Math.abs(y - Number(year)) <= 1;
}

function fuzzyScore(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const shared = b.filter((w) => a.includes(w)).length;
  if (shared < 2) return 0;
  const coverage = shared / b.length;
  const jaccard = shared / new Set([...a, ...b]).size;
  if (coverage < 0.8 || jaccard < 0.5) return 0;
  return Math.min(1, 0.7 + coverage * 0.3);
}

// 标准片名/年份 -> 片库条目（精确索引优先，模糊匹配要求实词高度重合且年份一致）
export async function matchInCatalog(items, meta, kind, indexKey, trace) {
  if (!Array.isArray(items) || !meta?.title) return null;
  const head = String(items[0]?.stream_id ?? items[0]?.series_id ?? items[0]?.key ?? '');
  const index = await cached(`${indexKey}:${hashId(head)}`, 30 * 60000, () => buildIndex(items));
  const rawCandidates = [meta.title, meta.originalTitle, ...(meta.altTitles || [])].filter(Boolean);
  const candidates = [...new Set(rawCandidates.map(stripName))].filter((x) => x.length >= 3);
  const step = trace ? { kind, count: items.length, titles: [...new Set(rawCandidates)], candidates } : null;
  if (step) (trace.match ||= []).push(step);
  if (!candidates.length) return null;

  for (const c of candidates) {
    const hit = index.get(c);
    if (hit && yearMatches(hit.item, meta.year)) {
      if (step) step.matchedBy = 'exact';
      return hit.item;
    }
  }

  let best = null;
  let bestScore = 0;
  const candidateWords = candidates.map(tokens);
  for (const [key, entry] of index) {
    if (entry.words.length < 2 || !yearMatches(entry.item, meta.year, true)) continue;
    for (let i = 0; i < candidateWords.length; i++) {
      const score = fuzzyScore(entry.words, candidateWords[i]);
      if (score > bestScore) {
        bestScore = score;
        best = entry.item;
        if (step) step.best = { key, score, id: entry.item.stream_id ?? entry.item.series_id ?? entry.item.key };
      }
    }
  }
  if (best && bestScore >= 0.7) {
    if (step) step.matchedBy = 'fuzzy';
    return best;
  }
  return null;
}

// ttid -> 站内条目（供 stream / meta 使用；trace 用于调试模式诊断）
export async function resolveImdbToCatalog(imdbId, type, config, prefix, trace) {
  const meta = await fetchImdbMeta(imdbId, type, config, false, true);
  if (trace) {
    trace.tmdb = {
      enabled: tmdbEnabled(config),
      title: meta?.title || '',
      originalTitle: meta?.originalTitle || '',
      altTitles: meta?.altTitles || [],
      year: meta?.year || null,
    };
  }
  if (!meta?.title) {
    if (trace) trace.error = 'TMDB / Cinemeta 未返回该 IMDb ID 的元数据';
    return null;
  }
  const kinds = type === 'series' ? ['series'] : type === 'movie' ? ['movie'] : ['movie', 'series'];
  for (const kind of kinds) {
    const items = await getCatalogItems(config.source, kind);
    const item = await matchInCatalog(items, meta, kind, `${prefix}:${kind}:${items.length}`, trace);
    if (item) {
      if (trace) trace.matched = { kind, id: item.stream_id ?? item.series_id ?? item.key, name: item.name || item.title };
      return { item, kind, meta };
    }
  }
  return null;
}
