// 统一缓存入口：有 Upstash 用 Upstash，否则降级内存
import * as memory from "./memory.js";
import * as upstash from "./upstash.js";
import { log } from "../logger.js";

const backend = upstash.isEnabled() ? upstash : memory;
log.info(`[cache] backend = ${upstash.isEnabled() ? "upstash" : "memory"}`);

export async function getJSON(key) {
  try {
    return await backend.get(key);
  } catch (e) {
    log.warn(`[cache] get ${key} failed: ${e.message}`);
    return null;
  }
}

export async function setJSON(key, value, ttlSeconds) {
  try {
    // 空结果 / 负结果不写（穿透保护）
    if (value == null) return;
    if (Array.isArray(value) && value.length === 0) return;
    await backend.set(key, value, ttlSeconds);
  } catch (e) {
    log.warn(`[cache] set ${key} failed: ${e.message}`);
  }
}

export async function delJSON(key) {
  try {
    await backend.del(key);
  } catch (e) {
    log.warn(`[cache] del ${key} failed: ${e.message}`);
  }
}

export async function pingCache() {
  return backend.ping();
}

export function backendName() {
  return upstash.isEnabled() ? "upstash" : "memory";
}
