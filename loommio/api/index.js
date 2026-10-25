// api/index.js
// Vercel Edge Function 唯一入口
// 职责：/ 与 /manifest.json 返回 MANIFEST；其余路径交给 src/handler/index.js
// 不涉及 Redis、不涉及业务 handler、不在顶层 await 重型依赖

import { MANIFEST } from '../src/manifest.js';
import { routeRequest } from '../src/handler/index.js';

// Vercel Edge Runtime 声明，必须在导出层
export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function applyCors(headers) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
}

function manifestResponse() {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  applyCors(headers);
  // manifest 是静态常量，1 小时缓存足够
  headers.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  return new Response(JSON.stringify(MANIFEST), { status: 200, headers });
}

function optionsResponse() {
  const headers = new Headers();
  applyCors(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function errorResponse(status, message) {
  const headers = new Headers();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  applyCors(headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(message, { status, headers });
}

function getRawPath(requestUrl) {
  const urlObj = new URL(requestUrl);
  const afterOrigin = urlObj.href.slice(urlObj.origin.length);
  return afterOrigin.split('?')[0].split('#')[0];
}

export default async function handler(request) {
  try {
    // OPTIONS 统一在入口处理，manifest 和业务路由都覆盖
    if (request.method === 'OPTIONS') {
      return optionsResponse();
    }

    if (request.method !== 'GET') {
      return errorResponse(405, 'Method Not Allowed');
    }

    const rawPath = getRawPath(request.url);
    const normalized = rawPath.replace(/\/+$/, '') || '/';

    if (normalized === '/' || normalized === '/manifest.json') {
      console.log(`[entry] ${ts()} manifest path=${normalized}`);
      return manifestResponse();
    }

    // 其余请求交给 handler 路由
    return await routeRequest(request);
  } catch (e) {
    // 兜底错误必须带 CORS，否则 Stremio 端只会看到 CORS 错误，看不到 500
    console.log(`[entry] ${ts()} unhandled error msg=${e.message}`);
    return errorResponse(500, 'Internal Server Error');
  }
}