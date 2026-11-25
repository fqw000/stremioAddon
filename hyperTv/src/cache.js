// L1 内存缓存 + 可选 L2 Upstash Redis REST（有环境变量才启用）
// 所有键统一经 prefixKey；空结果与失败结果短效缓存，避免负优化
import { APP_PREFIX, hashId, log } from './helper.js';

const mem = new Map();
const inflight = new Map();
let redisConfig = null;
let redisFailures = 0;
let cooldownUntil = 0;

function getRedis() {
  const env = globalThis.process?.env;
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!redisConfig) {
    redisConfig = {
      url: String(env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, ''),
      token: String(env.UPSTASH_REDIS_REST_TOKEN),
    };
  }
  return redisConfig;
}

export function prefixKey(...parts) {
  return `${APP_PREFIX}:${parts.map((p) => String(p)).join(':')}`;
}

async function redisCall(path, timeoutMs = 500) {
  const conf = getRedis();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${conf.url}/${path}`, {
      headers: { authorization: `Bearer ${conf.token}` },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`redis HTTP ${r.status}`);
    const data = await r.json();
    return data?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function redisGet(key) {
  const raw = await redisCall(`get/${encodeURIComponent(key)}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function redisSet(key, value, ttlSeconds) {
  const raw = JSON.stringify(value);
  // Upstash 单值上限保护：大目录不进 L2，只留 L1
  if (raw.length > 120000) return;
  await redisCall(
    `set/${encodeURIComponent(key)}/${encodeURIComponent(raw)}/EX/${Math.max(1, Math.ceil(ttlSeconds))}`,
  );
}

export async function cached(key, ttlMs, producer, options = {}) {
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && hit.exp > now) return hit.value;
  if (hit) mem.delete(key);

  const redisReady = options.l2 && getRedis() && Date.now() > cooldownUntil;
  if (redisReady) {
    try {
      const v = await redisGet(key);
      if (v !== null) {
        mem.set(key, { value: v, exp: Date.now() + ttlMs });
        return v;
      }
    } catch (e) {
      redisFailures += 1;
      log('cache', `L2 read failed: ${e.message}`);
    }
  }

  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    let value;
    try {
      value = await producer();
    } catch (e) {
      log('cache', `producer failed for ${key}: ${e.message}`);
      value = null;
    }
    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    const ttl = empty ? Math.min(ttlMs, options.negativeTtlMs ?? 60000) : ttlMs;
    mem.set(key, { value, exp: Date.now() + ttl });

    if (redisReady && !empty && Date.now() > cooldownUntil) {
      try {
        await redisSet(key, value, ttl / 1000);
        redisFailures = 0;
      } catch (e) {
        redisFailures += 1;
        log('cache', `L2 write failed: ${e.message}`);
      }
    }
    if (redisFailures >= 3) {
      cooldownUntil = Date.now() + 60000; // 连续失败 60 秒冷却降级
      redisFailures = 0;
    }
    return value;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

export function clearCache() {
  mem.clear();
}

export const cacheKey = hashId;
