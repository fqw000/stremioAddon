/**
 * 缓存分层
 *
 * L1：内存（isolate 生命周期内）
 * L2：Upstash Redis（跨 isolate 持久化，用 Pipeline API）
 *
 * 特性：
 *   - Redis 失败 3 次进入 60s 冷却，期间只用 L1
 *   - 所有 key 经 prefixKey() 统一加前缀
 *   - 支持 negative cache
 */

import { createLogger } from './logger.js';

const log = createLogger('Cache');

// ────────────────────────────────────────────────────────────
// L1 内存缓存
// ────────────────────────────────────────────────────────────
const l1 = new Map();

// single-flight：在途回源任务表（key 为完整缓存 key）
const inflight = new Map();

function l1Get(key) {
  const item = l1.get(key);
  if (!item) return null;
  if (item.expire < Date.now()) {
    l1.delete(key);
    return null;
  }
  return item.value;
}

function l1Set(key, value, ttlSeconds) {
  l1.set(key, { value, expire: Date.now() + ttlSeconds * 1000 });
  if (l1.size > 500) {
    const now = Date.now();
    for (const [k, v] of l1) {
      if (v.expire < now) l1.delete(k);
    }
  }
}

// ────────────────────────────────────────────────────────────
// Redis 冷却机制
// ────────────────────────────────────────────────────────────
let redisFailCount = 0;
let redisCooldownUntil = 0;
const REDIS_FAIL_THRESHOLD = 3;
const REDIS_COOLDOWN_MS = 60_000;

function isRedisAvailable(env) {
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) return false;
  if (Date.now() < redisCooldownUntil) return false;
  return true;
}

function recordRedisFail() {
  redisFailCount++;
  if (redisFailCount >= REDIS_FAIL_THRESHOLD) {
    redisCooldownUntil = Date.now() + REDIS_COOLDOWN_MS;
    redisFailCount = 0;
    log.warn(`Redis 进入冷却 ${REDIS_COOLDOWN_MS / 1000}s`);
  }
}

function recordRedisSuccess() {
  redisFailCount = 0;
}

// ────────────────────────────────────────────────────────────
// prefixKey
// ────────────────────────────────────────────────────────────
export function prefixKey(env, ...parts) {
  const prefix = env?.APP_PREFIX || 'unknown:unknown';
  return [prefix, ...parts].filter(Boolean).join(':');
}

// ────────────────────────────────────────────────────────────
// Redis REST（Pipeline API）
// ────────────────────────────────────────────────────────────

/**
 * 发送单个命令（内部转成 pipeline 数组）
 * @param {string[]} command - 例如 ['SET', key, value, 'EX', '1800']
 */
async function redisCommand(env, command) {
  if (!isRedisAvailable(env)) return null;
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command]),
    });
    if (!res.ok) {
      recordRedisFail();
      log.warn(`Redis pipeline HTTP ${res.status}`);
      return null;
    }
    recordRedisSuccess();
    const data = await res.json();
    // pipeline 返回 [{ result: ... }, ...]
    return data?.[0]?.result ?? null;
  } catch (e) {
    recordRedisFail();
    log.warn('Redis 命令失败:', e.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// 统一缓存接口
// ────────────────────────────────────────────────────────────
export async function getCache(env, key, { l1Ttl } = {}) {
  const fullKey = prefixKey(env, 'cache', key);

  // L1
  const hit = l1Get(fullKey);
  if (hit !== null) {
    log.debug(`[L1 HIT] ${key}`);
    return hit;
  }

  // L2
  const raw = await redisCommand(env, ['GET', fullKey]);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (l1Ttl) l1Set(fullKey, parsed, l1Ttl);
    log.debug(`[L2 HIT] ${key}`);
    return parsed;
  } catch {
    return null;
  }
}

export async function setCache(env, key, value, { l1Ttl, redisTtl } = {}) {
  const fullKey = prefixKey(env, 'cache', key);

  // L1
  if (l1Ttl) {
    l1Set(fullKey, value, l1Ttl);
    log.debug(`[L1 SET] ${key} ttl=${l1Ttl}s`);
  }

  // L2
  if (redisTtl) {
    const serialized = JSON.stringify(value);
    const result = await redisCommand(env, ['SET', fullKey, serialized, 'EX', String(redisTtl)]);
    if (result === 'OK') {
      log.debug(`[L2 SET] ${key} ttl=${redisTtl}s`);
    } else {
      log.warn(`[L2 SET] ${key} 失败，返回: ${JSON.stringify(result)}`);
    }
  }
}

export async function delCache(env, key) {
  const fullKey = prefixKey(env, 'cache', key);
  l1.delete(fullKey);
  await redisCommand(env, ['DEL', fullKey]);
}

// ────────────────────────────────────────────────────────────
// withCache
// ────────────────────────────────────────────────────────────
export async function withCache({ env, key, l1Ttl, redisTtl, fetcher, shouldCache }) {
  const cached = await getCache(env, key, { l1Ttl });
  if (cached !== null) {
    log.debug(`[CACHE HIT] ${key}`);
    return { value: cached, fromCache: true };
  }

  // single-flight：同一 key 的并发回源合并成一个在途 Promise
  const fullKey = prefixKey(env, 'cache', key);
  const pending = inflight.get(fullKey);
  if (pending) {
    log.debug(`[INFLIGHT HIT] ${key}`);
    return pending;
  }

  log.debug(`[CACHE MISS] ${key}`);
  const task = (async () => {
    try {
      const value = await fetcher();
      const allow = shouldCache ? shouldCache(value) : true;
      if (allow) {
        await setCache(env, key, value, { l1Ttl, redisTtl });
      }
      return { value, fromCache: false };
    } finally {
      inflight.delete(fullKey);
    }
  })();
  inflight.set(fullKey, task);
  return task;
}

// ────────────────────────────────────────────────────────────
// 调试
// ────────────────────────────────────────────────────────────
export function getCacheStatus(env) {
  const now = Date.now();
  return {
    l1Size: l1.size,
    redisConfigured: !!(env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN),
    redisInCooldown: now < redisCooldownUntil,
    redisCooldownRemain: Math.max(0, Math.ceil((redisCooldownUntil - now) / 1000)),
  };
}

export function clearL1() {
  l1.clear();
}
