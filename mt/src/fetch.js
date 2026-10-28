/**
 * 网络层：多域名容灾 + CDN 可达性探测
 * 接入 cache.js（L1 内存 + L2 Redis）与负缓存机制
 */

import { cacheGet, cacheSet, negGet, negSet, TTL } from './cache.js';

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
// 主域名缓存（跨实例共享，5 分钟有效）
// ============================================================
/**
 * 获取当前可达的主域名（自动轮询 + 缓存）
 * 如果所有域名都不可用，抛出异常
 */
export async function getActiveHost() {
    // 1. 查缓存
    const cached = await cacheGet('host:active');
    if (cached) {
        return cached;
    }

    // 2. 轮询
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
                await cacheSet('host:active', host, TTL.CATALOG); // 缓存 5 分钟
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
// CDN 可达性探测（带持久化负缓存）
// ============================================================
const CDN_PROBE_TIMEOUT = 800;     // 800ms 超时，足够探测也不拖慢响应

/**
 * 快速探测 CDN 是否可达
 * 
 * 策略：
 *   - 成功：写入正缓存，5 分钟有效
 *   - 失败：写入负缓存，3 分钟有效（期间不再探测，直接返回 false）
 */
export async function isCdnReachable(m3u8Url) {
    let hostname;
    try {
        hostname = new URL(m3u8Url).hostname;
    } catch {
        return false;
    }

    // 1. 查正缓存
    const okKey = `cdn:ok:${hostname}`;
    const okCached = await cacheGet(okKey);
    if (okCached) return true;

    // 2. 查负缓存
    const negKey = `cdn:${hostname}`;
    const negCached = await negGet(negKey);
    if (negCached) return false;

    // 3. 真实探测
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

        if (res.ok || res.status === 206) {
            // 成功：正缓存 5 分钟
            await cacheSet(okKey, true, TTL.CATALOG);
            return true;
        }
        
        // 失败：负缓存 3 分钟
        await negSet(negKey, TTL.NEG_CDN);
        return false;
    } catch {
        // 超时或网络错误：负缓存 3 分钟
        await negSet(negKey, TTL.NEG_CDN);
        return false;
    }
}