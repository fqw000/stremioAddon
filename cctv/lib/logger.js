'use strict';

// 运行日志：默认完全关闭（不写终端、不写文件、不进内存缓冲）。
// 仅在两种情况开启：
//   1. 安装链接的配置里 debug=true（按请求开启，AsyncLocalStorage 隔离并发请求）；
//   2. 手动调用 /api/logs?enable=1（进程级临时开启，重启后恢复关闭）。
// 日志页 /api/logs 自身不写日志，避免轮询把业务日志冲掉。

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { TRACE: 10, DEBUG: 20, INFO: 30, WARN: 40, ERROR: 50, SILENT: 99 };
const COLORS = {
  TRACE: '\x1b[90m', DEBUG: '\x1b[36m', INFO: '\x1b[32m',
  WARN: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m'
};

const RING_MAX = 3000;
const als = new AsyncLocalStorage();
const ring = [];
let seq = 0;
let globalEnabled = process.env.LOG_ENABLED === '1';
let consoleMin = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] || LEVELS.INFO;

const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
let logFile = null;
try {
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'addon.log');
} catch (e) {
  logFile = null;
}

function nextId() {
  seq = (seq + 1) % 100000;
  return String(seq).padStart(5, '0');
}

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// 用户明确要求完整回显的字段不截断
const FULL_KEYS = new Set([
  'fullUrl', 'fullUrls', 'streamUrls', 'url', 'origin', 'upstreamUrl',
  'episodeUrl', 'path', 'hlsUrl', 'm3u8Url', 'proxyUrl', 'tsUrl'
]);
const SECRET_KEYS = /^(cfg|password|pass|token|api[_-]?key|secret|authorization)$/i;

function sanitize(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitize(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = SECRET_KEYS.test(k) ? '<redacted>' : sanitize(value[k], depth + 1);
  }
  return out;
}

function fmt(value, maxLen = 1200, depth = 4, key = '') {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const limit = FULL_KEYS.has(key) ? Infinity : maxLen;
    return value.length > limit ? JSON.stringify(value.slice(0, limit) + '…') : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return '[Function]';
  if (depth <= 0) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  try {
    let out;
    if (Array.isArray(value)) {
      const itemLimit = FULL_KEYS.has(key) ? Infinity : Math.floor(maxLen / 4);
      const shown = value.slice(0, 10).map(v => fmt(v, itemLimit, depth - 1, key));
      out = '[' + shown.join(', ') + (value.length > 10 ? `, …+${value.length - 10}` : '') + ']';
    } else {
      const parts = [];
      for (const k of Object.keys(value)) {
        const childLimit = FULL_KEYS.has(k) ? Infinity : Math.floor(maxLen / 4);
        parts.push(JSON.stringify(k) + ':' + fmt(value[k], childLimit, depth - 1, k));
      }
      out = '{' + parts.join(', ') + '}';
    }
    const limit = FULL_KEYS.has(key) ? Infinity : maxLen;
    return out.length > limit ? out.slice(0, limit) + '…' : out;
  } catch (e) {
    return String(value);
  }
}

function emit(level, tag, message, data) {
  const store = als.getStore() || {};
  if (store.silent) return null;
  const enabled = store.force || store.enabled || globalEnabled;
  if (!enabled) return null;

  const n = LEVELS[level] || LEVELS.INFO;
  const ctx = data === undefined ? {} : (typeof data === 'object' ? sanitize(data) : { value: data });
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    level: String(level).toLowerCase(),
    tag: String(tag),
    msg: String(message),
    ctx,
    reqId: store.reqId || ''
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  const minPrint = store.consoleLevel || consoleMin;
  if (n >= minPrint) {
    const head = `[${ts()}] [${entry.reqId || nextId()}] [${level}] [${tag}]`;
    const line = `${head} ${message}` + (data !== undefined ? ` ${fmt(ctx)}` : '');
    const color = COLORS[level] || '';
    console.log(color + line + COLORS.RESET);
    if (logFile) {
      try { fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* ignore */ }
    }
  }
  return entry;
}

function bind(level) {
  return (tag, message, data) => emit(level, tag, message, data);
}

const logger = {
  trace: bind('TRACE'),
  debug: bind('DEBUG'),
  info: bind('INFO'),
  warn: bind('WARN'),
  error: bind('ERROR'),
  section: (tag, title, data) => emit('INFO', 'section', `========= ${title} =========`, { ...(data || {}), sectionTag: tag }),
  nextId,
  run: (ctx, fn) => als.run(ctx, fn),
  getStore: () => als.getStore() || {},
  setEnabled: (v) => { globalEnabled = !!v; },
  isEnabled: () => globalEnabled,
  setConsoleLevel: (level) => {
    const parsed = LEVELS[String(level || '').toUpperCase()];
    if (parsed) consoleMin = parsed;
  },
  getLogs: ({ limit = 400, level = 'DEBUG', since = 0, q = '' } = {}) => {
    const min = LEVELS[String(level).toUpperCase()] || LEVELS.DEBUG;
    const needle = String(q || '').toLowerCase();
    return ring
      .filter(e => e.seq > Number(since || 0))
      .filter(e => (LEVELS[String(e.level).toUpperCase()] || 0) >= min)
      .filter(e => !needle || `${e.tag} ${e.msg} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle))
      .slice(-Math.max(1, Math.min(1000, Number(limit) || 400)));
  },
  clearLogs: () => { ring.length = 0; },
  stats: () => ({
    total: seq,
    buffered: ring.length,
    maxBuffered: RING_MAX,
    globalEnabled,
    newestSeq: ring.length ? ring[ring.length - 1].seq : seq,
    oldestSeq: ring.length ? ring[0].seq : seq
  }),
  fmt,
  getLogFile: () => logFile
};

module.exports = logger;
