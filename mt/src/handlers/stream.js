/**
 * Stream 播放处理器
 * 
 * 支持两种 ID 格式：
 *   - mtyy_{vid}:{sid}:{nid} → 直接查
 *   - tt{imdbId}[:s:e] → 通过 resolver 转换为 vid
 */

import { getActiveHost, fetchHtml, isCdnReachable, USER_AGENT } from '../fetch.js';
import { parsePlayerUrl, parseDetail } from '../parser.js';
import { withCache, negGet, negSet, TTL } from '../cache.js';
import { resolveImdbToMtyy } from '../resolver.js';

// ============================================================
// 流构造工具
// ============================================================
function makePlayableStream({ url, host, label, sid }) {
    return {
        name: `麦田影院 · ${label}`,
        title: label,
        url,
        behaviorHints: {
            notWebReady: true,
            bingeGroup: `mtyy-${sid}`,
        },
        proxyHeaders: {
            request: {
                'Referer': host + '/',
                'User-Agent': USER_AGENT,
            },
        },
    };
}

function makeDiagnostic({ title, playPageUrl, directUrl, extra }) {
    const lines = [`⚠️ ${title}`];
    if (playPageUrl) lines.push(`📄 播放页: ${playPageUrl}`);
    if (directUrl) lines.push(`🎬 直链: ${directUrl}`);
    if (extra) lines.push(`💡 ${extra}`);

    return {
        name: '麦田影院 · 诊断',
        title: lines.join('\n'),
        externalUrl: playPageUrl || 'https://mtyy5.com/',
    };
}

// ============================================================
// 主入口
// ============================================================
export async function streamHandler({ id, type }) {
    // ─── 1. 统一 ID 解析 ───
    let vid, sid, nid;
    
    if (id.startsWith('tt')) {
        // tt 格式：tt0109830 或 tt0944947:1:1
        const parts = id.split(':');
        const ttId = parts[0];
        const season = parts[1] ? parseInt(parts[1], 10) : undefined;
        const episode = parts[2] ? parseInt(parts[2], 10) : undefined;

        const resolved = await resolveImdbToMtyy(ttId, type, season, episode);
        if (!resolved) {
            return {
                streams: [makeDiagnostic({
                    title: '无法解析 tt ID 到麦田站',
                    extra: `tt: ${ttId}\n可能是麦田站未收录此片，或 TMDB 查询失败`,
                })],
                cacheMaxAge: 60,
                _fromCache: false,
            };
        }
        vid = resolved.vid;
        sid = resolved.sid;
        nid = resolved.nid;
    } else {
        const m = id.match(/^mtyy_(\d+):(\d+):(\d+)$/);
        if (!m) {
            return {
                streams: [makeDiagnostic({
                    title: 'ID 格式错误',
                    extra: `期望: mtyy_{vid}:{sid}:{nid} 或 tt{imdbId}[:s:e]\n实际: ${id}`,
                })],
                cacheMaxAge: 60,
                _fromCache: false,
            };
        }
        vid = m[1];
        sid = m[2];
        nid = m[3];
    }

    // ─── 2. 获取主域名 ───
    let host;
    try {
        host = await getActiveHost();
    } catch (e) {
        return {
            streams: [makeDiagnostic({
                title: '所有麦田域名均不可达',
                extra: e.message,
            })],
            cacheMaxAge: 60,
            _fromCache: false,
        };
    }

    // ─── 3. 尝试主线路 ───
    const playPageUrl = `${host}/vodplay/${vid}-${sid}-${nid}.html`;
    const primary = await fetchStreamForEpisode(host, vid, sid, nid);

    if (primary.ok) {
        const cdnOk = await isCdnReachable(primary.url);
        if (cdnOk) {
            return {
                streams: [makePlayableStream({
                    url: primary.url,
                    host,
                    label: `线路 ${sid} · 第 ${nid} 集`,
                    sid,
                })],
                cacheMaxAge: TTL.STREAM,
                _fromCache: primary.fromCache || false,
            };
        }
    }

    // ─── 4. 降级：尝试其他非加密线路 ───
    const alternatives = await getAlternatives(host, vid, sid);
    let matchedCount = 0;
    for (const line of alternatives) {
        const ep = line.episodes.find(e => e.nid === nid);
        if (!ep) continue;
        matchedCount++;

        const alt = await fetchStreamForEpisode(host, vid, ep.sid, ep.nid);
        if (!alt.ok) continue;

        const altCdnOk = await isCdnReachable(alt.url);
        if (altCdnOk) {
            return {
                streams: [makePlayableStream({
                    url: alt.url,
                    host,
                    label: `${line.name}（备用）· ${ep.title}`,
                    sid: ep.sid,
                })],
                cacheMaxAge: TTL.STREAM,
                _fromCache: alt.fromCache || false,
            };
        }
    }

    // ─── 5. 全部失败 → 诊断 ───
    let reasonText = '无法提取播放链接';
    if (primary.reason === 'nby') reasonText = 'NB源加密线路，暂不支持';
    else if (primary.reason === 'parse_failed') reasonText = '播放页解析失败';
    else if (primary.reason === 'fetch_failed') reasonText = '播放页请求失败';
    else if (primary.ok) reasonText = 'CDN 不可达（可能是网络封锁）';

    return {
        streams: [makeDiagnostic({
            title: reasonText,
            playPageUrl,
            directUrl: primary.url,
            extra: `已尝试 ${matchedCount} 条匹配线路，均失败\n可长按复制直链测试`,
        })],
        cacheMaxAge: TTL.NEG_CDN,
        _fromCache: false,
    };
}

// ============================================================
// 辅助：获取某集直链（带缓存 + 负缓存）
// ============================================================
async function fetchStreamForEpisode(host, vid, sid, nid) {
    const nbyKey = `stream:nby:${vid}:${sid}:${nid}`;
    if (await negGet(nbyKey)) return { ok: false, reason: 'nby' };

    const failKey = `stream:parse_failed:${vid}:${sid}:${nid}`;
    if (await negGet(failKey)) return { ok: false, reason: 'parse_failed' };

    const cacheKey = `stream:${vid}:${sid}:${nid}`;
    const { value: cached, fromCache } = await withCache(cacheKey, TTL.STREAM, async () => {
        const playUrl = `${host}/vodplay/${vid}-${sid}-${nid}.html`;
        const html = await fetchHtml(playUrl);
        if (!html) {
            await negSet(failKey, TTL.NEG_PARSE);
            return null;
        }

        const result = parsePlayerUrl(html);

        if (result && typeof result === 'object' && result.type === 'nby') {
            await negSet(nbyKey, TTL.NEG_PARSE);
            return null;
        }

        if (!result || typeof result !== 'string') {
            await negSet(failKey, TTL.NEG_PARSE);
            return null;
        }

        return result;
    });

    if (!cached) return { ok: false, reason: 'parse_failed' };
    return { ok: true, url: cached, fromCache };
}

// ============================================================
// 辅助：获取备用线路（复用 meta 缓存）
// ============================================================
async function getAlternatives(host, vid, currentSid) {
    const { value: detail } = await withCache(`meta:${vid}`, TTL.META, async () => {
        const html = await fetchHtml(`${host}/voddetail/${vid}.html`);
        if (!html) return null;
        return parseDetail(html, vid);
    });

    if (!detail) return [];
    return detail.lines.filter(l => !l.encrypted && l.sid !== currentSid);
}