'use strict';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const logger = require('./logger');

// 简单的内存缓存：key -> { value, expireAt }
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && hit.expireAt > Date.now()) return hit.value;
  if (hit) cache.delete(key);
  return null;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expireAt: Date.now() + ttlMs });
}

async function httpGet(url, options = {}) {
  // 网络级错误（fetch failed / SSL 重协商抖动 / 超时）重试 1 次；
  // HTTP 4xx/5xx 不重试（404 多为节目下线，重试无意义）。
  try {
    return await httpGetOnce(url, options);
  } catch (e) {
    if (/^HTTP \d+/.test(e.message || '')) throw e;
    logger.warn('UPSTREAM', '← 网络异常，重试 1 次', { upstreamUrl: url, error: e.message });
    return httpGetOnce(url, options);
  }
}

async function httpGetOnce(url, { timeout = 15000, ttl = 0 } = {}) {
  if (ttl > 0) {
    const cached = cacheGet('http:' + url);
    if (cached) {
      logger.debug('UPSTREAM', '← 缓存命中（未请求源站）', { upstreamUrl: url, cacheTtlMs: ttl });
      return cached;
    }
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  logger.debug('UPSTREAM', '→ 请求源站', { upstreamUrl: url, method: 'GET', timeoutMs: timeout, cache: ttl > 0 });
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      logger.error('UPSTREAM', `← HTTP ${res.status}（失败） ${url}`, {
        upstreamUrl: url, status: res.status, durationMs: Date.now() - started
      });
      throw err;
    }
    const text = await res.text();
    if (ttl > 0) cacheSet('http:' + url, text, ttl);
    logger.info('UPSTREAM', `← HTTP ${res.status} ${url}`, {
      upstreamUrl: url,
      status: res.status,
      bytes: Buffer.byteLength(text),
      durationMs: Date.now() - started,
      contentType: res.headers.get('content-type') || ''
    });
    return text;
  } catch (e) {
    if (!/^HTTP \d+/.test(e.message)) {
      logger.error('UPSTREAM', `← 请求异常 ${url}: ${e.message}`, {
        upstreamUrl: url, error: e.message, durationMs: Date.now() - started
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function httpGetJson(url, options) {
  const text = await httpGet(url, options);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 120)}`);
  }
}

// 央视部分老旧分集 URL（日期路径过期）不会返回 HTTP 3xx，而是返回一个只有
// window.location.href='...' 的极小 HTML 跳转桩页。fetch() 不会执行 JS，
// 于是页面里既没有 guid 也没有 meta，stream 解析会静默返回 0 条。
// 这里只对「轻量跳转桩页」做跟随，避免误伤正文页里条件性的 location 赋值。
function extractRedirectTarget(html, baseUrl) {
  if (!html || html.length > 4000) return null;
  const patterns = [
    /window\s*\.\s*location\s*\.\s*href\s*=\s*['"]([^'"]+)['"]/i,
    /\blocation\s*\.\s*href\s*=\s*['"]([^'"]+)['"]/i,
    /\blocation\s*\.\s*replace\s*\(\s*['"]([^'"]+)['"]/i,
    /window\s*\.\s*location\s*=\s*['"]([^'"]+)['"]/i,
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*?\burl\s*=\s*([^;"'\s>]+)/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m || !m[1]) continue;
    try {
      const target = new URL(m[1], baseUrl).href;
      return target === baseUrl ? null : target;
    } catch (e) { return null; }
  }
  return null;
}

// 抓取 HTML 页面并跟随 JS / meta-refresh 跳转，返回最终页面与跳转链。
async function httpGetPage(url, { timeout = 15000, ttl = 0, maxRedirects = 5 } = {}) {
  let current = url;
  const redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const html = await httpGet(current, { timeout, ttl });
    const target = extractRedirectTarget(html, current);
    if (!target) return { html, finalUrl: current, redirects };
    redirects.push({ from: current, to: target });
    logger.info('REDIRECT', `← 页面 JS 跳转 ${redirects.length}/${maxRedirects}: ${current} → ${target}`, {
      from: current, to: target, hop: redirects.length, upstreamUrl: current
    });
    current = target;
  }
  throw new Error(`页面 JS 跳转超过 ${maxRedirects} 次: ${url}`);
}

// 简易并发池：按并发上限执行任务，返回与输入顺序一致的结果
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try {
        results[i] = await mapper(items[i], i);
      } catch (e) {
        results[i] = { __error: true, message: e.message };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { httpGet, httpGetJson, httpGetPage, extractRedirectTarget, cacheGet, cacheSet, mapLimit, UA };
