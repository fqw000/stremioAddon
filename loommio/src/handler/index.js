// src/handler/index.js
// 路由分发：解析 Stremio 标准路径，调用对应 handler，统一加 CORS / Cache-Control
// 不处理 /manifest.json（由 api/index.js 直接返回 MANIFEST）
// 不涉及 Redis、不涉及 manifest、不涉及 ID 映射

import { catalogHandler } from './catalog.js';
import { metaHandler } from './meta.js';
import { streamHandler } from './stream.js';

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 取原始编码的 path。
 * 注意：不能用 new URL(...).pathname，pathname 已被解码一次，
 * 会导致 extra 里的 %26 变成 & 被错误拆分。
 */
function getRawPath(requestUrl) {
  const urlObj = new URL(requestUrl);
  const afterOrigin = urlObj.href.slice(urlObj.origin.length);
  return afterOrigin.split('?')[0].split('#')[0];
}

/**
 * 解析 extra 原始段，如 "search=hello%26world&skip=100"。
 * 先按 & 拆、再按第一个 = 拆、最后对 key/value 分别 decode。
 */
function parseExtra(extraRaw) {
  const result = {};
  if (!extraRaw) return result;
  for (const pair of extraRaw.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = safeDecode(pair.slice(0, idx));
    const v = safeDecode(pair.slice(idx + 1));
    if (k) result[k] = v;
  }
  return result;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function buildCacheControl({ cacheMaxAge, staleRevalidate, staleError }) {
  if (!cacheMaxAge || cacheMaxAge <= 0) return 'no-store';
  const parts = ['public', `max-age=${cacheMaxAge}`, `s-maxage=${cacheMaxAge}`];
  if (staleRevalidate && staleRevalidate > 0) {
    parts.push(`stale-while-revalidate=${staleRevalidate}`);
  }
  if (staleError && staleError > 0) {
    parts.push(`stale-if-error=${staleError}`);
  }
  return parts.join(', ');
}

function jsonResponse(body, cacheOpts) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set('Cache-Control', buildCacheControl(cacheOpts || {}));
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function textResponse(status, message) {
  const headers = new Headers();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set('Cache-Control', 'no-store');
  return new Response(message, { status, headers });
}

function optionsResponse() {
  const headers = new Headers();
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

/**
 * 主入口。返回 Web Standard Response。
 * /manifest.json 不在此处理，由 api/index.js 直接返回。
 */
export async function routeRequest(request) {
  if (request.method === 'OPTIONS') {
    return optionsResponse();
  }
  if (request.method !== 'GET') {
    return textResponse(405, 'Method Not Allowed');
  }

  let segments;
  try {
    const rawPath = getRawPath(request.url);
    segments = rawPath.split('/').filter((s) => s !== '');
  } catch (e) {
    return textResponse(400, 'Bad Request');
  }

  if (segments.length < 3) {
    return textResponse(404, 'Not Found');
  }

  const resource = safeDecode(segments[0]);
  const type = safeDecode(segments[1]);

  try {
    if (resource === 'catalog') {
      // /catalog/{type}/{id}.json
      // /catalog/{type}/{id}/{extra}.json
      if (segments.length === 3) {
        if (!segments[2].endsWith('.json')) return textResponse(404, 'Not Found');
        const id = safeDecode(segments[2].slice(0, -5));
        const result = await catalogHandler({ type, id, extra: {} });
        console.log(`[route] ${ts()} catalog type=${type} id=${id} extra=-`);
        return jsonResponse(result, result);
      }
      if (segments.length === 4) {
        const id = safeDecode(segments[2]);
        if (!segments[3].endsWith('.json')) return textResponse(404, 'Not Found');
        const extraRaw = segments[3].slice(0, -5);
        const extra = parseExtra(extraRaw);
        const result = await catalogHandler({ type, id, extra });
        console.log(
          `[route] ${ts()} catalog type=${type} id=${id} extra=${JSON.stringify(extra)}`
        );
        return jsonResponse(result, result);
      }
      return textResponse(404, 'Not Found');
    }

    if (resource === 'meta') {
      // /meta/{type}/{id}.json
      if (segments.length !== 3) return textResponse(404, 'Not Found');
      if (!segments[2].endsWith('.json')) return textResponse(404, 'Not Found');
      const id = safeDecode(segments[2].slice(0, -5));
      const result = await metaHandler({ type, id });
      console.log(`[route] ${ts()} meta type=${type} id=${id}`);
      return jsonResponse(result, result);
    }

    if (resource === 'stream') {
      // /stream/{type}/{id}.json
      if (segments.length !== 3) return textResponse(404, 'Not Found');
      if (!segments[2].endsWith('.json')) return textResponse(404, 'Not Found');
      const id = safeDecode(segments[2].slice(0, -5));
      const result = await streamHandler({ type, id });
      console.log(`[route] ${ts()} stream type=${type} id=${id}`);
      return jsonResponse(result, result);
    }

    return textResponse(404, 'Not Found');
  } catch (e) {
    console.log(`[route] ${ts()} unhandled error resource=${resource} msg=${e.message}`);
    return textResponse(500, 'Internal Server Error');
  }
}