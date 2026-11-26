// 上游出站 HTTP 统一日志：完整 URL（脱敏）/ 方法 / 状态 / 响应类型 / 字节 / 耗时
// 目标：debug 分区里能看到「底层接口到底调了什么、回了什么、多快」，用于判断故障在插件还是上游
// 仅用 Web Standard API，Edge / Node 通用；默认不消费响应体（克隆读取，不影响调用方）
import { logger, redact } from './logger.js';

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
 * @param {{L?:object, tag?:string, label?:string, level?:'debug'|'info', measure?:boolean}} opts
 */
export async function loggedFetch(url, init = {}, opts = {}) {
  const { L, tag = 'fetch', label = '', level = 'debug', measure = true } = opts;
  const emit = L || logger;
  const method = String(init?.method || 'GET').toUpperCase();
  const shown = displayUrl(url);
  const started = Date.now();
  try {
    const r = await fetch(url, init);
    const elapsed = Date.now() - started;
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    let bytes = Number(r.headers.get('content-length')) || 0;
    // 很多上游走 chunked 不带 content-length：debug 模式下克隆一份量一下真实大小
    const isMedia = /^(video|audio|image)\//i.test(ct);
    if (!bytes && measure && !isMedia && r.body) {
      try {
        bytes = (await r.clone().arrayBuffer()).byteLength;
      } catch {
        bytes = 0;
      }
    }
    const detail = [
      `${method} ${shown}`,
      `→ ${r.status}${r.status >= 400 ? ' 失败' : ''}`,
      ct ? `type=${ct}` : '',
      humanBytes(bytes) ? `resp=${humanBytes(bytes)}` : '',
      `${elapsed}ms`,
      label ? `[${label}]` : '',
    ]
      .filter(Boolean)
      .join(' ');
    (emit[level] || emit.debug)(tag, detail, {
      upstream: shown,
      method,
      status: r.status,
      contentType: ct,
      bytes: bytes || null,
      elapsed,
    });
    return r;
  } catch (e) {
    emit.warn(tag, `${method} ${shown} → EXCEPTION ${e.message} ${Date.now() - started}ms`, {
      upstream: shown,
      method,
      error: e.message,
      elapsed: Date.now() - started,
    });
    throw e;
  }
}
