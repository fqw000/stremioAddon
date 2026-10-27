/**
 * Token 管理
 *
 * 三级刷新流程：
 *   1. 检查 access_token 是否有效（JWT exp 未过期）
 *      ├── 有效 → 直接使用
 *      └── 无效 → 尝试用 refresh_token 刷新
 *            ├── 成功 → 保存新 token → 使用
 *            └── 失败 → 尝试用 access_token 刷新
 *                  ├── 成功 → 保存新 token → 使用
 *                  └── 失败 → Bark 告警 → 使用 fallback
 *
 * 存储：
 *   - 内存缓存（Edge Runtime 单 isolate 内有效）
 *   - Upstash Redis（跨 isolate / 跨请求持久化）
 *
 * 使用 Upstash REST API（原生 fetch，无 SDK 依赖）
 */

import { createLogger } from './logger.js';
import { SUPABASE, TTL } from './constants.js';
import { postJson } from './http.js';

const log = createLogger('Token');

// ────────────────────────────────────────────────────────────
// 内存缓存（存完整 token 对象）
// ────────────────────────────────────────────────────────────
let memoryTokens = null;  // { access, refresh, accessExp }

// ────────────────────────────────────────────────────────────
// Upstash REST API 轻量客户端
// ────────────────────────────────────────────────────────────

function upstashUrl(env) {
  return env?.UPSTASH_REDIS_REST_URL;
}

function upstashHeaders(env) {
  return { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` };
}

/** Pipeline：一次发多个命令 */
async function redisPipeline(env, commands) {
  if (!upstashUrl(env)) return [];
  const res = await fetch(`${upstashUrl(env)}/pipeline`, {
    method: 'POST',
    headers: {
      ...upstashHeaders(env),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Upstash PIPELINE ${res.status}`);
  return await res.json();
}

// ────────────────────────────────────────────────────────────
// JWT 解析
// ────────────────────────────────────────────────────────────

/**
 * 解析 JWT 的 exp 字段，返回毫秒时间戳
 */
function decodeJwtExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = JSON.parse(atob(b64));
    return json.exp ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * 判断 access_token 是否有效（未过期，留 60s 余量）
 */
function isAccessValid(accessToken) {
  if (!accessToken) return false;
  const exp = decodeJwtExpiry(accessToken);
  if (!exp) return true; // 解析失败，假设有效（保守）
  return exp > Date.now() + 60_000;
}

// ────────────────────────────────────────────────────────────
// Token 读写
// ────────────────────────────────────────────────────────────

async function readToken(env, prefix) {
  try {
    const results = await redisPipeline(env, [
      ['GET', `${prefix}:token:access`],
      ['GET', `${prefix}:token:refresh`],
    ]);
    const parse = (v) => {
      if (v == null) return null;
      try { return JSON.parse(v); } catch { return v; }
    };
    const access = parse(results?.[0]?.result);
    const refresh = parse(results?.[1]?.result);
    if (access || refresh) {
      log.info(`从 Redis 读取 token: access=${access ? '有' : '无'}, refresh=${refresh ? '有' : '无'}`);
    }
    return { access, refresh };
  } catch (e) {
    log.warn('Redis 读取失败:', e.message);
    return { access: null, refresh: null };
  }
}

/**
 * 同时写内存和 Redis
 */
async function writeToken(env, prefix, accessToken, refreshToken) {
  const exp = decodeJwtExpiry(accessToken);
  memoryTokens = {
    access: accessToken,
    refresh: refreshToken,
    accessExp: exp || Date.now() + 3600_000,
  };
  log.info(`token 已缓存到内存: exp=${exp ? new Date(exp).toISOString() : '未知'}`);

  if (upstashUrl(env)) {
    try {
      await redisPipeline(env, [
        ['SET', `${prefix}:token:access`, JSON.stringify(accessToken), 'EX', 3600],
        ['SET', `${prefix}:token:refresh`, JSON.stringify(refreshToken)],
      ]);
      log.info(`token 已写入 Redis: prefix=${prefix}`);
    } catch (e) {
      log.warn('token 写入 Redis 失败:', e.message);
    }
  } else {
    log.warn('UPSTASH 未配置，token 仅缓存到内存');
  }
}

