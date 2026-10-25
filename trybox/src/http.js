/**
 * HTTP 客户端
 *
 * 规则：
 *   - 4xx：不重试
 *   - 5xx：重试 RETRY_COUNT 次
 *   - 网络异常：重试
 *   - 超时：AbortError 不重试
 */

import { createLogger } from './logger.js';

const log = createLogger('HTTP');
const REQUEST_TIMEOUT = 15000;
const RETRY_COUNT = 2;
const RETRY_DELAY = 500;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET 请求，返回 text
 */
export async function getText(url, headers = {}, retryCount = RETRY_COUNT) {
  let lastErr;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers });
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
export async function postText(url, body, headers = {}, retryCount = RETRY_COUNT) {
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
      });
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
 * POST JSON（返回 text），供 token.js 使用
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
