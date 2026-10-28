/**
 * Stream 播放处理器
 */

import { getActiveHost, fetchHtml, isCdnReachable, USER_AGENT } from '../fetch.js';
import { parsePlayerUrl, parseDetail } from '../parser.js';
import { withCache, negGet, negSet, TTL } from '../cache.js';
import { resolveImdbToMtyy } from '../resolver.js';

// ============================================================
// 流构造工具
// ============================================================
function makePlayableStream({ url, host, label, sid, displayName, quality, epTitle }) {
    // 小字：比如 "主线路 · 02 · 1080P"
    const titleParts = [];
    if (label) titleParts.push(label);
    if (epTitle) titleParts.push(epTitle);
    if (quality) titleParts.push(quality);
    
    const title = titleParts.join(' · ') || '播放';

    return {
        name: displayName,              // 大字：流人 | S01E02
        title: title,                   // 小字：主线路 · 02 · 1080P
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
        externalUrl: directUrl || playPageUrl || 'https://mtyy5.com/',
    };
}

// ============================================================
// 主入口
// ============================================================
export async function streamHandler({ id, type, config = {} }) {
    let vid, sid, nid;
    
    if (id.startsWith('tt')) {
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
        const m = id.match(/^mtyy_(\d+)(?::(\d+):(\d+))?$/);
        if (!m) {
            return {
                streams: [makeDiagnostic({
                    title: 'ID 格式错误',
                    extra: `期望: mtyy_{vid} 或 mtyy_{vid}:{sid}:{nid} 或 tt{imdbId}\n实际: ${id}`,
                })],
                cacheMaxAge: 60,
                _fromCache: false,
            };
        }
        vid = m[1];
        sid = m[2] || '1';
        nid = m[3] || '1';
    }

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

    const lineBlacklist = (config.lineBlacklist || []).map(String);
    const hideEncrypted = config.hideEncrypted !== false;

    // 获取完整详情
    const detail = await getFullDetail(host, vid);
    
    // 默认值
    let movieName = detail?.name || '麦田影院';
    let episodeNum = 1;
    let seasonNum = 1;
    let mainEpTitle = '正片';

    // 计算正确的季集标识和当前集标题
    if (detail) {
        if (type === 'series') {
            // 寻找主线路里当前 nid 在数组中的位置，作为集数
            const mainLine = detail.lines.find(l => l.sid === sid);
            if (mainLine) {
                const idx = mainLine.episodes.findIndex(e => e.nid === nid);
                if (idx !== -1) {
                    episodeNum = idx + 1;
                    mainEpTitle = mainLine.episodes[idx].title;
                }
            }
        } else {
            // 电影没有集数
            mainEpTitle = '正片';
        }
    }

    // 格式化集数 S01E02
    const epStr = String(episodeNum).padStart(2, '0');
    const seriesTag = type === 'series' ? ` | S${String(seasonNum).padStart(2, '0')}E${epStr}` : '';
    const displayName = `${movieName}${seriesTag}`;

    const targetLines = [];
    // 主线路
    targetLines.push({ name: '主线路', sid, nid, encrypted: false, epTitle: mainEpTitle });

    // 其他备用线路
    if (detail) {
        for (const line of detail.lines) {
            if (line.sid === sid) continue;
            if (hideEncrypted && line.encrypted) continue;
            if (lineBlacklist.includes(line.sid)) continue;
            
            const ep = line.episodes.find(e => e.nid === nid);
            if (ep) {
                targetLines.push({ name: line.name, sid: line.sid, nid: ep.nid, encrypted: line.encrypted, epTitle: ep.title });
            }
        }
    }

    // 并发获取直链
    const fetchPromises = targetLines.map(async (line) => {
        if (line.encrypted && !hideEncrypted) {
            return { status: 'encrypted', line };
        }
        
        const res = await fetchStreamForEpisode(host, vid, line.sid, line.nid);
        if (!res.ok) return { status: 'failed', line, reason: res.reason };
        
        const cdnOk = await isCdnReachable(res.url);
        
        return { status: 'ok', line, url: res.url, quality: res.quality, cdnOk };
    });

    const results = await Promise.allSettled(fetchPromises);
    const validStreams = [];
    let firstDirectUrl = null;
    let firstPlayPageUrl = `${host}/vodplay/${vid}-${sid}-${nid}.html`;

    for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const data = r.value;

        if (data.status === 'ok') {
            if (!firstDirectUrl) firstDirectUrl = data.url;
            
            validStreams.push(makePlayableStream({
                url: data.url,
                host,
                label: data.line.name,
                sid: data.line.sid,
                displayName: displayName,
                quality: data.quality,
                epTitle: data.line.epTitle
            }));
        } else if (data.status === 'encrypted') {
            if (!hideEncrypted) {
                validStreams.push(makeDiagnostic({
                    title: `${data.line.name} 加密线路`,
                    playPageUrl: `${host}/vodplay/${vid}-${data.line.sid}-${data.line.nid}.html`,
                    extra: '该线路需要专用播放器解密，无法直接播放'
                }));
            }
        }
    }

    // 去重
    const uniqueStreams = Array.from(
        new Map(validStreams.map(s => [s.url || s.externalUrl, s])).values()
    );

    if (uniqueStreams.length > 0) {
        uniqueStreams.sort((a, b) => {
            const aIsDiag = a.externalUrl ? 1 : 0;
            const bIsDiag = b.externalUrl ? 1 : 0;
            return aIsDiag - bIsDiag;
        });

        return {
            streams: uniqueStreams,
            cacheMaxAge: TTL.STREAM,
            _fromCache: false, 
        };
    }

    // 全部失败 -> 诊断
    const finalStreams = [];
    if (firstDirectUrl) {
        finalStreams.push(makePlayableStream({
            url: firstDirectUrl,
            host,
            label: '强制尝试',
            sid: sid,
            displayName: displayName,
            quality: '',
            epTitle: mainEpTitle
        }));
    }

    finalStreams.push(makeDiagnostic({
        title: '所有线路均不可达或解析失败',
        playPageUrl: firstPlayPageUrl,
        directUrl: firstDirectUrl,
        extra: `已尝试 ${targetLines.length} 条线路\n💡 点击此卡片会唤起浏览器，可在地址栏复制直链`,
    }));

    return {
        streams: finalStreams,
        cacheMaxAge: TTL.NEG_CDN,
        _fromCache: false,
    };
}

