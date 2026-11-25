// 统一运行日志：分级 + 脱敏 + 限频 + reqId 上下文 + Upstash Redis 持久化
//
// 设计见 /Users/wangqifei/Documents/stremio/stremioAddon/日志系统规范.md
// - 常态写 info+；配置页 debug 打开时该请求写 debug+
// - 全局调试流：仅 debug 用户写入 {prefix}:logs:__debug_all__，带脱敏 cfg 标识
// - Edge Runtime 兼容：仅用 Web Standard API（fetch / atob / btoa / TextEncoder）
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
const ALL_SCOPE = '__all__';       // 全量汇总流：所有用户 info+
const GLOBAL_SCOPE = '__debug_all__'; // debug 汇总流：仅 debug 用户 debug+
// 允许出现在 cfg 标识里的非敏感字段；rt/at/tk 等凭证一律排除
const SAFE_CFG_KEYS = ['dbg', 'uid', 'cats', 'feats', 'lang', 'subLang', 'removeIdValidation', 'srcs', 'bd', 'd555', 'imdb', 'stream', 'banIp'];

let globalLevel = 'info';      // 控制台输出级别
let storeCfg = null;           // { url, token, key, globalKey, scope, debugUser, cfgTag }
const ring = [];               // 内存缓冲（Redis 写入失败的降级 / 本地开发）
const rateState = new Map();
const pendingWrites = [];      // 待完成的 Redis 写入 Promise，由入口用 context.waitUntil() 兜底
let seq = 0;

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

// ── cfg 安全标识 ────────────────────────────────────────────
// 全局日志靠 cfg 区分用户/配置，但绝不能泄露 rt/at/tk 等凭证。
// 只保留非敏感白名单字段后重新编码；仅 dbg:true 时结果恰为 eyJkYmciOnRydWV9。
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
    const json = JSON.stringify(safe);
    const enc = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'cfg=' + enc;
  } catch (e) {
    return 'cfg=<invalid>';
  }
}

// ── Redis 后端 ────────────────────────────────────────────
// 个人流 key  = {APP_PREFIX}:logs:{scope}          （每个 cfg 一条）
// 全量流 key  = {APP_PREFIX}:logs:__all__          （所有用户 info+，页面「所有用户」视图）
// debug流 key = {APP_PREFIX}:logs:__debug_all__    （仅 debug 用户 debug+，页面「debug用户」视图）
export function initLogStore(env, { prefix, scope, debugUser, cfgTag, uid, globalScope } = {}) {
  const url = env?.UPSTASH_REDIS_REST_URL || '';
  const token = env?.UPSTASH_REDIS_REST_TOKEN || '';
  const p = prefix || env?.APP_PREFIX || 'trybox';
  const s = scope || 'default';
  storeCfg = (url && token) ? {
    url,
    token,
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
  if (!redisAvailable()) return;                  // 降级：只留内存
  if (LEVELS[level] < LEVELS[globalLevel]) return; // 常态只写 info+
  const cmds = [
    ['LPUSH', storeCfg.key, JSON.stringify(entry)],
    ['LTRIM', storeCfg.key, 0, RING_MAX - 1],
    ['EXPIRE', storeCfg.key, '604800'],
  ];
  // 带用户来源的条目（全量流 / debug 流共用）：uid 明文 + scope
  const whoEntry = {
    ...entry,
    cfg: storeCfg.cfgTag || 'cfg=<default>',
    scope: storeCfg.scope,
    uid: storeCfg.uid || '',
  };
  const whoPayload = JSON.stringify(whoEntry);
  // 全量流：所有请求都汇总（跟随 globalLevel 过滤），供页面「所有用户」视图
  cmds.push(['LPUSH', storeCfg.allKey, whoPayload]);
  cmds.push(['LTRIM', storeCfg.allKey, 0, RING_MAX - 1]);
  cmds.push(['EXPIRE', storeCfg.allKey, '604800']);
  // debug 流：只有开启 debug 的请求写入，供页面「debug用户」视图。
  // 没开 debug 的请求不写此流。
  if (storeCfg.debugUser) {
    cmds.push(['LPUSH', storeCfg.globalKey, whoPayload]);
    cmds.push(['LTRIM', storeCfg.globalKey, 0, RING_MAX - 1]);
    cmds.push(['EXPIRE', storeCfg.globalKey, '604800']);
  }
  const p = redisPipeline(cmds).catch(() => {});
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
  // 北京时间（UTC+8）显示，终端与日志页保持一致
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 23);
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
      (!needle || `${e.tag} ${e.msg} ${e.cfg || ''} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)))
    .slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function getLogs(options = {}) {
  const { limit = 200, level = 'debug', since = 0, q = '', global: useGlobal = false, view = '' } = options;
  if (!redisAvailable()) return fromRing(options);

  // view: 'personal'(个人) | 'all'(所有用户) | 'debug'(debug用户)；global 为旧别名 → debug
  const key = view === 'all' ? storeCfg.allKey
    : (view === 'debug' || useGlobal) ? storeCfg.globalKey
    : storeCfg.key;
  const data = await redisPipeline([['LRANGE', key, 0, RING_MAX - 1]]);
  const raw = data?.[0]?.result;
  if (!Array.isArray(raw) || raw.length === 0) return fromRing(options);

  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  const out = [];
  for (let i = raw.length - 1; i >= 0; i--) {   // LPUSH 是最新在前，反转为时间正序
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
