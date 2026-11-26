/**
 * 统一日志系统（dongpiandi / 懂片帝）
 *
 * 设计见 ../日志系统规范.md：分级 + 脱敏 + 限频 + reqId 上下文 + Upstash Redis 三视图。
 * 在保留旧 API（createLogger / setLogLevel / resetLogLevel / getLogLevel / timer）的同时，
 * 叠加与 trybox / jpyy555 一致的能力：
 *   - 个人流   {prefix}:logs:{scope}
 *   - 全量流   {prefix}:logs:__all__       （所有用户 info+）
 *   - debug 流 {prefix}:logs:__debug_all__ （仅 debug 用户 debug+）
 *   - section 事项分区、redact 脱敏、logThrottled 限频、waitUntil 刷写
 *
 * Edge Runtime 兼容：仅 Web Standard API（fetch / atob / btoa / TextEncoder）。
 * Redis 不可用静默降级内存环形缓冲，不影响业务。
 *
 * 用法：
 *   import { createLogger, initLogStore, flushLogWrites } from './logger.js';
 *   const log = createLogger('Stream');
 *   log.info('选中 vodId=135604');
 *   log.section('播放源 · GET /stream/movie/xxx', { path, method });
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LABEL = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
const RING_MAX = 300;
const RATE_TTL = 60000;
const ALL_SCOPE = '__all__';
const GLOBAL_SCOPE = '__debug_all__';
// 非敏感 cfg 字段白名单；凭证 rt/at/tk 等一律排除
const SAFE_CFG_KEYS = ['dbg', 'debug', 'uid', 'cats', 'feats', 'lang', 'subLang', 'removeIdValidation', 'srcs', 'bd', 'd555', 'imdb', 'stream', 'banIp', 'enableDebug'];

let globalLevel = 'info';      // 控制台输出级别
let requestLevel = null;       // 请求级临时覆盖（兼容旧 API）
let storeCfg = null;
const ring = [];
const rateState = new Map();
const pendingWrites = [];
let seq = 0;

// ── 级别（兼容旧 API）──────────────────────────────────────
export function setLogLevel(level) {
  if (typeof level === 'number') { requestLevel = level; return; }
  const v = String(level || 'info').toLowerCase().trim();
  if (LEVELS[v] !== undefined) requestLevel = LEVELS[v];
}
export function resetLogLevel() { requestLevel = null; }
export function getLogLevel() {
  if (requestLevel !== null) return Object.keys(LEVELS).find(k => LEVELS[k] === requestLevel) || 'info';
  return globalLevel;
}

// ── 脱敏（强制）────────────────────────────────────────────
export function redact(text) {
  let s = String(text ?? '');
  s = s.replace(/([?&](?:api_key|apikey|password|pass|token|auth|secret|key)=)[^&\s"']+/gi, '$1***');
  s = s.replace(/([?&]cfg=)[A-Za-z0-9_-]{8,}/g, (m, p) => `${p}<${m.length - p.length}chars>`);
  s = s.replace(/([?&]u=)[^&\s"']{40,}/g, '$1***');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1***');
  return s;
}

// ── scope 派生 ─────────────────────────────────────────────
export function scopeFromCfg(cfg) {
  if (!cfg) return 'default';
  let h = 5381;
  for (let i = 0; i < cfg.length; i++) h = ((h << 5) + h + cfg.charCodeAt(i)) | 0;
  return 'u' + (h >>> 0).toString(36).slice(0, 6);
}

// ── cfg 安全标识 ────────────────────────────────────────────
export function safeCfgTag(cfgParam) {
  if (!cfgParam) return 'cfg=<default>';
  try {
    let b64 = String(cfgParam).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const obj = JSON.parse(atob(b64));
    const safe = {};
    for (const k of SAFE_CFG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) safe[k] = obj[k];
    }
    const names = Object.keys(safe);
    if (!names.length) return 'cfg=<none>';
    const enc = btoa(JSON.stringify(safe)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'cfg=' + enc;
  } catch (e) {
    return 'cfg=<invalid>';
  }
}

// ── Redis 后端 ────────────────────────────────────────────
export function initLogStore(env, { prefix, scope, debugUser, cfgTag, uid, globalScope } = {}) {
  const url = env?.UPSTASH_REDIS_REST_URL || '';
  const token = env?.UPSTASH_REDIS_REST_TOKEN || '';
  const p = prefix || env?.APP_PREFIX || 'dongpiandi';
  const s = scope || 'default';
  storeCfg = (url && token) ? {
    url, token,
    key: `${p}:logs:${s}`,
    allKey: `${p}:logs:${ALL_SCOPE}`,
    globalKey: `${p}:logs:${globalScope || GLOBAL_SCOPE}`,
    scope: s,
    debugUser: !!debugUser,
    cfgTag: cfgTag || '',
    uid: uid || '',
  } : null;
}

function redisAvailable() { return !!storeCfg; }

async function redisPipeline(commands) {
  if (!redisAvailable()) return null;
  try {
    const res = await fetch(`${storeCfg.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${storeCfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function currentMinLevel() {
  if (requestLevel !== null) return requestLevel;
  return LEVELS[globalLevel] ?? LEVELS.info;
}

function persist(level, entry) {
  if (!redisAvailable()) return;
  if (LEVELS[level] < LEVELS[globalLevel]) return; // 常态 info+；requestLevel 只放宽控制台，不放宽存储
  const cmds = [
    ['LPUSH', storeCfg.key, JSON.stringify(entry)],
    ['LTRIM', storeCfg.key, 0, RING_MAX - 1],
    ['EXPIRE', storeCfg.key, '604800'],
  ];
  const whoEntry = {
    ...entry,
    cfg: storeCfg.cfgTag || 'cfg=<default>',
    scope: storeCfg.scope,
    uid: storeCfg.uid || '',
  };
  const whoPayload = JSON.stringify(whoEntry);
  cmds.push(['LPUSH', storeCfg.allKey, whoPayload]);
  cmds.push(['LTRIM', storeCfg.allKey, 0, RING_MAX - 1]);
  cmds.push(['EXPIRE', storeCfg.allKey, '604800']);
  if (storeCfg.debugUser) {
    cmds.push(['LPUSH', storeCfg.globalKey, whoPayload]);
    cmds.push(['LTRIM', storeCfg.globalKey, 0, RING_MAX - 1]);
    cmds.push(['EXPIRE', storeCfg.globalKey, '604800']);
  }
  pendingWrites.push(redisPipeline(cmds).catch(() => {}));
}

export function flushLogWrites() {
  if (pendingWrites.length === 0) return Promise.resolve();
  return Promise.all(pendingWrites.splice(0)).then(() => {});
}

// ── emit ──────────────────────────────────────────────────
function stamp() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 23);
}

function emit(level, tag, msg, ctx = {}) {
  const n = LEVELS[level] ?? LEVELS.info;
  const safe = redact(typeof msg === 'string' ? msg : JSON.stringify(msg));
  const reqId = ctx.reqId ? ` (${ctx.reqId})` : '';
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    level, tag: String(tag), msg: safe,
    ...(tag === 'section' ? { section: true } : {}),
    ...(ctx && typeof ctx === 'object' ? { ctx } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  persist(level, entry);

  if (n >= currentMinLevel() || ctx.force) {
    const stream = n >= LEVELS.error ? console.error : n >= LEVELS.warn ? console.warn : console.log;
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
  const section = (title, extraCtx = {}) =>
    emit('info', 'section', `========= ${title} =========`, { ...defaultCtx, ...(extraCtx || {}) });
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
    section,
    child: (extra) => createLogger(tag, { ...defaultCtx, ...(extra || {}) }),
    with: (extra) => createLogger(tag, { ...defaultCtx, ...(extra || {}) }),
    /** 兼容旧 timer：const t = log.timer(); t('label') → 打印耗时 */
    timer: () => {
      const start = Date.now();
      return (label) => emit('debug', tag, `${label} (${Date.now() - start}ms)`, defaultCtx);
    },
  };
}

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
      (!needle || `${e.tag} ${e.msg} ${e.cfg || ''} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)))
    .slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function getLogs(options = {}) {
  const { limit = 200, level = 'debug', since = 0, q = '', global: useGlobal = false, view = '' } = options;
  if (!redisAvailable()) return fromRing(options);
  const key = view === 'all' ? storeCfg.allKey
    : (view === 'debug' || useGlobal) ? storeCfg.globalKey
    : storeCfg.key;
  const data = await redisPipeline([['LRANGE', key, 0, RING_MAX - 1]]);
  const raw = data?.[0]?.result;
  if (!Array.isArray(raw) || raw.length === 0) return fromRing(options);
  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  const out = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    let e;
    try { e = typeof raw[i] === 'string' ? JSON.parse(raw[i]) : raw[i]; } catch (e2) { continue; }
    if (!e || (LEVELS[e.level] ?? 0) < min) continue;
    if (needle && !`${e.tag} ${e.msg} ${e.cfg || ''} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function clearLogs(options = {}) {
  ring.length = 0;
  const { global: useGlobal = false, view = '' } = options;
  const key = view === 'all' ? storeCfg.allKey
    : (view === 'debug' || useGlobal) ? storeCfg.globalKey
    : storeCfg.key;
  if (redisAvailable() && key) await redisPipeline([['DEL', key]]);
}

export function logStats() {
  return {
    total: seq,
    buffered: ring.length,
    maxBuffered: RING_MAX,
    consoleLevel: globalLevel,
    store: redisAvailable() ? 'upstash' : 'memory',
    scope: storeCfg?.scope || 'default',
    globalScope: storeCfg?.globalKey ? storeCfg.globalKey.split(':').pop() : '',
  };
}

export function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
export function utf8Size(s) { return new TextEncoder().encode(s).length; }
export function toKB(bytes) { return +(bytes / 1024).toFixed(2); }
