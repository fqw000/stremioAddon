// src/logger.js
import { currentTraceId } from "./utils/traceId.js";

const LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[LEVEL] ?? 20;
const JSON_MODE = process.env.LOG_JSON === "true";

// ANSI 颜色
const C = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

function getTimeString() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fmt(level, args) {
  const time = getTimeString();
  const traceId = currentTraceId() || "-";
  // 只取 traceId 的前 6 位，更易读
  const shortTrace = traceId !== "-" ? `[req:${traceId.slice(0, 6)}]` : "";
  
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ");

  if (JSON_MODE) {
    return JSON.stringify({ time, level, traceId: traceId !== "-" ? traceId : undefined, msg });
  }

  let color = C.reset;
  let levelStr = level.toUpperCase();
  if (level === "debug") color = C.cyan;
  if (level === "info") color = C.green;
  if (level === "warn") color = C.yellow;
  if (level === "error") color = C.red;

  return `${C.gray}${time}${C.reset} ${color}[${levelStr}]${C.reset} ${C.magenta}${shortTrace}${C.reset} ${msg}`;
}

export const log = {
  debug: (...a) => MIN <= 10 && console.log(fmt("debug", a)),
  info:  (...a) => MIN <= 20 && console.log(fmt("info", a)),
  warn:  (...a) => MIN <= 30 && console.warn(fmt("warn", a)),
  error: (...a) => {
    if (MIN <= 40) {
      console.error(fmt("error", a));
      // 如果最后一个参数是 Error 对象，打印堆栈
      const last = a[a.length - 1];
      if (last instanceof Error && last.stack) {
        console.error(`${C.gray}${last.stack}${C.reset}`);
      }
    }
  },
};