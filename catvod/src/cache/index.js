// L1（内存 Map，进程内，零延迟）+ L2（Redis，跨实例，共享）
// 降级：L2 连续 3 次超时 > 500ms → 60 秒冷却，期间只走 L1
// 负缓存：value 含 __negative 标记，不被「空数组不写」过滤
import * as upstash from "./upstash.js";
import { log } from "../logger.js";

const APP_PREFIX = (process.env.APP_PREFIX || "").trim();
const L1_TTL_MULTIPLIER = 0.1;
const REDIS_TIMEOUT_MS = 1500;
const REDIS_COOLDOWN_MS = 60000;
const REDIS_FAIL_THRESHOLD = 5;

// ---------- L1 ----------
const l1 = new Map();
function l1Get(key) {
  const e = l1.get(key);
  if (!e) return null;
  if (e.expireAt < Date.now()) { l1.delete(key); return null; }
  return e.value;
}
function l1Set(key, value, ttlSeconds) {
  if (l1.size > 5000) {
    const first = l1.keys().next().value;
    if (first !== undefined) l1.delete(first);
  }
  l1.set(key, { value, expireAt: Date.now() + ttlSeconds * 1000 });
}

// ---------- Redis 冷却 ----------
let redisFailCount = 0;
let redisCooldownUntil = 0;
function redisAvailable() {
  if (!upstash.isEnabled()) return false;
  if (Date.now() < redisCooldownUntil) return false;
  return true;
}
function recordRedisFail() {
  redisFailCount++;
  if (redisFailCount >= REDIS_FAIL_THRESHOLD) {
    redisCooldownUntil = Date.now() + REDIS_COOLDOWN_MS;
    log.warn(`[cache] redis cooldown ${REDIS_COOLDOWN_MS}ms (fail=${redisFailCount})`);
    redisFailCount = 0;
  }
}
function recordRedisOk() { redisFailCount = 0; }

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("redis-timeout")), ms)),
  ]);
}

// ---------- Key ----------
function fullKey(key) {
  return APP_PREFIX ? `${APP_PREFIX}:${key}` : key;
}

// ---------- Inflight 去重（并发请求同一 key 只穿透一次） ----------
const inflight = new Map();
export async function withInflight(key, fn) {
  if (inflight.has(key)) {
    log.debug(`[cache] join inflight ${key}`);
    return inflight.get(key);
  }
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- 读 ----------
export async function getJSON(key) {
  const fk = fullKey(key);

  const l1Hit = l1Get(fk);
  if (l1Hit !== null) {
    log.debug(`[cache] L1 hit ${fk}`);
    return l1Hit;
  }

  if (redisAvailable()) {
    try {
      const v = await withTimeout(upstash.get(fk), REDIS_TIMEOUT_MS);
      recordRedisOk();
      if (v !== null && v !== undefined) {
        log.debug(`[cache] L2 hit ${fk}`);
        l1Set(fk, v, 60);
        return v;
      }
    } catch (e) {
      recordRedisFail();
      log.warn(`[cache] L2 get ${fk} failed: ${e.message}`);
    }
  }
  return null;
}

// ---------- 写 ----------
export async function setJSON(key, value, ttlSeconds) {
  if (value == null) return;
  if (Array.isArray(value) && value.length === 0) return;

  const fk = fullKey(key);
  l1Set(fk, value, Math.max(5, Math.floor(ttlSeconds * L1_TTL_MULTIPLIER)));

  if (redisAvailable()) {
    try {
      await withTimeout(upstash.set(fk, value, ttlSeconds), REDIS_TIMEOUT_MS * 2);
      recordRedisOk();
    } catch (e) {
      recordRedisFail();
      log.warn(`[cache] L2 set ${fk} failed: ${e.message}`);
    }
  }
}

// ---------- 删 ----------
export async function delJSON(key) {
  const fk = fullKey(key);
  l1.delete(fk);
  if (redisAvailable()) {
    try {
      await withTimeout(upstash.del(fk), REDIS_TIMEOUT_MS);
      recordRedisOk();
    } catch {
      recordRedisFail();
    }
  }
}

// ---------- 状态 ----------
export async function pingCache() {
  if (!upstash.isEnabled()) return { ok: true, backend: "memory" };
  try {
    const r = await withTimeout(upstash.ping(), REDIS_TIMEOUT_MS);
    return { ok: r.ok, backend: "upstash", l1Size: l1.size };
  } catch {
    return { ok: false, backend: "upstash-degraded", l1Size: l1.size };
  }
}

export function backendName() { return upstash.isEnabled() ? "upstash" : "memory"; }
export function currentPrefix() { return APP_PREFIX || "(none)"; }
export function exampleKey(key = "tmdb:tt0096697:series:1") { return fullKey(key); }
