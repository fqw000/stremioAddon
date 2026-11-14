import { currentTraceId } from "./utils/traceId.js";

const LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[LEVEL] ?? 20;
const JSON_MODE = process.env.LOG_JSON === "true";

const COLORS = { debug: "\x1b[36m", info: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m", reset: "\x1b[0m" };

function fmt(level, args) {
  const traceId = currentTraceId();
  if (JSON_MODE) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level,
      traceId,
      msg: args.map(String).join(" "),
    });
  }
  const tag = traceId ? `[${traceId}] ` : "";
  return `${COLORS[level]}[${level.toUpperCase()}]${COLORS.reset} ${tag}${args.join(" ")}`;
}

export const log = {
  debug: (...a) => MIN <= 10 && console.log(fmt("debug", a)),
  info:  (...a) => MIN <= 20 && console.log(fmt("info", a)),
  warn:  (...a) => MIN <= 30 && console.warn(fmt("warn", a)),
  error: (...a) => MIN <= 40 && console.error(fmt("error", a)),
};
