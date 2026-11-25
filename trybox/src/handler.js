/**
 * 路由分发器
 * 根据 URL pathname 分发到对应 handler
 *
 * 路由规则：
 *   /manifest.json              → manifest
 *   /catalog/{type}/{id}.json   → catalog
 *   /meta/{type}/{id}.json      → meta
 *   /subtitles/{type}/{id}.json → subtitle
 *   /stream/{type}/{id}.json    → stream
 *   /debug/health               → 健康检查
 *   /debug/cache                → 缓存状态
 *
 * CDN 缓存策略（依据规范）：
 *   Manifest  → s-maxage=60
 *   Catalog   → s-maxage=300, stale-while-revalidate=60
 *   Meta      → s-maxage=1800
 *   Subtitle  → s-maxage=300
 *   Stream    → s-maxage=60, stale-while-revalidate=30
 */

import { createLogger } from './logger.js';
import { getConfigFromRequest } from './config.js';
import { getManifest } from './manifest.js';
import { catalogHandler } from './handler/catalog.js';
import { metaHandler } from './handler/meta.js';
import { subtitleHandler } from './handler/subtitle.js';
import { streamHandler } from './handler/stream.js';
import { getCacheStatus } from './cache.js';

const log = createLogger('Router');

//  * 解析 Stremio 路由：/{resource}/{type}/{id}/{extra1}/{extra2}.json
//  * - id 内不允许含 '/'，只取第一段
//  * - 其余段按 key=value 解析成 extra 对象
//  * - 每段独立 decodeURIComponent（id 里的 %3A 要还原成 :）
 
function parseResourcePath(path, resource) {
  const re = new RegExp(`^/${resource}/([^/]+)/(.+?)\\.json$`);
  const m = path.match(re);
  if (!m) return null;

  const [, type, rest] = m;
  const segments = rest.split('/');

  let id = segments[0];
  try { id = decodeURIComponent(id); } catch { /* 保留原值 */ }

  const extra = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    let value = seg.slice(eq + 1);
    try { value = decodeURIComponent(value); } catch { /* 保留原值 */ }
    extra[seg.slice(0, eq)] = value;
  }

  return { type, id, extra };
}


function jsonResponse(data, status = 200, { cacheControl } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return new Response(JSON.stringify(data), { status, headers });
}

// export async function handleRequest(request, env) {
//   const url = new URL(request.url);
//   const path = url.pathname;

//   // CORS 预检
//   if (request.method === 'OPTIONS') {
//     return new Response(null, {
//       status: 204,
//       headers: {
//         'Access-Control-Allow-Origin': '*',
//         'Access-Control-Allow-Headers': '*',
//         'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
//       },
//     });
//   }

//   const config = getConfigFromRequest(request, env);

//   // Manifest
//   if (path === '/manifest.json' || path === '/') {
//     return jsonResponse(getManifest(config), 200, {
//       cacheControl: 'public, s-maxage=60',
//     });
//   }

//   // Catalog
//   const catalogMatch = path.match(/^\/catalog\/([^/]+)\/(.+)\.json$/);
//   if (catalogMatch) {
//     const [, type, rest] = catalogMatch;
//     // Stremio 约定：/catalog/{type}/{id}/{extraKey=extraValue}/...json
//     // 第一段是 catalog id，后续每段是 extra（如 skip=60、genre=动作、search=xxx）
//     const segments = rest.split('/');
//     const id = segments[0];
//     const extra = {};
//     for (const seg of segments.slice(1)) {
//       const eq = seg.indexOf('=');
//       if (eq <= 0) continue;
//       let value = seg.slice(eq + 1);
//       try { value = decodeURIComponent(value); } catch { /* 保留原值 */ }
//       extra[seg.slice(0, eq)] = value;
//     }
//     // 兼容旧调用方式：extra 放在 query string 上
//     for (const [k, v] of url.searchParams) {
//       if (k !== 'cfg') extra[k] = v;
//     }
//     const result = await catalogHandler({ type, id, extra, config, env });
//     return jsonResponse(result, 200, {
//       cacheControl: 'public, s-maxage=300, stale-while-revalidate=60',
//     });
//   }

