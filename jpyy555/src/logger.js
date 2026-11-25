// 统一运行日志：分级 + 脱敏 + 限频 + reqId 上下文 + Upstash Redis 持久化
//
// 设计见 /Users/wangqifei/Documents/stremio/stremioAddon/日志系统规范.md
// - 常态写 info+；配置页 debug 打开时该请求写 debug+
// - Edge Runtime 兼容：仅用 Web Standard API（fetch / atob / TextEncoder）
// - Redis 不可用时静默降级到内存缓冲，不影响业务
//
// 用法（兼容旧签名）：
//   import { createLogger, initLogStore, getLogs } from './logger.js';
//   const log = createLogger('Stream');
//   log.info('选中 vodId=135604');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LABEL = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const RING_MAX = 300;      // 内存降级缓冲上限（Redis 上限同此值）
const RATE_TTL = 60000;    // 限频窗口

let globalLevel = 'info';      // 控制台输出级别
let storeCfg = null;           // { url, token, key }
const ring = [];               // 内存缓冲（Redis 写入失败的降级 / 本地开发）
const rateState = new Map();
const pendingWrites = [];      // 待完成的 Redis 写入 Promise，由入口用 context.waitUntil() 兜底
let seq = 0;

// 原生 console 引用：入口桥接 console 后，emit 的终端输出仍走原生方法，避免递归。
let nativeConsole = { log: console.log, warn: console.warn, error: console.error };
export function setNativeConsole(c) {
  if (c && c.log && c.warn && c.error) nativeConsole = { log: c.log, warn: c.warn, error: c.error };
}

// ── 级别 ──────────────────────────────────────────────────
export function setLogLevel(level) {
  const v = String(level || 'info').toLowerCase().trim();
  globalLevel = Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : 'info';
}
export function getLogLevel() { return globalLevel; }

