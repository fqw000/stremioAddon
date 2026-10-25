// src/cache.js
// L1 内存 + L2 Upstash Redis (REST fetch) 缓存体系
// 红线：所有 Redis 读写必经 prefixKey；禁止 TCP 客户端；负缓存短效；
//       连续 3 次 >500ms 超时 → 60s 冷却降级；inflight 去重；分布式锁指数退避。
// 约定：本模块所有导出函数的 key 参数必须是已由 prefixKey(...) 生成的全 key。

const APP_PREFIX = 'loommio:dev';

const REDIS_TIMEOUT_MS = 800;
const REDIS_COOLDOWN_MS = 60_000;
const REDIS_TIMEOUT_THRESHOLD = 3;

const LOCK_TTL_SECONDS = 60;
const LOCK_POLL_TIMEOUT_MS = 2500;
const LOCK_POLL_INITIAL_MS = 100;
const LOCK_POLL_MAX_MS = 800;

const L1_MAX_ENTRIES = 500;

// 模块级状态（同实例内保持，冷启动重置；L1 本身也随冷启动清空）
const l1 = new Map();          // key -> { value, expiresAt }
const inflight = new Map();    // key -> Promise
let redisTimeoutStreak = 0;
let redisCooldownUntil = 0;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 统一 key 前缀。part 内的 ":" 替换为 "_"，防止污染分层。
 * 示例：prefixKey('meta', plID) -> "loommio:dev:meta:pl_xxx"
 */
export function prefixKey(...parts) {
  const clean = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p) => String(p).replace(/:/g, '_'));
  return [APP_PREFIX, ...clean].join(':');
}

// ---------- L1 ----------

function l1Get(key) {
  const entry = l1.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    l1.delete(key);
    return undefined;
  }
  return entry.value;
}

function l1Set(key, value, ttlMs) {
  if (l1.size >= L1_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of l1) {
      if (v.expiresAt <= now) l1.delete(k);
    }
    while (l1.size >= L1_MAX_ENTRIES) {
      const first = l1.keys().next().value;
      l1.delete(first);
    }
  }
  l1.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ---------- L2 (Upstash REST) ----------

function redisConfigured() {
  return !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
}

function redisCooling() {
  return Date.now() < redisCooldownUntil;
}

