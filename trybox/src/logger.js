// packages/src/logger.js

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let globalLevel = 'info';

export function setLogLevel(level) {
  globalLevel = level;
}

function formatTime() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function createLogger(module) {
  const prefix = `[${module}]`;
  return {
    debug: (...args) => {
      if (LEVELS[globalLevel] <= LEVELS.debug) console.log(`[${formatTime()}]${prefix} [DEBUG]`, ...args);
    },
    info: (...args) => {
      if (LEVELS[globalLevel] <= LEVELS.info) console.log(`[${formatTime()}]${prefix} [INFO]`, ...args);
    },
    warn: (...args) => {
      if (LEVELS[globalLevel] <= LEVELS.warn) console.warn(`[${formatTime()}]${prefix} [WARN]`, ...args);
    },
    error: (...args) => {
      if (LEVELS[globalLevel] <= LEVELS.error) console.error(`[${formatTime()}]${prefix} [ERROR]`, ...args);
    },
  };
}

export function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

export function utf8Size(s) {
  return new TextEncoder().encode(s).length;
}

export function toKB(bytes) {
  return +(bytes / 1024).toFixed(2);
}