// ────────────────────────────────────────────────────────────
// Supabase 刷新
// ────────────────────────────────────────────────────────────

async function refreshWithRefreshToken(refreshToken) {
  const data = await postJson(
    `${SUPABASE.url}/auth/v1/token?grant_type=refresh_token`,
    { refresh_token: refreshToken },
    { apikey: SUPABASE.anonKey }
  );
  const parsed = JSON.parse(data);
  if (!parsed.access_token) {
    throw new Error(`刷新响应缺少 access_token: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || refreshToken,
  };
}

// ────────────────────────────────────────────────────────────
// Bark 告警
// ────────────────────────────────────────────────────────────

async function sendBarkAlert(barkKey, title, body) {
  if (!barkKey) {
    log.warn('Bark 未配置，跳过告警');
    return;
  }
  try {
    await fetch(`https://api.day.app/${barkKey}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`);
    log.info('Bark 告警已发送');
  } catch (e) {
    log.error('Bark 告警发送失败:', e.message);
  }
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

/**
 * 获取有效的 access_token
 */
export async function getAccessToken(env, prefix, userConfig = {}) {
  // ─── ① 内存 ───
  if (memoryTokens && isAccessValid(memoryTokens.access)) {
    return memoryTokens.access;
  }

  // ─── ② Redis（主数据源，工作流滚动的）───
  const stored = await readToken(env, prefix);
  if (stored.access && isAccessValid(stored.access)) {
    const exp = decodeJwtExpiry(stored.access);
    const remain = Math.round((exp - Date.now()) / 60000);
    log.info(`使用 Redis access_token（剩余 ${remain} 分钟）`);
    memoryTokens = { access: stored.access, refresh: stored.refresh, accessExp: exp };
    return stored.access;
  }

  // ─── ③ 用户配置 at（兜底），写回 Redis 但**只写 access，不写 refresh** ───
  if (userConfig.accessToken && isAccessValid(userConfig.accessToken)) {
    const exp = decodeJwtExpiry(userConfig.accessToken);
    log.info(`使用用户配置 access_token（写回 Redis，不写 refresh）`);
    memoryTokens = {
      access: userConfig.accessToken,
      refresh: stored.refresh,        // ← 保留 Redis 里的 refresh
      accessExp: exp,
    };
    if (upstashUrl(env)) {
      try {
        await redisPipeline(env, [
          ['SET', `${prefix}:token:access`, JSON.stringify(userConfig.accessToken), 'EX', 3600],
          // ⚠️ 不写 refresh：用户传的可能是旧快照，会污染工作流滚动的 R
        ]);
        log.info('用户配置 access_token 已写回 Redis');
      } catch (e) {
        log.warn('写回 Redis 失败:', e.message);
      }
    }
    return userConfig.accessToken;
  }

  // ─── ④ 用 refresh_token 刷新（优先 Redis 的）───
  const refreshToken = stored.refresh || userConfig.refreshToken;
  if (refreshToken) {
    try {
      const result = await refreshWithRefreshToken(refreshToken);
      await writeToken(env, prefix, result.accessToken, result.refreshToken);
      log.info('✅ refresh_token 刷新成功');
      return result.accessToken;
    } catch (e) {
      log.warn('refresh 失败:', e.message);
    }
  }

  // ─── ⑤ 用用户配置的 refresh_token 刷新（降级，与 ④ 不同才试）───
  const userRefresh = userConfig.refreshToken;
  if (userRefresh && userRefresh !== refreshToken) {
    try {
      const result = await refreshWithRefreshToken(userRefresh);
      await writeToken(env, prefix, result.accessToken, result.refreshToken);
      log.info('✅ 用户配置 refresh 刷新成功');
      return result.accessToken;
    } catch (e) {
      log.warn('用户配置 refresh 失败:', e.message);
    }
  }

  // ─── ⑥ Bark 告警 ───
  await sendBarkAlert(env.BARK_KEY, 'TryBox Token失效', `所有刷新失败: prefix=${prefix}`);
  return userConfig.accessToken || '';
}


/** 清除内存缓存（用于测试） */
export function clearTokenCache() {
  memoryTokens = null;
}