//   // Meta
//   const metaMatch = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
//   if (metaMatch) {
//     const [, type, id] = metaMatch;
//     const result = await metaHandler({ type, id: decodeURIComponent(id), config, env });
//     return jsonResponse(result, 200, {
//       cacheControl: 'public, s-maxage=1800',
//     });
//   }

//   // Subtitle
//   const subMatch = path.match(/^\/subtitles\/([^/]+)\/(.+)\.json$/);
//   if (subMatch) {
//     const [, type, id] = subMatch;
//     const result = await subtitleHandler({ type, id: decodeURIComponent(id), config, env });
//     return jsonResponse(result, 200, {
//       cacheControl: 'public, s-maxage=300',
//     });
//   }

//   // Stream
//   const streamMatch = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
//   if (streamMatch) {
//     const [, type, id] = streamMatch;
//     const result = await streamHandler({ type, id: decodeURIComponent(id), config, env });
//     return jsonResponse(result, 200, {
//       cacheControl: 'public, s-maxage=60, stale-while-revalidate=30',
//     });
//   }

//   // Debug
//   if (path === '/debug/health') {
//     return jsonResponse({ ok: true, ts: Date.now(), config: sanitizeConfig(config) });
//   }

//   if (path === '/debug/cache') {
//     return jsonResponse(getCacheStatus(env));
//   }

//   log.warn(`未匹配路径: ${path}`);
//   return new Response('Not Found', { status: 404 });
// }

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    });
  }

  const config = getConfigFromRequest(request, env);

  // Manifest
  if (path === '/manifest.json' || path === '/') {
    return jsonResponse(getManifest(config), 200, {
      cacheControl: 'public, s-maxage=60',
    });
  }

  // Catalog
  const catalogMatch = path.match(/^\/catalog\/([^/]+)\/(.+)\.json$/);
  if (catalogMatch) {
    const [, type, rest] = catalogMatch;
    // Stremio 约定：/catalog/{type}/{id}/{extraKey=extraValue}/...json
    // 第一段是 catalog id，后续每段是 extra（如 skip=60、genre=动作、search=xxx）
    const segments = rest.split('/');
    const id = segments[0];
    const extra = {};
    for (const seg of segments.slice(1)) {
      const eq = seg.indexOf('=');
      if (eq <= 0) continue;
      let value = seg.slice(eq + 1);
      try { value = decodeURIComponent(value); } catch { /* 保留原值 */ }
      extra[seg.slice(0, eq)] = value;
    }
    // 兼容旧调用方式：extra 放在 query string 上
    for (const [k, v] of url.searchParams) {
      if (k !== 'cfg') extra[k] = v;
    }
    const result = await catalogHandler({ type, id, extra, config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=300, stale-while-revalidate=60',
    });
  }

  // Subtitle
  const sub = parseResourcePath(path, 'subtitles');
  if (sub) {
    const result = await subtitleHandler({ ...sub, config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=300',
    });
  }

  // Stream
  const stream = parseResourcePath(path, 'stream');
  if (stream) {
    const result = await streamHandler({ ...stream, config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=60, stale-while-revalidate=30',
    });
  }

  // Meta
  const meta = parseResourcePath(path, 'meta');
  if (meta) {
    const result = await metaHandler({ ...meta, config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=1800',
    });
  }

  // Debug
  if (path === '/debug/health') {
    return jsonResponse({ ok: true, ts: Date.now(), config: sanitizeConfig(config) });
  }

  if (path === '/debug/cache') {
    return jsonResponse(getCacheStatus(env));
  }

  log.warn(`未匹配路径: ${path}`);
  return new Response('Not Found', { status: 404 });
}


function sanitizeConfig(cfg) {
  const c = { ...cfg };
  if (c.refreshToken) c.refreshToken = c.refreshToken.slice(0, 4) + '***';
  if (c.accessToken) c.accessToken = c.accessToken.slice(0, 4) + '***';
  if (c.tmdbKey) c.tmdbKey = c.tmdbKey.slice(0, 4) + '***';
  return c;
}
