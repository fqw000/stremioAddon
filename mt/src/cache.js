/**
 * 缓存模块（L1 内存 + L2 Upstash Redis）
 * 
 * 红线合规：
 *   - 所有读写经过 prefixKey()
 *   - Edge 通过 HTTP REST 访问 Redis
 *   - 负缓存独立命名空间（neg:*）
 *   - 冷却降级（连续 3 次 >500ms → 60s 冷却）
 *   - Inflight 去重
 *   - 无顶层 await
 */

// ============================================================
// 配置（Edge 下 process.env 是静态注入，非运行时读取）
// ============================================================
const PREFIX = process.env.APP_PREFIX || 'mtyy:dev';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// ============================================================
// TTL 常量（秒）
// ============================================================
export const TTL = {
    CATALOG: 300,       // 5 分钟
    SEARCH: 300,        // 5 分钟
    META: 1800,         // 30 分钟
    STREAM: 180,        // 3 分钟
    // 负缓存（短效，防止打爆源站）
    NEG_CDN: 180,       // CDN 不可达 3 分钟
    NEG_PARSE: 300,     // 解析失败 5 分钟
    NEG_META: 600,      // Meta 不存在 10 分钟
    NEG_EMPTY: 3600,    // 空结果 1 小时
};

// ============================================================
// 冷却参数
// ============================================================
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 60 * 1000;
const REQUEST_TIMEOUT = 500;   // 单次 Redis 请求超时

// ============================================================
// L1 内存缓存（isolate 生命周期内）
// ============================================================
const L1 = new Map();
const L1_MAX_SIZE = 500;
const L1_MAX_TTL_MS = 60 * 1000;   // L1 单个 key 最多存活 60s

// ============================================================
// Redis 冷却状态
// ============================================================
let failCount = 0;
let cooldownUntil = 0;

function recordFail() {
    failCount++;
    if (failCount >= FAIL_THRESHOLD) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        failCount = 0;
    }
}

// ============================================================
// Inflight 去重
// ============================================================
const inflight = new Map();

// ============================================================
// 统一前缀函数（红线 1）
// ============================================================
export function prefixKey(...parts) {
    return [PREFIX, ...parts].filter(x => x != null && x !== '').join(':');
}

// ============================================================
// Redis Pipeline 调用（统一走 /pipeline）
// 返回: [{result: ...}, {result: ...}] 或 null
// ============================================================
async function redisPipeline(commands) {
    if (!REDIS_URL || !REDIS_TOKEN) return null;
    if (Date.now() < cooldownUntil) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    try {
        const res = await fetch(REDIS_URL + '/pipeline', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${REDIS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(commands),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            recordFail();
            return null;
        }
        failCount = 0;
        return await res.json();
    } catch {
        clearTimeout(timer);
        recordFail();
        return null;
    }
}

// ============================================================
// 核心 API
// ============================================================

/**
 * 读缓存（L1 → L2）
 * @returns {any | null} 未命中返回 null
 */
export async function cacheGet(key) {
    const fullKey = prefixKey('cache', key);
    const now = Date.now();

    // 1. L1
    const l1Entry = L1.get(fullKey);
    if (l1Entry && l1Entry.expire > now) {
        return l1Entry.value;
    }
    if (l1Entry) L1.delete(fullKey);

    // 2. L2
    const results = await redisPipeline([['GET', fullKey]]);
    if (!results || results.length === 0) return null;

    const raw = results[0]?.result;
    if (raw == null) return null;

    try {
        const parsed = JSON.parse(raw);
        // 回填 L1（60s 兜底）
        setL1(fullKey, parsed, L1_MAX_TTL_MS);
        return parsed;
    } catch {
        return null;
    }
}

/**
 * 写缓存（L1 + L2）
 * @param {number} ttl 秒
 */
export async function cacheSet(key, value, ttl) {
    if (ttl <= 0) return;
    const fullKey = prefixKey('cache', key);
    const now = Date.now();

    // L1
    setL1(fullKey, value, Math.min(ttl * 1000, L1_MAX_TTL_MS));

    // L2（异步，不阻塞返回）
    redisPipeline([['SETEX', fullKey, ttl, JSON.stringify(value)]]).catch(() => {});
}

/**
 * 删除缓存
 */
export async function cacheDel(key) {
    const fullKey = prefixKey('cache', key);
    L1.delete(fullKey);
    await redisPipeline([['DEL', fullKey]]);
}

// ============================================================
// 负缓存（独立命名空间 neg:*）
// ============================================================
export async function negGet(key) {
    return cacheGet(`neg:${key}`);
}

export async function negSet(key, ttl) {
    await cacheSet(`neg:${key}`, { ts: Date.now() }, ttl);
}

// ============================================================
// Inflight 去重封装
// ============================================================

/**
 * 带缓存的 fetcher（自动 L1+L2 命中 + inflight 去重）
 * 
 * @param {string} key        缓存键
 * @param {number} ttl        TTL 秒
 * @param {Function} fetcher  回源函数，返回 Promise
 * @returns {{ value, fromCache }}
 */
export async function withCache(key, ttl, fetcher) {
    // 1. 查缓存
    const cached = await cacheGet(key);
    if (cached !== null && cached !== undefined) {
        return { value: cached, fromCache: true };
    }

    // 2. 查 inflight
    if (inflight.has(key)) {
        return inflight.get(key);
    }

    // 3. 发起回源
    const promise = (async () => {
        try {
            const value = await fetcher();
            if (value !== null && value !== undefined) {
                await cacheSet(key, value, ttl);
            }
            return { value, fromCache: false };
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, promise);
    return promise;
}

// ============================================================
// L1 管理
// ============================================================
function setL1(fullKey, value, ttlMs) {
    // 容量超限时，清理过期
    if (L1.size >= L1_MAX_SIZE) {
        const now = Date.now();
        for (const [k, v] of L1) {
            if (v.expire < now) L1.delete(k);
        }
        // 还超限，删最早的
        if (L1.size >= L1_MAX_SIZE) {
            const first = L1.keys().next().value;
            if (first) L1.delete(first);
        }
    }
    L1.set(fullKey, { value, expire: Date.now() + ttlMs });
}

// ============================================================
// 调试接口
// ============================================================
export function getCacheStatus() {
    return {
        prefix: PREFIX,
        l1Size: L1.size,
        inflightSize: inflight.size,
        redisConfigured: !!(REDIS_URL && REDIS_TOKEN),
        redisInCooldown: Date.now() < cooldownUntil,
        redisCooldownRemain: Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)),
        failCount,
    };
}