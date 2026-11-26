// 通用工具：Edge Runtime 兼容，仅使用 Web Standard API
export const HYPETV_BASE = 'https://hypetvbr.com';
// 新版内置列表需在路径中带开发者 key（POST /api/dev {"code":"123"} 换得）
export const HYPETV_KEY = String(
  globalThis.process?.env?.HYPETV_KEY ||
    globalThis.process?.env?.HYPETV_DEV_KEY ||
    'cfc467d74225f369b541d032',
);
export const APP_PREFIX = 'hypetv-addon:v1';

// 日志实现统一收敛到 logger.js（保留从 helper 导入的旧用法）
export { log, logger, createLogger, logThrottled, redact } from './logger.js';

// NFD 去音标 + 小写，用于搜索与片名匹配
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// FNV-1a：生成稳定短 ID / 缓存键片段
export function hashId(input) {
  let h = 0x811c9dc5;
  const s = String(input ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function encodeConfig(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConfig(text) {
  try {
    let s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    const binary = atob(s);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// 诊断信息编码到 URL：用户可直接复制 /api/diagnose?d=... 链接排查
export function encodeDebugData(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeDebugData(text) {
  try {
    let s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    const binary = atob(s);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// SOP：剥离 #expires=xxx 等 Hash
export function cleanUrl(url) {
  return String(url ?? '').split('#')[0].trim();
}

export function safeExtension(ext) {
  const e = String(ext ?? '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(e) ? e : '';
}

export function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, OPTIONS',
    ...extra,
  };
}

export function jsonResponse(data, options = {}) {
  const { status = 200, cacheMaxAge = 0, staleRevalidate = 0, staleError = 0, noCache = false } = options;
  const headers = corsHeaders({ 'content-type': 'application/json; charset=utf-8' });
  if (noCache) {
    // manifest 等声明类响应：强制客户端每次重新校验，避免旧版资源声明被长期缓存
    headers['cache-control'] = 'public, no-cache, max-age=60';
  } else if (cacheMaxAge > 0) {
    let cc = `public, max-age=${cacheMaxAge}`;
    if (staleRevalidate) cc += `, stale-while-revalidate=${staleRevalidate}`;
    if (staleError) cc += `, stale-if-error=${staleError}`;
    headers['cache-control'] = cc;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: corsHeaders({ 'content-type': 'text/html; charset=utf-8' }),
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, { status });
}

export function yearFromName(name) {
  const m = String(name ?? '').match(/\((19\d{2}|20\d{2})\)/);
  return m ? m[1] : null;
}

export function tmdbImage(path, size = 'w780') {
  const p = String(path ?? '');
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith('/')) return `https://image.tmdb.org/t/p/${size}${p}`;
  return '';
}
