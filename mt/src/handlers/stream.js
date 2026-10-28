/**
 * Stream 播放处理器
 * 
 * 所有诊断信息都包含：
 *   - 播放页 URL
 *   - 直链 URL（若已解析出）
 * 方便用户长按复制后手动排查
 */

import { getActiveHost, fetchHtml, isCdnReachable, USER_AGENT } from '../fetch.js';
import { parsePlayerUrl, parseDetail } from '../parser.js';

// ============================================================
// 诊断流工厂：所有诊断统一格式，含完整 URL
// ============================================================
function makeDiagnostic({ title, reason, playPageUrl, directUrl, extra }) {
    const lines = [`⚠️ ${title}`];
    if (playPageUrl) lines.push(`📄 播放页: ${playPageUrl}`);
    if (directUrl) lines.push(`🎬 直链: ${directUrl}`);
    if (extra) lines.push(`💡 ${extra}`);

    return {
        name: '麦田影院 · 诊断',
        title: lines.join('\n'),
        url: `mtyy|${reason}${directUrl ? '|' + encodeURIComponent(directUrl) : ''}`,
        behaviorHints: { notWebReady: true },
    };
}

// ============================================================
// 正常播放流
// ============================================================
function makePlayableStream({ url, host, label }) {
    return {
        name: `麦田影院 · ${label}`,
        title: label,
        url,
        behaviorHints: { notWebReady: true },
        proxyHeaders: {
            request: {
                'Referer': host + '/',
                'User-Agent': USER_AGENT,
            },
        },
    };
}

// ============================================================
// 主入口
// ============================================================
export async function streamHandler({ id, type }) {
    // ============================================================
    // 1. 解析 ID
    // ============================================================
    const m = id.match(/^mtyy_(\d+):(\d+):(\d+)$/);
    if (!m) {
        return {
            streams: [makeDiagnostic({
                title: 'ID 格式错误',
                reason: 'invalid_id',
                extra: `期望: mtyy_{vid}:{sid}:{nid}，实际: ${id}`,
            })],
        };
    }
    const [, vid, sid, nid] = m;

    // ============================================================
    // 2. 请求播放页
    // ============================================================
    let host;
    try {
        host = await getActiveHost();
    } catch (e) {
        return {
            streams: [makeDiagnostic({
                title: '所有麦田域名均不可达',
                reason: 'host_unreachable',
                extra: e.message,
            })],
        };
    }

    const playPageUrl = `${host}/vodplay/${vid}-${sid}-${nid}.html`;
    const html = await fetchHtml(playPageUrl);

    if (!html) {
        return {
            streams: [makeDiagnostic({
                title: '播放页请求失败',
                reason: 'playpage_fetch_failed',
                playPageUrl,
            })],
        };
    }

    // ============================================================
    // 3. 解析播放页
    // ============================================================
    const result = parsePlayerUrl(html);

    // --- 3a. NBY 加密 ---
    if (result && typeof result === 'object' && result.type === 'nby') {
        return {
            streams: [makeDiagnostic({
                title: 'NB源加密线路，暂不支持',
                reason: 'nby_encrypted',
                playPageUrl,
                extra: `加密串前 40 字符: ${result.raw.substring(0, 40)}...\n建议换用其他线路（BF/LZ/TT/FF）`,
            })],
        };
    }

    // --- 3b. 完全解析失败 ---
    if (!result || typeof result !== 'string') {
        const hasPlayerData = html.includes('player_data');
        const hasM3u8 = html.includes('.m3u8');
        return {
            streams: [makeDiagnostic({
                title: '无法提取播放链接',
                reason: 'parse_failed',
                playPageUrl,
                extra: `页面诊断: player_data=${hasPlayerData}, m3u8=${hasM3u8}\n可能是新加密格式或页面结构变更`,
            })],
        };
    }

    // --- 3c. 成功获取直链 ---
    const directUrl = result;

    // ============================================================
    // 4. CDN 可达性探测
    // ============================================================
    const cdnOk = await isCdnReachable(directUrl);

    if (cdnOk) {
        return {
            streams: [makePlayableStream({
                url: directUrl,
                host,
                label: `${vid} · S${sid}E${nid}`,
            })],
        };
    }

    // ============================================================
    // 5. CDN 不可达 → 尝试其他线路
    // ============================================================
    const detailHtml = await fetchHtml(`${host}/voddetail/${vid}.html`);
    let alternatives = [];
    if (detailHtml) {
        const detail = parseDetail(detailHtml, vid);
        alternatives = detail.lines.filter(line => !line.encrypted && line.sid !== sid);
    }

    for (const line of alternatives) {
        // 优先同集数，否则第一集
        const ep = line.episodes.find(e => e.nid === nid) || line.episodes[0];
        const altPlayUrl = `${host}/vodplay/${vid}-${ep.sid}-${ep.nid}.html`;
        const altHtml = await fetchHtml(altPlayUrl);
        if (!altHtml) continue;

        const altResult = parsePlayerUrl(altHtml);
        if (!altResult || typeof altResult !== 'string') continue;

        const altOk = await isCdnReachable(altResult);
        if (altOk) {
            return {
                streams: [makePlayableStream({
                    url: altResult,
                    host,
                    label: `${line.name}（备用线路）`,
                })],
            };
        }
    }

    // ============================================================
    // 6. 全部失败 → 返回诊断 + 真实直链（供用户手动测试）
    // ============================================================
    return {
        streams: [
            // 第一项：诊断（含完整 URL，供排查）
            makeDiagnostic({
                title: 'CDN 不可达（可能是网络封锁）',
                reason: 'cdn_unreachable',
                playPageUrl,
                directUrl,
                extra: `已尝试 ${alternatives.length} 条备用线路，均不可达\n可长按复制直链，在支持自定义 Referer 的播放器中测试`,
            }),
            // 第二项：真实直链（仍然给用户，网络环境好时可能能播）
            {
                name: '麦田影院 · 强制播放',
                title: `网络受限，若你能访问此 CDN 可直接播放\n${directUrl}`,
                url: directUrl,
                behaviorHints: { notWebReady: true },
                proxyHeaders: {
                    request: {
                        'Referer': host + '/',
                        'User-Agent': USER_AGENT,
                    },
                },
            },
        ],
    };
}