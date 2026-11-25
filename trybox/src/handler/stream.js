/**
 * Stream Handler
 *
 * 输入 id 格式：
 *   - trybox_{tmdbId} 或 trybox_{tmdbId}:{season}:{episode}（站内）
 *   - tt{imdbId} 或 tt{imdbId}:{season}:{episode}（外部，如 Cinemeta）
 *
 * 缓存：
 *   - stream:{kind}:{tmdbId}（movie）
 *   - stream:tv:{tmdbId}:{S}:{E}（series）
 *
 * 失败处理（统一 failWithPending）：
 *   - 第一次失败 → pending (120s) + 返回诊断
 *   - 第二次失败 → 负缓存 (60s/300s) + 返回诊断
 *   - 命中负缓存 → 直接返回诊断
 *
 *   失败分类：
 *   - no_valid_url  上游 200 但 0 条有效链接    → 负缓存 300s
 *   - http_failed   请求超时 / 5xx / 网络异常   → 负缓存 60s
 *   - decode_failed 解码 / 结构异常             → 负缓存 60s
 *   - token_failed / no_token / invalid_id      → 不写 pending（全局问题，避免误伤）
 */

import { createLogger } from '../logger.js';
import { TRYBOX_URLS, TTL } from '../constants.js';
import { buildStreamPayload } from '../payload.js';
import { buildStreamHeaders } from '../headers.js';
import { decodeNode } from '../decode.js';
import { postText } from '../http.js';
import { getAccessToken } from '../token.js';
import { getCache, setCache, delCache } from '../cache.js';
import { parseAnyId } from '../tmdb.js';

const log = createLogger('Stream');

const QUALITY_ORDER = {
  '4K': 0, '2160P': 0,
  '1080P': 1,
  '720P': 2,
  '360P': 3,
  AUTO: 4,
  ORG: 5,
};

// 负缓存 TTL
const NEG_TTL_EMPTY = TTL.STREAM_NEG_REDIS; // 300s：上游明确返回 0 条
const NEG_TTL_FAILED = 60;                  // 60s：请求/解码失败，等上游恢复

/**
 * 判断链接是否含 IP 绑定（服务器出口 IP 硬编码，客户端无法播放）
 */
function hasIpCheck(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.searchParams.has('IP');
  } catch {
    return false;
  }
}

function buildCacheKey(kind, tmdbId, season, episode, config) {
  const flag = config.removeIdValidation !== false ? '1' : '0';
  if (kind === 'tv') return `stream:tv:${tmdbId}:${season}:${episode}:${flag}`;
  return `stream:movie:${tmdbId}:${flag}`;
}

function buildNegKey(kind, tmdbId, season, episode, config) {
  const flag = config.removeIdValidation !== false ? '1' : '0';
  if (kind === 'tv') return `stream:neg:tv:${tmdbId}:${season}:${episode}:${flag}`;
  return `stream:neg:movie:${tmdbId}:${flag}`;
}

/**
 * pending key：去掉 stream: 冗余前缀
 *   stream:movie:13:1 → pending:movie:13:1
 */
function buildPendingKey(cacheKey) {
  return `pending:${cacheKey.replace(/^stream:/, '')}`;
}

/**
 * 失败统一处理
 *
 * - pending 未命中：写 pending 120s，返回空流（不锁死）
 * - pending 命中：写负缓存 negTtl 秒 + 清 pending，返回空流
 *
 * 诊断信息不再通过 stream url 返回（见日志系统规范），改为写日志：
 * 常态 info 级记录原因，配置页 debug 打开时可看完整链路。
 */
async function failWithPending(env, cacheKey, negKey, reason, detail, negTtl, rawId) {
  const pendingKey = buildPendingKey(cacheKey);
  const pending = await getCache(env, pendingKey);

  if (pending) {
    await setCache(env, negKey, { detail, reason }, { redisTtl: negTtl });
    await delCache(env, pendingKey);
    log.info(`二次确认失败(${reason})，写入负缓存: ${negKey} ttl=${negTtl}s，rawId=${rawId}`);
  } else {
    await setCache(env, pendingKey, { ts: Date.now(), reason }, { redisTtl: 120 });
    log.info(`首次失败(${reason})，写入 pending: ${pendingKey}，rawId=${rawId}`);
  }
  log.debug(`[诊断] reason=${reason} detail=${detail} rawId=${rawId}`);

  return { streams: [] };
}