async function redisCommand(command) {
  if (!redisConfigured() || redisCooling()) {
    return { skipped: true };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REDIS_TIMEOUT_MS);
  try {
    const redisUrl = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
    const res = await fetch(redisUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: ac.signal,
    });
    redisTimeoutStreak = 0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`redis http ${res.status} ${text.slice(0, 100)}`);
    }
    const data = await res.json();
    if (data && data.error) {
      throw new Error(`redis err ${String(data.error).slice(0, 100)}`);
    }
    return { result: data ? data.result : undefined };
  } catch (e) {
    redisTimeoutStreak += 1;
    const isAbort = e.name === 'AbortError';
    console.log(
      `[cache] ${ts()} redis ${isAbort ? 'TIMEOUT' : 'ERROR'} url=${process.env.UPSTASH_REDIS_REST_URL || '(unset)'} streak=${redisTimeoutStreak} reason=${e.message}`
    );
    if (redisTimeoutStreak >= REDIS_TIMEOUT_THRESHOLD) {
      redisCooldownUntil = Date.now() + REDIS_COOLDOWN_MS;
      console.log(
        `[cache] ${ts()} redis cooldown ${REDIS_COOLDOWN_MS}ms streak=${redisTimeoutStreak}`
      );
    }
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function redisGet(key) {
  const r = await redisCommand(['GET', key]);
  if (r.skipped || r.error) return undefined;
  return r.result === null ? undefined : r.result;
}

async function redisSet(key, value, ttlSeconds) {
  const args = ttlSeconds
    ? ['SET', key, value, 'EX', String(ttlSeconds)]
    : ['SET', key, value];
  const r = await redisCommand(args);
  return !r.skipped && !r.error && r.result === 'OK';
}

async function redisSetNX(key, value, ttlSeconds) {
  const r = await redisCommand(['SET', key, value, 'NX', 'EX', String(ttlSeconds)]);
  if (r.skipped || r.error) return false;
  return r.result === 'OK';
}

// ---------- 对外：读写 ----------

/**
 * 读缓存：L1 → L2，L2 命中回填 L1。
 * 返回 undefined 表示未命中；null 是合法缓存值（负缓存）。
 */
export async function getCached(key, { l1TtlMs } = {}) {
  const hit = l1Get(key);
  if (hit !== undefined) return hit;

  const raw = await redisGet(key);
  if (raw === undefined) return undefined;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (l1TtlMs && l1TtlMs > 0) l1Set(key, parsed, l1TtlMs);
  return parsed;
}

/**
 * 写缓存：L1 + L2。L2 失败不抛错，降级为 L1。
 */
export async function setCached(key, value, { l1TtlMs, l2TtlSeconds } = {}) {
  if (l1TtlMs && l1TtlMs > 0) l1Set(key, value, l1TtlMs);
  if (l2TtlSeconds && l2TtlSeconds > 0) {
    try {
      await redisSet(key, JSON.stringify(value), l2TtlSeconds);
    } catch {
      // 降级为 L1
    }
  }
}

// ---------- inflight 去重 ----------

export function withInflight(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------- 分布式锁 ----------

/**
 * 分布式锁：SET NX EX 60；未拿到锁时指数退避轮询（100→200→400→800ms），
 * 总超时 2.5s；超时降级为直接放行一次 fn。返回 fn() 的结果。
 */
export async function withLock(lockKey, fn) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const acquired = await redisSetNX(lockKey, token, LOCK_TTL_SECONDS);
  if (acquired) {
    try {
      return await fn();
    } finally {
      await redisCommand(['DEL', lockKey]);
    }
  }

  const started = Date.now();
  let delay = LOCK_POLL_INITIAL_MS;
  while (Date.now() - started < LOCK_POLL_TIMEOUT_MS) {
    await sleep(delay);
    delay = Math.min(delay * 2, LOCK_POLL_MAX_MS);
    const held = await redisGet(lockKey);
    if (held === undefined) {
      // 锁已释放，直接执行一次，不重新抢锁（避免惊群）
      return await fn();
    }
  }
  console.log(`[cache] ${ts()} lock timeout ${lockKey}, degraded to run once`);
  return await fn();
}

// ---------- 高层：get-or-fetch ----------

/**
 * L1 → L2 → inflight → fetcher → 写回。
 * @param {string} key 已由 prefixKey(...) 生成
 * @param {Function} fetcher 返回数据的异步函数
 * @param {object} opts
 *   l1TtlMs          L1 TTL（毫秒）
 *   l2TtlSeconds     L2 TTL（秒）
 *   negativeTtlSeconds 当结果为空（null/undefined/空数组）时的短效 TTL（秒），优先于 l2TtlSeconds
 */
export async function getOrFetch(key, fetcher, opts = {}) {
  const { l1TtlMs, l2TtlSeconds, negativeTtlSeconds } = opts;

  const cached = await getCached(key, { l1TtlMs });
  if (cached !== undefined) return cached;

  return withInflight(key, async () => {
    const again = await getCached(key, { l1TtlMs });
    if (again !== undefined) return again;

    const value = await fetcher();
    const isEmpty =
      value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0);

    let l1Ttl = l1TtlMs;
    let l2Ttl = l2TtlSeconds;
    if (isEmpty && negativeTtlSeconds) {
      l2Ttl = negativeTtlSeconds;
      l1Ttl = negativeTtlSeconds * 1000;
    }

    if (l1Ttl || l2Ttl) {
      await setCached(key, value, { l1TtlMs: l1Ttl, l2TtlSeconds: l2Ttl });
    }
    return value;
  });
}

// 仅供测试/健康检查读取状态，不对外暴露内部 Map
export function getCacheState() {
  return {
    l1Size: l1.size,
    inflightSize: inflight.size,
    redisTimeoutStreak,
    redisCooling: redisCooling(),
    cooldownRemainMs: Math.max(0, redisCooldownUntil - Date.now()),
  };
}