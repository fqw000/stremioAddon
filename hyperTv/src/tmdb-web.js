// TMDB 网页版中文元数据兜底：无需 API Key，直接解析 www.themoviedb.org?language=zh-CN
// 中文标题 / 中文简介 / 中文海报与背景均来自 zh-CN 页面，不是英文 API 结果
import { cached } from './cache.js';
import { logThrottled, normalizeText } from './helper.js';
import { loggedFetch } from './http-log.js';

const WEB = 'https://www.themoviedb.org';
const DAY = 86400000;
const BLOCK_MS = 5 * 60 * 1000;

// TMDB 网页对短时间高并发会返回 403；触发后熔断 5 分钟，避免目录页并发补中文时
// 逐条刷屏、且每条都白等 9s 超时。中文元数据仍有 TMDB API（zh-CN）可用。
let blockedUntil = 0;
function webBlocked() {
  return Date.now() < blockedUntil;
}
export function webBlockStatus() {
  return { blocked: webBlocked(), until: blockedUntil, reason: blockedUntil ? '403/429' : '' };
}

async function fetchHtml(url, ms = 9000) {
  if (webBlocked()) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const label = new URL(url).pathname;
  try {
    const r = await loggedFetch(
      url,
      {
        signal: ctrl.signal,
        redirect: 'follow',
        // 实测 TMDB 网页对常见浏览器 UA 返回 403，用 curl UA + */* 可稳定拿到 zh-CN 页面
        headers: { 'accept-language': 'zh-CN,zh;q=0.9', accept: '*/*', 'user-agent': 'curl/8.7.1' },
      },
      { tag: 'tmdb-web', label: 'TMDB 网页' },
    );
    if (r.status === 403 || r.status === 429) {
      blockedUntil = Date.now() + BLOCK_MS;
      logThrottled(
        'warn',
        'tmdb-web',
        'web-blocked',
        `${label} HTTP ${r.status}：TMDB 网页限流，已熔断中文网页兜底 ${BLOCK_MS / 60000} 分钟（中文元数据改由 TMDB API 提供）`,
        60000,
      );
      return '';
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    logThrottled('warn', 'tmdb-web', 'web-error', `${label} ${e.message}`, 60000);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function decode(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function strip(s) {
  return decode(s).replace(/\s*\(\d{4}\)\s*$/, '');
}

function imagePath(url, size = 'w500') {
  const m = /\/t\/p\/[^/]+\/([^"?\s]+)/.exec(String(url || ''));
  return m ? `https://image.tmdb.org/t/p/${size}/${m[1]}` : '';
}

function runtimeMinutes(raw) {
  const s = decode(raw);
  const h = /(\d+)\s*h/.exec(s);
  const m = /(\d+)\s*m/.exec(s);
  const n = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return n > 0 ? n : null;
}

// 搜索结果页已包含中文片名、中文简介和中文海报，无需再逐条打开详情页
function parseSearch(html, media) {
  const out = [];
  for (const chunk of String(html || '').split('class="comp:media-card').slice(1)) {
    const href = /href="\/(movie|tv)\/(\d+)[^"]*"/.exec(chunk);
    const h2 = /<h2[^>]*>\s*<span>([\s\S]*?)<\/span>/.exec(chunk);
    if (!href || !h2) continue;
    const original = /<span class="font-light">\s*\(([\s\S]*?)\)\s*<\/span>/.exec(chunk);
    const year = /<span class="release_date[^"]*">\s*(\d{4})/.exec(chunk);
    const overview = /<div class="mt-4[^"]*">\s*<p>([\s\S]*?)<\/p>/.exec(chunk);
    const poster = /srcset="(https:\/\/media\.themoviedb\.org\/t\/p\/[^"\s]+)/.exec(chunk);
    out.push({
      tmdbId: Number(href[2]),
      type: media === 'tv' ? 'series' : 'movie',
      title: strip(h2[1]),
      originalTitle: original ? decode(original[1]) : strip(h2[1]),
      year: year ? Number(year[1]) : null,
      overview: overview ? decode(overview[1]).slice(0, 1200) : '',
      poster: imagePath(poster?.[1], 'w500') || '',
      background: '',
      rating: 0,
      genres: [],
      cast: [],
      director: [],
      runtime: null,
      imdbId: '',
    });
    if (out.length >= 20) break;
  }
  return out;
}

function jsonLdNames(html, field) {
  const m = new RegExp(`"${field}":\\[([\\s\\S]*?)\\]`).exec(String(html || ''));
  if (!m) return [];
  return [...m[1].matchAll(/"name":"((?:\\.|[^"\\])*)"/g)]
    .map((x) => decode(x[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))))
    .slice(0, 12);
}