// ── 脱敏（强制）────────────────────────────────────────────
export function redact(text) {
  let s = String(text ?? '');
  s = s.replace(/([?&](?:api_key|apikey|password|pass|token|auth|secret|key)=)[^&\s"']+/gi, '$1***');
  s = s.replace(/([?&]cfg=)[A-Za-z0-9_-]{8,}/g, (m, p) => `${p}<${m.length - p.length}chars>`);
  s = s.replace(/([?&]u=)[^&\s"']{40,}/g, '$1***');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1***');
  return s;
}

// ── scope 派生（第二级隔离）────────────────────────────────
// 多个用户走同一个 Vercel 部署、同一个 Redis，靠 cfg 哈希区分各自的日志。
// 同一 cfg 必得同一 scope；无 cfg 用 default。
export function scopeFromCfg(cfg) {
  if (!cfg) return 'default';
  let h = 5381; // djb2
  for (let i = 0; i < cfg.length; i++) h = ((h << 5) + h + cfg.charCodeAt(i)) | 0;
  return 'u' + (h >>> 0).toString(36).slice(0, 6);
}

// ── Redis 后端 ────────────────────────────────────────────
// key = {APP_PREFIX}:logs:{scope}，两级隔离：项目前缀 + 用户配置
export function initLogStore(env, { prefix, scope } = {}) {
  const url = env?.UPSTASH_REDIS_REST_URL || '';
  const token = env?.UPSTASH_REDIS_REST_TOKEN || '';
  const p = prefix || env?.APP_PREFIX || 'jpyy555';
  const s = scope || 'default';
  storeCfg = (url && token) ? { url, token, key: `${p}:logs:${s}`, scope: s } : null;
}

function redisAvailable() { return !!storeCfg; }

async function redisPipeline(commands) {
  if (!redisAvailable()) return null;
  try {
    const res = await fetch(`${storeCfg.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${storeCfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// 写一条：LPUSH → LTRIM 保留最新 RING_MAX → EXPIRE 7 天。
// 不阻塞业务响应；Promise 挂入 pendingWrites，由入口 context.waitUntil() 在响应后等待完成，
// 避免 Vercel Edge 在 response 返回后立即冻结实例导致日志 POST 被掐断。
function persist(level, entry) {
  if (!redisAvailable()) return;                 // 降级：只留内存
  if (LEVELS[level] < LEVELS[globalLevel]) return; // 常态只写 info+
  const payload = JSON.stringify(entry);
  const p = redisPipeline([
    ['LPUSH', storeCfg.key, payload],
    ['LTRIM', storeCfg.key, 0, RING_MAX - 1],
    ['EXPIRE', storeCfg.key, '604800'],
  ]).catch(() => {});
  pendingWrites.push(p);
}

// 入口在返回 response 前调用：context.waitUntil(flushLogWrites())
export function flushLogWrites() {
  if (pendingWrites.length === 0) return Promise.resolve();
  const all = Promise.all(pendingWrites.splice(0));
  return all.then(() => {});
}

// ── emit ──────────────────────────────────────────────────
function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(level, tag, msg, ctx = {}) {
  const n = LEVELS[level] ?? LEVELS.info;
  const safe = redact(typeof msg === 'string' ? msg : JSON.stringify(msg));
  const reqId = ctx.reqId ? ` (${ctx.reqId})` : '';
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    level,
    tag: String(tag),
    msg: safe,
    ...(ctx && typeof ctx === 'object' ? { ctx } : {}),
  };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  persist(level, entry);

  if (n >= LEVELS[globalLevel] || ctx.force) {
    const stream = n >= LEVELS.error ? nativeConsole.error : n >= LEVELS.warn ? nativeConsole.warn : nativeConsole.log;
    stream(`[${stamp()}] [${LABEL[level] || level}] [${tag}]${reqId} ${safe}`);
  }
  return entry;
}

export function createLogger(module, defaultCtx = {}) {
  const tag = String(module || 'app');
  const bind = (level) => (...args) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
    return emit(level, tag, msg, defaultCtx);
  };
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    child: (extra) => createLogger(tag, { ...defaultCtx, ...(extra || {}) }),
    // 允许单次调用附带 reqId：log.info.ctx({reqId,path}, msg, ...)
    with: (extra) => createLogger(tag, { ...defaultCtx, ...(extra || {}) }),
  };
}

// 兼容旧调用 log(tag, ...args)
export function log(tag, ...args) {
  return emit('info', tag, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
}

// ── 限频 ──────────────────────────────────────────────────
export function logThrottled(level, tag, key, msg, ttlMs = RATE_TTL, ctx = {}) {
  const now = Date.now();
  let s = rateState.get(key);
  if (!s) { s = { count: 0, last: 0 }; rateState.set(key, s); }
  s.count++;
  if (now - s.last < ttlMs) return;
  s.last = now;
  const suffix = s.count > 1 ? `（近 ${Math.round(ttlMs / 1000)}s 累计 ${s.count} 次）` : '';
  emit(level, tag, `${msg}${suffix}`, { ...ctx, throttledKey: key });
}

// ── 查询 ──────────────────────────────────────────────────
function fromRing(options) {
  const { limit = 200, level = 'debug', since = 0, q = '' } = options;
  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  return ring
    .filter((e) => e.seq > since && (LEVELS[e.level] ?? 0) >= min &&
      (!needle || `${e.tag} ${e.msg} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)))
    .slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function getLogs(options = {}) {
  const { limit = 200, level = 'debug', since = 0, q = '' } = options;
  if (!redisAvailable()) return fromRing(options);

  const data = await redisPipeline([['LRANGE', storeCfg.key, 0, RING_MAX - 1]]);
  const raw = data?.[0]?.result;
  if (!Array.isArray(raw) || raw.length === 0) return fromRing(options);

  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  const out = [];
  for (let i = raw.length - 1; i >= 0; i--) {   // LPUSH 是最新在前，反转为时间正序
    let e;
    try { e = typeof raw[i] === 'string' ? JSON.parse(raw[i]) : raw[i]; } catch (e2) { continue; }
    if (!e || (LEVELS[e.level] ?? 0) < min) continue;
    if (needle && !`${e.tag} ${e.msg} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function clearLogs() {
  ring.length = 0;
  if (redisAvailable()) await redisPipeline([['DEL', storeCfg.key]]);
}

export function logStats() {
  return {
    total: seq,
    buffered: ring.length,
    maxBuffered: RING_MAX,
    consoleLevel: globalLevel,
    store: redisAvailable() ? 'upstash' : 'memory',
    scope: storeCfg?.scope || 'default',
  };
}

export function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
export function utf8Size(s) { return new TextEncoder().encode(s).length; }
export function toKB(bytes) { return +(bytes / 1024).toFixed(2); }
