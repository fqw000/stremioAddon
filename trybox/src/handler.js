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

function jsonResponse(data, status = 200, { cacheControl } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return new Response(JSON.stringify(data), { status, headers });
}

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
    const [, type, id] = catalogMatch;
    const extra = {};
    for (const [k, v] of url.searchParams) {
      if (k !== 'cfg') extra[k] = v;
    }
    const result = await catalogHandler({ type, id, extra, config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=300, stale-while-revalidate=60',
    });
  }

  // Meta
  const metaMatch = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
  if (metaMatch) {
    const [, type, id] = metaMatch;
    const result = await metaHandler({ type, id: decodeURIComponent(id), config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=1800',
    });
  }

  // Subtitle
  const subMatch = path.match(/^\/subtitles\/([^/]+)\/(.+)\.json$/);
  if (subMatch) {
    const [, type, id] = subMatch;
    const result = await subtitleHandler({ type, id: decodeURIComponent(id), config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=300',
    });
  }

  // Stream
  const streamMatch = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
  if (streamMatch) {
    const [, type, id] = streamMatch;
    const result = await streamHandler({ type, id: decodeURIComponent(id), config, env });
    return jsonResponse(result, 200, {
      cacheControl: 'public, s-maxage=60, stale-while-revalidate=30',
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
  return c;
}
