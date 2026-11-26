// 上游出站 HTTP 统一日志：完整 URL（脱敏）/ 方法 / 状态 / 内容类型 / 字节 / 耗时
// 目标：debug 分区里能看到「底层接口到底调了什么、回了什么、多快」，用于判断故障在插件还是上游
// 设计见 ../日志系统规范.md §3.0.2 第 3 类打点；样板来自 hyperTv/src/http-log.js
// 仅用 Web Standard API，Edge / Node 通用；默认不消费响应体（克隆读取，不影响调用方）
import { createLogger, redact } from '../logger.js';

const defaultLog = createLogger('fetch');

function displayUrl(url) {
  const s = redact(String(url ?? ''));
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * @param {string|URL|Request} url
 * @param {RequestInit} init
 * @param {{tag?:string,label?:string,level?:'debug'|'info',measure?:boolean}} opts
 */
export async function loggedFetch(url, init = {}, opts = {}) {
  const { tag = 'fetch', label = '', level = 'debug', measure = true } = opts;
  const method = String(init?.method || 'GET').toUpperCase();
  const shown = displayUrl(url);
  const started = Date.now();
  try {
    const r = await fetch(url, init);
    const elapsed = Date.now() - started;
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    let bytes = Number(r.headers.get('content-length')) || 0;
    const isMedia = /^(video|audio|image)\//i.test(ct);
    if (!bytes && measure && !isMedia && r.body) {
      try { bytes = (await r.clone().arrayBuffer()).byteLength; } catch { bytes = 0; }
    }
    const detail = [
      `${method} ${shown}`,
      `→ ${r.status}${r.status >= 400 ? ' 失败' : ''}`,
      ct ? `type=${ct}` : '',
      humanBytes(bytes) ? `resp=${humanBytes(bytes)}` : '',
      `${elapsed}ms`,
      label ? `[${label}]` : '',
    ].filter(Boolean).join(' ');
    const L = createLogger(tag);
    (L[level] || L.debug)(detail);
    return r;
  } catch (e) {
    const L = createLogger(tag);
    L.warn(`${method} ${shown} → EXCEPTION ${e.message} ${Date.now() - started}ms`);
    throw e;
  }
}
