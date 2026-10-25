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
 *   - 空结果 → negative cache: stream:neg:*（300s）
 */

import { createLogger } from '../logger.js';
import { TRYBOX_URLS, TTL } from '../constants.js';
import { buildStreamPayload } from '../payload.js';
import { buildStreamHeaders } from '../headers.js';
import { decodeNode } from '../decode.js';
import { postText } from '../http.js';
import { getAccessToken } from '../token.js';
import { getCache, setCache } from '../cache.js';
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

export async function streamHandler({ type, id, config, env }) {
  const parsed = await parseAnyId(env, id, type, config.tmdbKey);
  if (!parsed) {
    log.warn(`无法解析 id: ${id}`);
    return { streams: [buildDiagnostic('invalid_id', `无法解析 id: ${id}`)] };
  }

  const { tmdbId, kind, season, episode } = parsed;
  const lang = config.lang || 'zh-CN';

  const cacheKey = buildCacheKey(kind, tmdbId, season, episode, config);
  const negKey = buildNegKey(kind, tmdbId, season, episode, config);

  // 1. 命中 positive cache
  const cached = await getCache(env, cacheKey, { l1Ttl: TTL.STREAM_L1 });
  if (cached) {
    log.info(`Stream 命中缓存: ${cacheKey}`);
    return { streams: cached };
  }

  // 2. 命中 negative cache
  const neg = await getCache(env, negKey);
  if (neg) {
    log.info(`Stream 命中负面缓存: ${negKey}`);
    return { streams: [buildDiagnostic('cached_no_url', neg.detail || '近期无可用链接')] };
  }

  // 3. 回源
  let accessToken;
  try {
    accessToken = await getAccessToken(
      env,
      env.APP_PREFIX || 'tryboxStream:prod',
      config
    );
  } catch (e) {
    log.error('获取 access_token 失败:', e.message);
    return { streams: [buildDiagnostic('token_failed', e.message)] };
  }

  if (!accessToken) {
    return { streams: [buildDiagnostic('no_token', 'access_token 为空')] };
  }

  const headers = buildStreamHeaders(accessToken, lang);
  const target = {
    tmdbId: Number(tmdbId),
    kind,
    season,
    episode,
  };

  log.info(`请求 stream: ${kind} tmdb=${tmdbId}${season ? ` S${season}E${episode}` : ''}`);

  const payload = buildStreamPayload(target);
  const url = `${TRYBOX_URLS.stream}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

  let raw;
  try {
    raw = await postText(url, payload, headers);
  } catch (e) {
    log.error('stream 请求失败:', e.message);
    return { streams: [buildDiagnostic('http_failed', e.message)] };
  }

  let decoded;
  try {
    decoded = decodeNode(JSON.parse(raw));
  } catch (e) {
    log.error('stream 解码失败:', e.message);
    return { streams: [buildDiagnostic('decode_failed', e.message)] };
  }

  const result = decoded.result || {};
  const allLinks = [
    ...(result.mbp_links || []),
    ...(result.links || []),
    ...(result.beta_links || []),
  ];

  // 4. 过滤：按配置剔除 IP 绑定 URL
  const removeIdValidation = config.removeIdValidation !== false;
  const validLinks = allLinks.filter((l) => {
    if (!l.url) return false;
    if (removeIdValidation && hasIpCheck(l.url)) return false;
    return true;
  });

  log.info(
    `原始 ${allLinks.length} 条，剔除 IP 校验后 ${validLinks.length} 条` +
    `（removeIdValidation=${removeIdValidation}）`
  );

  // 5. 空结果 → negative cache
  if (!validLinks.length) {
    const detail = `原始 ${allLinks.length} 条，剔除 IP 校验后无可用链接`;
    await setCache(env, negKey, { detail }, { redisTtl: TTL.STREAM_NEG_REDIS });
    log.info(`写入负面缓存: ${negKey}`);
    return { streams: [buildDiagnostic('no_valid_url', detail)] };
  }

  // 6. 成功 → positive cache
  const streams = validLinks
    .map((l) => ({
      name: `TryBox · ${l.group || 'Unknown'}`,
      title: `${l.quality || 'Unknown'} · ${l.file_name || ''}`.trim(),
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

function buildDiagnostic(reason, detail) {
  return {
    name: 'TryBox · 诊断',
    url: `trybox|${reason}|${detail}`,
  };
}