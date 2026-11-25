// 运行日志：分级输出 + 内存环形缓冲 + 限频汇总 + 敏感信息脱敏
// Edge Runtime 兼容，仅使用 Web Standard API；不依赖 Node 专属模块
// 用法：
//   import { log, logger, createLogger, getLogs, clearLogs } from './logger.js';
//   log('adapter', 'xxx failed');                 // 兼容旧签名
//   logger.warn('tmdb', 'HTTP 403');             // 分级
//   const L = createLogger({ reqId });           // 绑定请求上下文
//   L.debug('subtitle', '上游 98 条', { extra });

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LABEL = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const RING_MAX = 600;
const RATE_TTL = 60000;

const ring = [];
const rateState = new Map();
let seq = 0;

function envLevel() {
  const v = String(globalThis.process?.env?.LOG_LEVEL || 'info').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? LEVELS[v] : LEVELS.info;
}

let consoleLevel = envLevel();

export function setConsoleLevel(level) {
  const n = typeof level === 'number' ? level : LEVELS[String(level || '').toLowerCase()] ?? LEVELS.info;
  consoleLevel = n;
}

export function getConsoleLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === consoleLevel) || 'info';
}

// 日志文本统一脱敏：api_key / password / token / cfg / u= 等参数值
export function redact(text) {
  let s = String(text ?? '');
  s = s.replace(/([?&](?:api_key|apikey|password|pass|token|auth|secret|key)=)[^&\s"']+/gi, '$1***');
  s = s.replace(/([?&]cfg=)[A-Za-z0-9_-]{8,}/g, (m, p) => `${p}<${m.length - p.length}chars>`);
  s = s.replace(/([?&]u=)[^&\s"']{40,}/g, '$1***');
  return s;
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(level, tag, msg, ctx = {}) {
  const n = LEVELS[level] ?? LEVELS.info;
  const safe = redact(msg);
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

  // 缓冲始终记录 debug+，控制台默认遵循全局级别；debug 请求可强制输出
  if (n >= consoleLevel || ctx.force) {
    const req = ctx.reqId ? ` (${ctx.reqId})` : '';
    const stream = n >= LEVELS.error ? console.error : n >= LEVELS.warn ? console.warn : console.log;
    stream(`[${stamp()}] [${LABEL[level] || level}] [${tag}]${req} ${safe}`);
  }
  return entry;
}

// 兼容历史调用的 log(tag, ...args)
export function log(tag, ...args) {
  return emit('info', tag, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
}

function bind(defaultCtx, level) {
  return (tag, msg, extra) =>
    emit(level, tag, msg, { ...defaultCtx, ...(extra && typeof extra === 'object' ? extra : {}) });
}

export function createLogger(defaultCtx = {}) {
  return {
    debug: bind(defaultCtx, 'debug'),
    info: bind(defaultCtx, 'info'),
    warn: bind(defaultCtx, 'warn'),
    error: bind(defaultCtx, 'error'),
    child: (extra) => createLogger({ ...defaultCtx, ...(extra || {}) }),
  };
}

export const logger = createLogger();

// 同一 key 在 ttlMs 内只输出一次，附带累计次数，避免 403 等错误刷屏
export function logThrottled(level, tag, key, msg, ttlMs = RATE_TTL, ctx = {}) {
  const now = Date.now();
  let s = rateState.get(key);
  if (!s) {
    s = { count: 0, first: now, last: 0 };
    rateState.set(key, s);
  }
  s.count += 1;
  if (now - s.last < ttlMs) return;
  s.last = now;
  const suffix = s.count > 1 ? `（近 ${Math.round(ttlMs / 1000)}s 累计 ${s.count} 次）` : '';
  emit(level, tag, `${msg}${suffix}`, { ...ctx, throttledKey: key });
}

export function getLogs(options = {}) {
  const { limit = 200, level = 'debug', since = 0, q = '' } = options;
  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  return ring
    .filter(
      (e) =>
        e.seq > since &&
        (LEVELS[e.level] ?? 0) >= min &&
        (!needle || `${e.tag} ${e.msg} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)),
    )
    .slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export function clearLogs() {
  ring.length = 0;
}

export function logStats() {
  return {
    total: seq,
    buffered: ring.length,
    maxBuffered: RING_MAX,
    consoleLevel: getConsoleLevel(),
  };
}
