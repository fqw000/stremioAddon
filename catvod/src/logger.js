// Catvod 统一日志系统（Node / Express）
// 设计见 ../日志系统规范.md：分级 + 脱敏 + 限频 + reqId 上下文 + Upstash Redis 三视图。
// 保留旧导出 `log`（单例，各模块 import 使用）与 traceId（AsyncLocalStorage）。
// 关键：Node 是长驻进程，并发请求共用模块变量，故日志 store 用 ALS 按请求隔离，
//       避免 A 请求的 scope/debugUser 覆盖 B 请求。
// Redis 不可用时静默降级内存环形缓冲，不影响业务。

import { AsyncLocalStorage } from "node:async_hooks";
import { currentTraceId } from "./utils/traceId.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const LABEL = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };
const RING_MAX = 300;
const RATE_TTL = 60000;
const ALL_SCOPE = "__all__";
const GLOBAL_SCOPE = "__debug_all__";
const SAFE_CFG_KEYS = ["dbg", "debug", "uid", "cats", "feats", "lang", "subLang", "srcs", "bd", "d555", "imdb", "stream", "banIp", "enableDebug"];

const LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const MIN = LEVELS[LEVEL] ?? 20;
const JSON_MODE = process.env.LOG_JSON === "true";

const C = { reset:"\x1b[0m", gray:"\x1b[90m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m", cyan:"\x1b[36m", magenta:"\x1b[35m" };
let globalLevel = LEVEL;

// 每请求隔离的日志上下文（ALS）
const storeALS = new AsyncLocalStorage();
let fallbackStore = null;   // 非请求上下文（启动/脚本）使用
const ring = [];
const rateState = new Map();
const pendingWrites = [];
let seq = 0;

function activeStore() {
  const s = storeALS.getStore();
  return (s && s.store) || fallbackStore;
}

// ── 级别（兼容旧调用：设置全局输出级别）─────────────────────
export function setLogLevel(level) {
  const v = String(level || "info").toLowerCase().trim();
  if (LEVELS[v] !== undefined) globalLevel = v;
}
export function getLogLevel() { return globalLevel; }

