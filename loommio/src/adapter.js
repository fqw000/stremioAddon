// src/adapter.js
// Loommio 底层 API 网络封装（Vercel Edge Runtime）
// 只负责：fetch + AbortController 超时、状态/Content-Type/大小日志、错误分类、基础结构校验
// 不负责：Stremio 字段映射、缓存、ID 编码、负缓存

const BASE_URL = 'https://loommio.com';
const DEFAULT_TIMEOUT_MS = 8000;

export class AdapterError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.meta = meta;
  }
}

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

async function requestJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS, referer } = {}) {
  const url = `${BASE_URL}${path}`;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const headers = {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  };
  if (referer) headers['referer'] = referer;

  try {
    const res = await fetch(url, { signal: ac.signal, headers });
    const elapsed = Date.now() - started;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    const bytes = text.length; // 近似字节数，ASCII 足够；含中文时略低估

    console.log(`[adapter] ${ts()} ${res.status} ${path} ${elapsed}ms ct=${ct} bytes=${bytes}`);

    if (!res.ok) {
      throw new AdapterError('HTTP_ERROR', `HTTP ${res.status}`, {
        path,
        status: res.status,
        elapsed,
      });
    }
    if (!ct.includes('application/json')) {
      throw new AdapterError('BAD_CONTENT_TYPE', `content-type=${ct}`, {
        path,
        status: res.status,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new AdapterError('BAD_JSON', e.message, { path, status: res.status });
    }

    if (data && data.ok === false) {
      throw new AdapterError('API_NOT_OK', 'ok=false', { path, status: res.status });
    }

    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new AdapterError('TIMEOUT', `timeout ${timeoutMs}ms`, { path });
    }
    if (e instanceof AdapterError) throw e;
    throw new AdapterError('NETWORK', e.message, { path });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取全量 cartoon 列表。
 * 返回底层原始数组，不做任何 Stremio 映射。
 */
export async function fetchCartoons() {
  const data = await requestJson('/api/cartoons');
  if (!data || !Array.isArray(data.cartoons)) {
    throw new AdapterError('BAD_SHAPE', 'cartoons is not an array', {
      path: '/api/cartoons',
    });
  }
  return data.cartoons;
}

/**
 * 拉取单个 cartoon 详情（含 videos）。
 * 返回 { cartoon, videos } 原始结构，不做任何 Stremio 映射。
 * referer 与浏览器探针保持一致；若后续确认服务端不校验，可移除。
 */
export async function fetchCartoonDetail(plID) {
  if (!plID || typeof plID !== 'string') {
    throw new AdapterError('BAD_INPUT', 'plID required', {});
  }
  const path = `/api/cartoons/${encodeURIComponent(plID)}`;
  const referer = `https://loommio.com/cartoons/cartoon.html?plID=${encodeURIComponent(plID)}`;
  const data = await requestJson(path, { referer });
  if (!data || !data.cartoon || !Array.isArray(data.videos)) {
    throw new AdapterError('BAD_SHAPE', 'cartoon or videos missing', { path });
  }
  return { cartoon: data.cartoon, videos: data.videos };
}