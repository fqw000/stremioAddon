/**
 * Vercel Edge Function 入口
 *
 * 职责：
 *   1. 解析请求
 *   2. 调用 src/handler.js 的分发逻辑
 *   3. 统一错误处理和日志
 *
 * 注意：本文件仅做入口转发，业务逻辑在 src/handler.js
 */

import { handleRequest } from '../src/handler.js';
import { createLogger, setLogLevel } from '../src/logger.js';

export const config = { runtime: 'edge' };

const log = createLogger('Edge');

export default async function (request, context) {
  const t0 = Date.now();
  const url = new URL(request.url);

  setLogLevel(process.env.LOG_LEVEL || 'info');
  log.info(`${request.method} ${url.pathname}${url.search.slice(0, 120)}`);

  // 根路径：浏览器访问 → 302 跳转到 /configure
  if (url.pathname === '/') {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/html')) {
      log.info('浏览器访问根路径，跳转到 /configure');
      return Response.redirect(new URL('/configure', request.url).toString(), 302);
    }
    // 非浏览器（Stremio / API）→ 继续走 handleRequest，返回 manifest
  }

  try {
    const response = await handleRequest(request, process.env);
    const elapsed = Date.now() - t0;
    log.info(`${url.pathname} → ${response.status} (${elapsed}ms)`);
    return response;
  } catch (err) {
    log.error(`${url.pathname} 未捕获异常:`, err.message);
    log.error(err.stack?.slice(0, 500));
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}