// ============================================================
// 辅助：获取某集直链
// ============================================================
async function fetchStreamForEpisode(host, vid, sid, nid) {
    const nbyKey = `stream:nby:${vid}:${sid}:${nid}`;
    if (await negGet(nbyKey)) return { ok: false, reason: 'nby' };

    const failKey = `stream:parse_failed:${vid}:${sid}:${nid}`;
    if (await negGet(failKey)) return { ok: false, reason: 'parse_failed' };

    const cacheKey = `stream:${vid}:${sid}:${nid}`;
    const { value: cached } = await withCache(cacheKey, TTL.STREAM, async () => {
        const playUrl = `${host}/vodplay/${vid}-${sid}-${nid}.html`;
        const html = await fetchHtml(playUrl);
        if (!html) {
            await negSet(failKey, TTL.NEG_PARSE);
            return null;
        }

        const result = parsePlayerUrl(html);

        if (result && result.type === 'nby') {
            await negSet(nbyKey, TTL.NEG_PARSE);
            return null;
        }

        if (!result || !result.url) {
            await negSet(failKey, TTL.NEG_PARSE);
            return null;
        }

        return result; // { url, quality }
    });

    if (!cached) {
        if (await negGet(nbyKey)) return { ok: false, reason: 'nby' };
        return { ok: false, reason: 'parse_failed' };
    }
    return { ok: true, url: cached.url, quality: cached.quality };
}

// ============================================================
// 辅助：获取完整详情
// ============================================================
async function getFullDetail(host, vid) {
    const { value: detail } = await withCache(`meta:${vid}`, TTL.META, async () => {
        const html = await fetchHtml(`${host}/voddetail/${vid}.html`);
        if (!html) return null;
        return parseDetail(html, vid);
    });
    return detail;
}