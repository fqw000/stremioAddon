/**
 * 网络层：多域名容灾 + CDN 可达性探测
 */

// ============================================================
// 常量
// ============================================================
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const HOSTS = [
    'https://mtyy5.com',
    'https://mtyy2.cc',
    'https://mtyy4.cc',
    'https://mtyy8.cc',
    'https://mtyy3.com',
];

// ============================================================
// 主域名缓存（isolate 内有效，5 分钟）
// ============================================================
let cachedHost = null;
let cachedAt = 0;
const HOST_TTL = 5 * 60 * 1000;

/**
 * 获取当前可达的主域名（自动轮询 + 5 分钟缓存）
 */
export async function getActiveHost() {
    if (cachedHost && Date.now() - cachedAt < HOST_TTL) {
        return cachedHost;
    }
    for (const host of HOSTS) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch(host, {
                headers: { 'User-Agent': USER_AGENT },
                signal: ctrl.signal,
            });
            clearTimeout(t);
            if (res.ok) {
                cachedHost = host;
                cachedAt = Date.now();
                return host;
            }
        } catch {
            // 继续尝试下一个
        }
    }
    throw new Error('所有麦田域名均不可用');
}

// ============================================================
// HTML 抓取
// ============================================================
/**
 * 抓取 HTML，10s 超时，自动带 Referer/UA
 */
export async function fetchHtml(url, timeout = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const origin = new URL(url).origin;
        const res = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': origin + '/',
            },
            signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) return '';
        return await res.text();
    } catch {
        return '';
    } finally {
        clearTimeout(t);
    }
}

// ============================================================
// CDN 可达性探测（含 5 分钟内存缓存）
// ============================================================
const cdnHealthCache = new Map();  // hostname -> { ok, ts }
const CDN_HEALTH_TTL = 5 * 60 * 1000;
const CDN_PROBE_TIMEOUT = 800;     // 800ms 超时，足够探测也不拖慢响应

/**
 * 快速探测 CDN 是否可达（HEAD 请求）
 * 失败结果缓存 5 分钟，避免同一 CDN 反复探测
 */
export async function isCdnReachable(m3u8Url) {
    let hostname;
    try {
        hostname = new URL(m3u8Url).hostname;
    } catch {
        return false;
    }

    const cached = cdnHealthCache.get(hostname);
    if (cached && Date.now() - cached.ts < CDN_HEALTH_TTL) {
        return cached.ok;
    }

    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), CDN_PROBE_TIMEOUT);
        const res = await fetch(m3u8Url, {
            method: 'HEAD',
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://mtyy5.com/',
            },
            signal: ctrl.signal,
        });
        clearTimeout(t);
        const ok = res.ok || res.status === 206;
        cdnHealthCache.set(hostname, { ok, ts: Date.now() });
        return ok;
    } catch {
        cdnHealthCache.set(hostname, { ok: false, ts: Date.now() });
        return false;
    }
}