function parseDetail(html, media, tmdbId) {
  if (!html) return null;
  const title = /<h2 class="4">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(html);
  const overview = /<div class="overview"[^>]*>\s*<p>([\s\S]*?)<\/p>/.exec(html);
  const imdb = /imdb\.com\/title\/(tt\d+)/.exec(html);
  const genresBlock = /<span class="genres">([\s\S]*?)<\/span>/.exec(html);
  const genres = genresBlock
    ? [...genresBlock[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((x) => decode(x[1]))
    : [];
  const runtime = /<span class="runtime">([\s\S]*?)<\/span>/.exec(html);
  const score = /data-percent="(\d+)"/.exec(html);
  const images = [...String(html).matchAll(/<meta property="og:image" content="([^"]+)"/g)].map((x) => x[1]);
  const year = /<span class="tag release_date">\((\d{4})\)/.exec(html);
  return {
    tmdbId,
    type: media === 'tv' ? 'series' : 'movie',
    title: title ? strip(title[1]) : '',
    originalTitle: '',
    year: year ? Number(year[1]) : null,
    overview: overview ? decode(overview[1]).slice(0, 1200) : '',
    poster: imagePath(images[0], 'w500'),
    background: imagePath(images[1], 'w780'),
    rating: score ? Number(score[1]) / 10 : 0,
    genres,
    cast: jsonLdNames(html, 'actor'),
    director: jsonLdNames(html, 'director'),
    runtime: runtimeMinutes(runtime?.[1]),
    imdbId: imdb ? imdb[1] : '',
  };
}

export async function webSearch(query, kind, config, limit = 8) {
  const clean = String(query || '').trim();
  if (!clean || webBlocked()) return [];
  const media = kind === 'series' ? 'tv' : 'movie';
  const lang = config.language === 'original' ? 'en-US' : config.language === 'pt-BR' ? 'pt-BR' : 'zh-CN';
  const url = `${WEB}/search/${media}?query=${encodeURIComponent(clean)}&language=${lang}`;
  const html = await cached(
    `web:search:${media}:${normalizeText(clean)}:${lang}`,
    DAY,
    () => fetchHtml(url),
    { negativeTtlMs: 3600000 },
  );
  return parseSearch(html, media).slice(0, limit);
}

export async function webDetail(tmdbId, kind, config) {
  if (!tmdbId || webBlocked()) return null;
  const media = kind === 'series' ? 'tv' : 'movie';
  const lang = config.language === 'original' ? 'en-US' : config.language === 'pt-BR' ? 'pt-BR' : 'zh-CN';
  const html = await cached(
    `web:detail:${media}:${tmdbId}:${lang}`,
    7 * DAY,
    () => fetchHtml(`${WEB}/${media}/${tmdbId}?language=${lang}`),
    { negativeTtlMs: 3600000 },
  );
  return parseDetail(html, media, tmdbId);
}

// 中文能力：TMDB API 可用，或语言为中文（走网页版兜底）
export function chineseEnabled(config) {
  return !!config && (config.language === 'zh-CN' || config.language === 'pt-BR' || !!config.tmdbApiKey || !!config.tmdbKeyless);
}