// ── 脱敏（强制）────────────────────────────────────────────
export function redact(text) {
  let s = String(text ?? "");
  s = s.replace(/([?&](?:api_key|apikey|password|pass|token|auth|secret|key)=)[^&\s"']+/gi, "$1***");
  s = s.replace(/([?&]cfg=)[A-Za-z0-9_-]{8,}/g, (m, p) => `${p}<${m.length - p.length}chars>`);
  s = s.replace(/([?&]u=)[^&\s"']{40,}/g, "$1***");
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1***");
  return s;
}

export function scopeFromCfg(cfg) {
  if (!cfg) return "default";
  let h = 5381;
  for (let i = 0; i < cfg.length; i++) h = ((h << 5) + h + cfg.charCodeAt(i)) | 0;
  return "u" + (h >>> 0).toString(36).slice(0, 6);
}

export function safeCfgTag(cfgParam) {
  if (!cfgParam) return "cfg=<default>";
  try {
    let b64 = String(cfgParam).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    const safe = {};
    for (const k of SAFE_CFG_KEYS) if (Object.prototype.hasOwnProperty.call(obj, k)) safe[k] = obj[k];
    const names = Object.keys(safe);
    if (!names.length) return "cfg=<none>";
    const enc = Buffer.from(JSON.stringify(safe)).toString("base64url");
    return "cfg=" + enc;
  } catch (e) {
    return "cfg=<invalid>";
  }
}

// ── 存储初始化 ─────────────────────────────────────────────
export function initLogStore(env, { prefix, scope, debugUser, cfgTag, uid, globalScope } = {}) {
  const url = env?.UPSTASH_REDIS_REST_URL || "";
  const token = env?.UPSTASH_REDIS_REST_TOKEN || "";
  const p = prefix || env?.APP_PREFIX || "catvod";
  const s = scope || "default";
  const cfg = (url && token) ? {
    url, token,
    key: `${p}:logs:${s}`,
    allKey: `${p}:logs:${ALL_SCOPE}`,
    globalKey: `${p}:logs:${globalScope || GLOBAL_SCOPE}`,
    scope: s,
    debugUser: !!debugUser,
    cfgTag: cfgTag || "",
    uid: uid || "",
  } : null;
  if (storeALS.getStore()) storeALS.getStore().store = cfg;
  else fallbackStore = cfg;
  if (cfgDebugUser(debugUser)) globalLevel = "debug";
  return cfg;
}
function cfgDebugUser(v) { return v === true; }

/** 在一个请求上下文里运行 fn，日志 store 按请求隔离 */
export function runWithLogStore(fn) {
  return storeALS.run({ store: null }, fn);
}

async function redisPipeline(commands) {
  const sc = activeStore();
  if (!sc) return null;
  try {
    const res = await fetch(`${sc.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sc.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function persist(level, entry) {
  const sc = activeStore();
  if (!sc) return;
  if (LEVELS[level] < LEVELS[globalLevel]) return; // 常态 info+
  const cmds = [
    ["LPUSH", sc.key, JSON.stringify(entry)],
    ["LTRIM", sc.key, 0, RING_MAX - 1],
    ["EXPIRE", sc.key, "604800"],
  ];
  const whoEntry = { ...entry, cfg: sc.cfgTag || "cfg=<default>", scope: sc.scope, uid: sc.uid || "" };
  const whoPayload = JSON.stringify(whoEntry);
  cmds.push(["LPUSH", sc.allKey, whoPayload], ["LTRIM", sc.allKey, 0, RING_MAX - 1], ["EXPIRE", sc.allKey, "604800"]);
  if (sc.debugUser) {
    cmds.push(["LPUSH", sc.globalKey, whoPayload], ["LTRIM", sc.globalKey, 0, RING_MAX - 1], ["EXPIRE", sc.globalKey, "604800"]);
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

function msgOf(args) {
  return args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(" ");
}

function emit(level, tag, msg, ctx = {}) {
  const n = LEVELS[level] ?? LEVELS.info;
  const safe = redact(msg);
  const rid = ctx.reqId || currentTraceId();
  const reqId = rid ? ` [req:${String(rid).slice(0, 6)}]` : "";
  const entry = {
    seq: ++seq, ts: new Date().toISOString(), level, tag: String(tag), msg: safe,
    ...(tag === "section" ? { section: true } : {}),
    ...(ctx && Object.keys(ctx).length ? { ctx } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  persist(level, entry);

  if (JSON_MODE) {
    console.log(JSON.stringify({ time: stamp(), level, tag, traceId: rid || undefined, msg: safe }));
  } else if (n >= LEVELS[globalLevel] || ctx.force) {
    const color = level === "error" ? C.red : level === "warn" ? C.yellow : level === "debug" ? C.cyan : C.green;
    const stream = n >= LEVELS.error ? console.error : n >= LEVELS.warn ? console.warn : console.log;
    stream(`${C.gray}${stamp()}${C.reset} ${color}[${LABEL[level] || level}]${C.reset}${C.magenta}${reqId}${C.reset} ${safe}`);
  }
  return entry;
}

/** 单例 log（旧 API 兼容） */
export const log = {
  debug: (...a) => emit("debug", "app", msgOf(a)),
  info:  (...a) => emit("info",  "app", msgOf(a)),
  warn:  (...a) => emit("warn",  "app", msgOf(a)),
  error: (...a) => {
    emit("error", "app", msgOf(a));
    const last = a[a.length - 1];
    if (last instanceof Error && last.stack) console.error(`${C.gray}${last.stack}${C.reset}`);
  },
  section: (title, extraCtx = {}) => emit("info", "section", `========= ${title} =========`, extraCtx),
};

export function createLogger(module, defaultCtx = {}) {
  const tag = String(module || "app");
  const bind = (level) => (...args) => emit(level, tag, msgOf(args), defaultCtx);
  return {
    debug: bind("debug"), info: bind("info"), warn: bind("warn"), error: bind("error"),
    section: (title, extraCtx = {}) => emit("info", "section", `========= ${title} =========`, { ...defaultCtx, ...(extraCtx || {}) }),
    child: (extra) => createLogger(tag, { ...defaultCtx, ...(extra || {}) }),
    with: (extra) => createLogger(tag, { ...defaultCtx, ...(extra || {}) }),
  };
}

export function logThrottled(level, tag, key, msg, ttlMs = RATE_TTL, ctx = {}) {
  const now = Date.now();
  let s = rateState.get(key);
  if (!s) { s = { count: 0, last: 0 }; rateState.set(key, s); }
  s.count++;
  if (now - s.last < ttlMs) return;
  s.last = now;
  const suffix = s.count > 1 ? `（近 ${Math.round(ttlMs / 1000)}s 累计 ${s.count} 次）` : "";
  emit(level, tag, `${msg}${suffix}`, { ...ctx, throttledKey: key });
}

// ── 查询 ──────────────────────────────────────────────────
function fromRing(options) {
  const { limit = 200, level = "debug", since = 0, q = "" } = options;
  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  return ring.filter((e) => e.seq > since && (LEVELS[e.level] ?? 0) >= min &&
    (!needle || `${e.tag} ${e.msg} ${e.cfg || ""} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)))
    .slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function getLogs(options = {}) {
  const { limit = 200, level = "debug", since = 0, q = "", global: useGlobal = false, view = "" } = options;
  const sc = activeStore();
  if (!sc) return fromRing(options);
  const key = view === "all" ? sc.allKey : (view === "debug" || useGlobal) ? sc.globalKey : sc.key;
  const data = await redisPipeline([["LRANGE", key, 0, RING_MAX - 1]]);
  const raw = data?.[0]?.result;
  if (!Array.isArray(raw) || raw.length === 0) return fromRing(options);
  const min = LEVELS[level] ?? LEVELS.debug;
  const needle = String(q).toLowerCase();
  const out = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    let e;
    try { e = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i]; } catch (e2) { continue; }
    if (!e || (LEVELS[e.level] ?? 0) < min) continue;
    if (needle && !`${e.tag} ${e.msg} ${e.cfg || ""} ${JSON.stringify(e.ctx || {})}`.toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export async function clearLogs(options = {}) {
  ring.length = 0;
  const { global: useGlobal = false, view = "" } = options;
  const sc = activeStore();
  const key = view === "all" ? sc?.allKey : (view === "debug" || useGlobal) ? sc?.globalKey : sc?.key;
  if (sc && key) await redisPipeline([["DEL", key]]);
}

export function logStats() {
  const sc = activeStore();
  return {
    total: seq, buffered: ring.length, maxBuffered: RING_MAX, consoleLevel: globalLevel,
    store: sc ? "upstash" : "memory",
    scope: sc?.scope || "default",
    globalScope: sc?.globalKey ? sc.globalKey.split(":").pop() : "",
  };
}

export function now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }
export function utf8Size(s) { return Buffer.byteLength(String(s)); }
export function toKB(bytes) { return +(bytes / 1024).toFixed(2); }