export async function streamHandler({ type, id, config, env }) {
  const parsed = await parseAnyId(env, id, type, config.tmdbKey);
  if (!parsed) {
    log.warn(`无法解析 id: ${id}`);
    return { streams: [] };
  }

  const { tmdbId, kind, season, episode } = parsed;
  const lang = config.lang || 'zh-CN';

  const baseId = id.split(':')[0];
  let epInfo = '';
  if (kind === 'tv' && season && episode) {
    epInfo = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} · `;
  }
  const displayName = `${epInfo}${baseId}`;

  const cacheKey = buildCacheKey(kind, tmdbId, season, episode, config);
  const negKey = buildNegKey(kind, tmdbId, season, episode, config);

  // ─── 1. 正缓存 ───
  const cached = await getCache(env, cacheKey, { l1Ttl: TTL.STREAM_L1 });
  if (cached) {
    log.info(`Stream 命中缓存: ${cacheKey}`);
    return { streams: cached };
  }

  // ─── 2. 负缓存 ───
  const neg = await getCache(env, negKey);
  if (neg) {
    const reason = neg.reason || 'cached_no_url';
    log.info(`Stream 命中负面缓存: ${negKey} (${reason})，rawId=${baseId}`);
    return { streams: [] };
  }
  
  // ─── 3. 获取 access_token ───
  // 注意：token 失败是全局问题，不写 pending / 负缓存
  let accessToken;
  try {
    accessToken = await getAccessToken(
      env,
      env.APP_PREFIX || 'tryboxStream:prod',
      config
    );
  } catch (e) {
    log.error('获取 access_token 失败:', e.message);
    return { streams: [] };
  }

  if (!accessToken) {
    log.error('access_token 为空，rawId=' + baseId);
    return { streams: [] };
  }

  const headers = buildStreamHeaders(accessToken, lang);
  const target = { tmdbId: Number(tmdbId), kind, season, episode };

  log.info(`请求 stream: ${kind} tmdb=${tmdbId}${season ? ` S${season}E${episode}` : ''}`);

  const payload = buildStreamPayload(target);
  const url = `${TRYBOX_URLS.stream}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

  // ─── 4. 请求上游（retryCount=0，失败交给 pending / 负缓存兜底）───
  let raw;
  try {
    raw = await postText(url, payload, headers, { retryCount: 0 });
  } catch (e) {
    log.error('stream 请求失败:', e.message);
    return failWithPending(env, cacheKey, negKey, 'http_failed', e.message, NEG_TTL_FAILED, baseId);
  }

  // ─── 5. 解码 ───
  let decoded;
  try {
    decoded = decodeNode(JSON.parse(raw));
  } catch (e) {
    log.error('stream 解码失败:', e.message);
    return failWithPending(env, cacheKey, negKey, 'decode_failed', e.message, NEG_TTL_FAILED, baseId);
  }

  const result = (decoded && decoded.result) || {};
  const allLinks = [
    ...(result.mbp_links || []),
    ...(result.links || []),
    ...(result.beta_links || []),
  ];

  // ─── 6. 过滤 IP 绑定 ───
  const removeIdValidation = config.removeIdValidation !== false;
  const validLinks = allLinks.filter((l) => {
    if (!l.url) return false;
    if (removeIdValidation && hasIpCheck(l.url)) return false;
    return true;
  });

  log.info(
    removeIdValidation
      ? `原始 ${allLinks.length} 条，剔除 IP 校验后 ${validLinks.length} 条（removeIdValidation=true）`
      : `原始 ${allLinks.length} 条，未做 IP 剔除（removeIdValidation=false）`
  );

  // ─── 7. 空结果（上游 200 但 0 条）───
  if (!validLinks.length) {
    const detail = removeIdValidation
      ? `原始 ${allLinks.length} 条，剔除 IP 校验后无可用链接`
      : `原始 ${allLinks.length} 条，无可用链接（未做 IP 剔除）`;
    return failWithPending(env, cacheKey, negKey, 'no_valid_url', detail, NEG_TTL_EMPTY, baseId);
  }

  // ─── 8. 成功 → 正缓存 + 清 pending ───
  await delCache(env, buildPendingKey(cacheKey));

  const streams = validLinks
    .map((l) => ({
      name: displayName, // ✨ 大字：S01E01 · tt1234567
      title: `[${l.quality || '?'}] ${l.group || 'TryBox'} · ${l.file_name || ''}`.trim(), 
      url: l.url,
      quality: l.quality,
      size: typeof l.size === 'number' ? `${(l.size / 1024 / 1024).toFixed(0)} MB` : l.size,
      _sortKey: QUALITY_ORDER[l.quality] ?? 99,
    }))
    .sort((a, b) => a._sortKey - b._sortKey)
    .map(({ _sortKey, ...rest }) => rest);

  await setCache(env, cacheKey, streams, {
    l1Ttl: TTL.STREAM_L1,
    redisTtl: TTL.STREAM_REDIS,
  });
  log.info(`写入缓存: ${cacheKey}（${streams.length} 条）`);

  return { streams };
}