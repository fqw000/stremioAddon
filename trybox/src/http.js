/**
 * HTTP 客户端
 *
 * 规则：
 *   - 4xx：不重试
 *   - 5xx：重试 retryCount 次
 *   - 网络异常：重试
 *   - 超时：AbortError 不重试（走 pending / 负缓存兜底）
 *
 * per-call options（第 3/4 参数）：
 *   - retryCount: number  默认 RETRY_COUNT
 *   - timeoutMs:  number  默认 REQUEST_TIMEOUT
 *   - 兼容旧签名：直接传 number 视为 retryCount
 */

import { createLogger } from './logger.js';

const log = createLogger('HTTP');
const REQUEST_TIMEOUT = 15000;
const RETRY_COUNT = 2;
const RETRY_DELAY = 500;

function normalizeOptions(options) {
  if (typeof options === 'number') return { retryCount: options };
  return options || {};
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET 请求，返回 text
 */
export async function getText(url, headers = {}, options = {}) {
  log.info('==================== 底层接口请求 ==================');
  log.info('【 请求路径 】', url);
  log.info('【  请求头  】', headers);
  log.info('【 请求选项 】', options);
  log.info('==================================================');

  const { retryCount = RETRY_COUNT, timeoutMs = REQUEST_TIMEOUT } = normalizeOptions(options);
  let lastErr;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs);
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`HTTP ${res.status} 不重试`);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (/HTTP 4\d\d/.test(err.message)) throw err;
      if (attempt < retryCount) {
        log.warn(`GET 请求失败，${RETRY_DELAY}ms 后重试 (${attempt + 1}/${retryCount}):`, err.message);
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  throw lastErr;
}

/**
 * POST 请求（JSON body），返回 text
 */
export async function postText(url, body, headers = {}, options = {}) {
  log.info('==================== Stream 底层接口请求 ==================');
  log.info('【 请求路径 】', url);
  log.info('【  请求头  】', headers);
  log.info('【 请求选项 】', options);
  log.info('==================================================');
  const { retryCount = RETRY_COUNT, timeoutMs = REQUEST_TIMEOUT } = normalizeOptions(options);
  let lastErr;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }, timeoutMs);
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`HTTP ${res.status} 不重试`);
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (/HTTP 4\d\d/.test(err.message)) throw err;
      if (attempt < retryCount) {
        log.warn(`POST 请求失败，${RETRY_DELAY}ms 后重试 (${attempt + 1}/${retryCount}):`, err.message);
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  throw lastErr;
}

/**
 * POST JSON（返回 text），供 token.js 使用（简化版，不重试）
 */
export async function postJson(url, body, headers = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return text;
}