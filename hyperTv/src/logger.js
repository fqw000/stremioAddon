// 运行日志：分级 + 「事项」分区 + 内存环形缓冲 + 限频汇总 + 敏感信息脱敏
// Edge Runtime 兼容（仅 Web Standard API）；Node 下自动启用 ANSI 颜色
//
// 关键约定（避免日志页越看越乱）：
//   1. 所有请求都写内存缓冲（2000 条封顶），终端默认 INFO 以上全输出；debug 请求额外输出 DEBUG 明细；
//   2. 每次请求输出一个 ========= 标题 ========= 分区，请求的路径/参数/配置/响应统计都在里面，
//      底层接口（源站 API / TMDB / OpenSubtitles）的完整 URL、状态、耗时、字节数在分区内展开；
//   3. 日志页（/api/logs）只在用户配置了 debug 的链接下可见，页面自身轮询不写日志。
//
// 用法：
//   import { logger, createLogger, getLogs } from './logger.js';
//   const L = createLogger({ reqId, capture: config.debug, force: config.debug });
//   L.section('字幕 · 解析 ID', { path, params });
//   L.info('subtitle', '上游返回 87 条');

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LABEL = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };
// debug 才写缓冲，2000 条足够覆盖一次完整排查
const RING_MAX = 2000;
const RATE_TTL = 60000;

// 完全不落盘的 logger：/api/logs 自身请求专用，杜绝「日志页轮询 → 写日志 → 挤掉业务日志」
export const NOOP_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  section() {},
  child() {
    return NOOP_LOGGER;
  },
  reqId: '',
  force: false,
};

const ring = [];
const rateState = new Map();
let seq = 0;

// ---- 终端配色 ----------------------------------------------------------------
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};
const USE_COLOR =
  !!globalThis.process?.stdout?.isTTY && !globalThis.process?.env?.NO_COLOR && !globalThis.process?.env?.TERM?.includes('dumb');

function paint(text, ...codes) {
  if (!USE_COLOR || !codes.length) return text;
  return `${codes.join('')}${text}${ANSI.reset}`;
}

const LEVEL_COLOR = {
  debug: [ANSI.gray],
  info: [ANSI.white],
  warn: [ANSI.yellow],
  error: [ANSI.red, ANSI.bold],
};

// 标签固定配色：排查时靠颜色就能分辨「这是源站 / TMDB / 字幕 / HTTP」
const TAG_COLOR = {
  http: [ANSI.blue],
  subtitle: [ANSI.magenta],
  upstream: [ANSI.cyan],
  tmdb: [ANSI.cyan],
  catalog: [ANSI.green],
  meta: [ANSI.green],
  stream: [ANSI.green],
  section: [ANSI.bold, ANSI.magenta],
};

function colorTag(tag) {
  return paint(`[${tag}]`, ...(TAG_COLOR[tag] || [ANSI.dim]));
}

// 只给真正的状态码上色（→ 200 / ← 404 / HTTP 500），避免把「100 条」之类也染色
function colorStatus(text) {
  if (!USE_COLOR) return text;
  return text.replace(/(→|←|HTTP)\s?(\d{3})\b/g, (m, arrow, code) => {
    const n = Number(code);
    const c = n >= 500 ? ANSI.red : n >= 400 ? ANSI.yellow : n >= 300 ? ANSI.cyan : ANSI.green;
    return `${arrow} ${paint(code, c)}`;
  });
}

// ---- 级别 --------------------------------------------------------------------
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

// capture / force 是控制位，不进入日志正文
function cleanCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const { capture, force, ...rest } = ctx;
  return rest;
}

function emit(level, tag, msg, ctx = {}) {
  const n = LEVELS[level] ?? LEVELS.info;
  const safe = redact(msg);
  // 所有请求都写缓冲（2000 条封顶，开销可忽略）；日志页是否可见由 debug 门禁决定
  const force = !!ctx.force;
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    level,
    tag: String(tag),
    msg: safe,
    ...(tag === 'section' ? { section: true } : {}),
    ctx: cleanCtx(ctx),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  // 终端：默认 INFO 以上全部输出；debug 请求额外输出 DEBUG 明细
  const wanted = n >= consoleLevel || (force && n >= LEVELS.debug);
  if (!wanted) return entry;

  const stream = n >= LEVELS.error ? console.error : n >= LEVELS.warn ? console.warn : console.log;
  const req = ctx.reqId ? paint(` (${ctx.reqId})`, ANSI.dim) : '';
  if (tag === 'section') {
    stream(paint(`${stamp()} ${safe}`, ...TAG_COLOR.section));
    return entry;
  }
  stream(
    `${paint(stamp(), ANSI.dim)} ${paint(`[${LABEL[level] || level}]`, ...(LEVEL_COLOR[level] || []))} ${colorTag(tag)}${req} ${colorStatus(safe)}`,
  );
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
    // 「事项」分区标题：========= 标题 =========
    // 分区内后续日志按 reqId 归拢，日志页会渲染成可折叠的段落
    section: (title, extra) =>
      emit('info', 'section', `========= ${title} =========`, {
        ...defaultCtx,
        ...(extra && typeof extra === 'object' ? extra : {}),
      }),
    child: (extra) => createLogger({ ...defaultCtx, ...(extra || {}) }),
    reqId: defaultCtx.reqId || '',
    force: !!defaultCtx.force,
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
    newestSeq: ring.length ? ring[ring.length - 1].seq : seq,
    oldestSeq: ring.length ? ring[0].seq : seq,
  };
}
