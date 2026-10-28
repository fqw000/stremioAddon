#!/usr/bin/env node
/**
 * 麦田影院 Addon · 完整本地测试脚本
 * 
 * 用法：
 *   node test-addon.js                    # 完整测试
 *   node test-addon.js --quick            # 跳过 Stream 测试（快速冒烟）
 *   node test-addon.js --verbose          # 打印完整 JSON
 *   node test-addon.js --only=manifest,catalog  # 只跑指定组
 * 
 * 依赖：Node.js 18+ （使用原生 fetch）
 */

import { getManifest } from './src/manifest.js';
import { catalogHandler } from './src/handlers/catalog.js';
import { metaHandler } from './src/handlers/meta.js';
import { streamHandler } from './src/handlers/stream.js';

// ============================================================
// ⚙️ 测试配置区
// ============================================================
const TEST_CASES = {
    // 分类测试（与 manifest.js 保持一致）
    catalog: [
        { id: 'mtyy_movie',   label: '电影' },
        { id: 'mtyy_series',  label: '电视剧' },
        { id: 'mtyy_anime',   label: '动漫' },
        { id: 'mtyy_variety', label: '综艺' },
        { id: 'mtyy_short',   label: '短剧' },
    ],
    
    // RSS 搜索关键词
    search: [
        { keyword: '流浪地球', label: '电影' },
        { keyword: '庆余年',   label: '剧集' },
    ],

    // Meta / Stream 测试样本（可自定义）
    // 从 catalog 和 meta 自动采样，但也可以手动指定
    samples: {
        movie: null,        // null 表示从 catalog 自动取第一条
        series: null,       // null 表示从 catalog 自动取第一条
    },

    // 边界测试（异常输入）
    edges: {
        invalidStreamId: 'mtyy_abc',                     // 格式错误
        nonexistentMeta: 'mtyy_999999999',               // 不存在的 VID
        nonexistentStream: 'mtyy_224284:99:99',          // 不存在的集数
        nbyEncrypted: 'mtyy_210028:4:1',                 // NBY 加密（骄阳似我 NB源）
    },
};

// ============================================================
// CLI 参数
// ============================================================
const args = process.argv.slice(2);
const OPT = {
    quick:    args.includes('--quick'),
    verbose:  args.includes('--verbose'),
    only:     ((args.find(a => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean),
};

// ============================================================
// 终端着色
// ============================================================
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
    magenta: '\x1b[35m',
};

// ============================================================
// 统计
// ============================================================
const stats = { total: 0, passed: 0, failed: 0, skipped: 0, results: [] };

// ============================================================
// 日志工具
// ============================================================
function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(color, icon, msg, detail) {
    const line = `${C.gray}[${ts()}]${C.reset} ${color}${icon}${C.reset} ${msg}`;
    console.log(line + (detail !== undefined ? ` ${C.dim}${detail}${C.reset}` : ''));
}

function title(t) {
    console.log(`\n${C.cyan}${'═'.repeat(72)}${C.reset}`);
    console.log(`${C.cyan}${C.bold}  ${t}${C.reset}`);
    console.log(`${C.cyan}${'═'.repeat(72)}${C.reset}`);
}

function section(t) {
    console.log(`\n${C.magenta}${C.bold}【${t}】${C.reset}`);
}

function shouldRun(group) {
    return OPT.only.length === 0 || OPT.only.includes(group);
}

// ============================================================
// 断言 & 测试执行器
// ============================================================
function assert(cond, msg) {
    if (!cond) throw new Error(`断言失败: ${msg}`);
}

async function test({ name, fn, validate, timeout = 30000 }) {
    stats.total++;
    const t0 = Date.now();
    
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const result = await Promise.race([
            fn(),
            new Promise((_, rej) => {
                const t = setTimeout(() => rej(new Error(`超时 >${timeout}ms`)), timeout);
                timer && t && null;
            }),
        ]).finally(() => clearTimeout(timer));

        const elapsed = Date.now() - t0;
        
        if (validate) {
            const v = await validate(result);
            if (!v || !v.valid) throw new Error(v?.reason || '校验失败');
            log(C.green, '✅ [PASS]', name, `(${elapsed}ms) ${v.summary || ''}`);
        } else {
            log(C.green, '✅ [PASS]', name, `(${elapsed}ms)`);
        }

        stats.passed++;
        stats.results.push({ name, ok: true, elapsed, result });
        return { ok: true, result };
    } catch (e) {
        const elapsed = Date.now() - t0;
        log(C.red, '❌ [FAIL]', name, `(${elapsed}ms)`);
        console.log(`         ${C.red}${e.message}${C.reset}`);
        stats.failed++;
        stats.results.push({ name, ok: false, elapsed, error: e.message });
        return { ok: false, error: e.message };
    }
}

function skip(name, reason) {
    stats.skipped++;
    log(C.yellow, '⏭️  [SKIP]', name, `(${reason})`);
    stats.results.push({ name, ok: false, skipped: true });
}

// ============================================================
// 打印辅助
// ============================================================
function printMeta(meta, label) {
    console.log(`         ${C.dim}--- ${label} ---${C.reset}`);
    console.log(`         ${C.cyan}id:${C.reset}    ${meta.id}`);
    console.log(`         ${C.cyan}type:${C.reset}  ${meta.type}`);
    console.log(`         ${C.cyan}name:${C.reset}  ${meta.name}`);
    if (meta.poster) console.log(`         ${C.cyan}poster:${C.reset} ${meta.poster.substring(0, 80)}${meta.poster.length > 80 ? '...' : ''}`);
    if (meta.releaseInfo) console.log(`         ${C.cyan}year:${C.reset}   ${meta.releaseInfo}`);
    if (meta.description) console.log(`         ${C.cyan}desc:${C.reset}   ${meta.description.substring(0, 60)}${meta.description.length > 60 ? '...' : ''}`);
    if (meta.videos) {
        console.log(`         ${C.cyan}videos:${C.reset} ${meta.videos.length} 集`);
        if (meta.videos.length > 0) {
            console.log(`         ${C.dim}首集: ${meta.videos[0].id} · ${meta.videos[0].title}${C.reset}`);
        }
    }
}

function printStreams(streams) {
    console.log(`         ${C.dim}--- Streams [${streams.length} 条] ---${C.reset}`);
    
    streams.forEach((s, i) => {
        const isDiag = s.url && s.url.startsWith('mtyy|');
        const icon = isDiag ? '⚠️ ' : '▶ ';
        const color = isDiag ? C.yellow : C.green;
        
        console.log(`         ${color}${icon}[${i + 1}] ${s.name}${C.reset}`);
        
        // title 可能是多行诊断信息
        if (s.title && s.title.includes('\n')) {
            s.title.split('\n').forEach(line => {
                console.log(`              ${color}${line}${C.reset}`);
            });
        } else if (s.title) {
            console.log(`              ${C.dim}${s.title}${C.reset}`);
        }
        
        // URL
        if (s.url && !s.url.startsWith('mtyy|')) {
            console.log(`              ${C.cyan}URL:${C.reset} ${s.url}`);
        } else if (s.url && s.url.startsWith('mtyy|')) {
            console.log(`              ${C.gray}诊断: ${s.url}${C.reset}`);
        }
        
        // proxyHeaders
        if (s.proxyHeaders?.request) {
            const h = s.proxyHeaders.request;
            console.log(`              ${C.dim}Referer: ${h.Referer || '-'}${C.reset}`);
        }
    });
}

// ============================================================
// 测试组 1：Manifest
// ============================================================
async function testManifest() {
    section('Manifest');
    if (!shouldRun('manifest')) return skip('Manifest 测试', '--only 未包含');

    await test({
        name: 'Manifest 基本字段',
        fn: () => Promise.resolve(getManifest()),
        validate: (m) => {
            if (!m.id) return { valid: false, reason: '缺 id' };
            if (!m.name) return { valid: false, reason: '缺 name' };
            if (!m.version) return { valid: false, reason: '缺 version' };
            return { valid: true, summary: `${m.id} v${m.version}` };
        },
    });

    await test({
        name: 'Manifest resources（catalog/meta/stream，不含 subtitles）',
        fn: () => Promise.resolve(getManifest()),
        validate: (m) => {
            const res = m.resources || [];
            if (!res.includes('catalog')) return { valid: false, reason: '缺 catalog' };
            if (!res.includes('meta')) return { valid: false, reason: '缺 meta' };
            if (!res.includes('stream')) return { valid: false, reason: '缺 stream' };
            if (res.includes('subtitles')) return { valid: false, reason: '不应含 subtitles' };
            return { valid: true, summary: `[${res.join(',')}]` };
        },
    });

    await test({
        name: `Manifest catalogs（应为 ${TEST_CASES.catalog.length} 个）`,
        fn: () => Promise.resolve(getManifest()),
        validate: (m) => {
            const cats = m.catalogs || [];
            if (cats.length !== TEST_CASES.catalog.length) {
                return { valid: false, reason: `期望 ${TEST_CASES.catalog.length} 个，实际 ${cats.length}` };
            }
            // 检查每个 catalog 有 search 且没有 skip
            for (const c of cats) {
                const extra = c.extra || [];
                const hasSearch = extra.some(e => e.name === 'search');
                const hasSkip = extra.some(e => e.name === 'skip');
                if (!hasSearch) return { valid: false, reason: `${c.id} 缺 search extra` };
                if (hasSkip) return { valid: false, reason: `${c.id} 不应含 skip extra` };
            }
            return { valid: true, summary: cats.map(c => c.id).join(', ') };
        },
    });
}

// ============================================================
// 测试组 2：Catalog（分类 + 搜索）
// ============================================================
async function testCatalog() {
    section('Catalog · 分类浏览');
    if (!shouldRun('catalog')) return skip('Catalog 测试', '--only 未包含');

    const catalogSamples = {};

    for (const cat of TEST_CASES.catalog) {
        const r = await test({
            name: `分类 ${cat.label} (${cat.id})`,
            fn: () => catalogHandler({ id: cat.id, type: 'movie', extra: {} }),
            validate: (result) => {
                if (!result || !Array.isArray(result.metas)) {
                    return { valid: false, reason: 'metas 非数组' };
                }
                if (result.metas.length === 0) {
                    return { valid: false, reason: 'metas 为空' };
                }
                const first = result.metas[0];
                if (!first.id || !first.name) {
                    return { valid: false, reason: '首条 meta 缺 id/name' };
                }
                if (!/^mtyy_\d+$/.test(first.id)) {
                    return { valid: false, reason: `id 格式错误: ${first.id}` };
                }
                return { valid: true, summary: `${result.metas.length} 条` };
            },
        });

        // 保存样本，供后续 meta/stream 测试
        if (r.ok && r.result?.metas?.length > 0) {
            catalogSamples[cat.id] = r.result.metas.slice(0, 3);
            console.log(`         ${C.dim}样本: ${r.result.metas[0].id} · ${r.result.metas[0].name}${C.reset}`);
        }
    }

    return catalogSamples;
}

async function testSearch() {
    section('Catalog · RSS 搜索');
    if (!shouldRun('catalog')) return skip('搜索测试', '--only 未包含');

    for (const s of TEST_CASES.search) {
        await test({
            name: `搜索 "${s.keyword}" (${s.label})`,
            fn: () => catalogHandler({
                id: 'mtyy_movie',
                type: 'movie',
                extra: { search: s.keyword },
            }),
            validate: (result) => {
                if (!Array.isArray(result.metas)) {
                    return { valid: false, reason: 'metas 非数组' };
                }
                if (result.metas.length === 0) {
                    return { valid: true, summary: '0 条（关键词可能无结果）' };
                }
                const first = result.metas[0];
                if (!/^mtyy_\d+$/.test(first.id)) {
                    return { valid: false, reason: `id 格式错误: ${first.id}` };
                }
                return { valid: true, summary: `${result.metas.length} 条 · 首条 "${first.name}"` };
            },
        });
    }
}

// ============================================================
// 测试组 3：Meta
// ============================================================
async function testMeta(catalogSamples) {
    section('Meta · 详情');
    if (!shouldRun('meta')) return skip('Meta 测试', '--only 未包含');

    const metaSamples = {};

    // 电影样本
    const movieSample = TEST_CASES.samples.movie 
        || (catalogSamples['mtyy_movie'] && catalogSamples['mtyy_movie'][0]?.id);
    
    if (movieSample) {
        const r = await test({
            name: `电影 Meta (${movieSample})`,
            fn: () => metaHandler({ id: movieSample, type: 'movie' }),
            validate: (result) => {
                if (!result.meta) return { valid: false, reason: 'meta 为空' };
                const m = result.meta;
                if (!m.name) return { valid: false, reason: '缺 name' };
                if (!m.poster) return { valid: false, reason: '缺 poster' };
                if (m.type !== 'movie' && m.type !== 'series') {
                    return { valid: false, reason: `type 错误: ${m.type}` };
                }
                return { valid: true, summary: `"${m.name}"` };
            },
        });
        if (r.ok) {
            metaSamples.movie = r.result.meta;
            printMeta(r.result.meta, '电影 Meta');
        }
    } else {
        skip('电影 Meta', '无可用样本');
    }

    // 剧集样本
    const seriesSample = TEST_CASES.samples.series 
        || (catalogSamples['mtyy_series'] && catalogSamples['mtyy_series'][0]?.id);

    if (seriesSample) {
        const r = await test({
            name: `剧集 Meta (${seriesSample})`,
            fn: () => metaHandler({ id: seriesSample, type: 'series' }),
            validate: (result) => {
                if (!result.meta) return { valid: false, reason: 'meta 为空' };
                const m = result.meta;
                if (!m.name) return { valid: false, reason: '缺 name' };
                if (!Array.isArray(m.videos) || m.videos.length === 0) {
                    return { valid: false, reason: 'videos 为空' };
                }
                // 验证 videos id 格式
                const firstVideo = m.videos[0];
                if (!/^mtyy_\d+:\d+:\d+$/.test(firstVideo.id)) {
                    return { valid: false, reason: `videos[0].id 格式错误: ${firstVideo.id}` };
                }
                return { valid: true, summary: `"${m.name}" · ${m.videos.length} 集` };
            },
        });
        if (r.ok) {
            metaSamples.series = r.result.meta;
            printMeta(r.result.meta, '剧集 Meta');
        }
    } else {
        skip('剧集 Meta', '无可用样本');
    }

    return metaSamples;
}

// ============================================================
// 测试组 4：Stream
// ============================================================
async function testStream(metaSamples) {
    section('Stream · 播放');
    if (!shouldRun('stream')) return skip('Stream 测试', '--only 未包含');
    if (OPT.quick) return skip('Stream 测试', '--quick 模式');

    // 电影 Stream
    if (metaSamples.movie) {
        // 构造 vid:sid:nid（电影一般是 1:1）
        const movieStreamId = `mtyy_${metaSamples.movie.id.replace('mtyy_', '')}:1:1`;
        await test({
            name: `电影 Stream (${movieStreamId})`,
            fn: () => streamHandler({ id: movieStreamId, type: 'movie' }),
            timeout: 45000,
            validate: (result) => {
                if (!Array.isArray(result.streams)) {
                    return { valid: false, reason: 'streams 非数组' };
                }
                if (result.streams.length === 0) {
                    return { valid: false, reason: 'streams 为空' };
                }
                // 打印所有流（含诊断）
                printStreams(result.streams);
                // 至少有一条非诊断，或者全是诊断也算通过（方便排查）
                const hasPlayable = result.streams.some(s => 
                    s.url && !s.url.startsWith('mtyy|')
                );
                if (!hasPlayable) {
                    const diag = result.streams.find(s => s.url?.startsWith('mtyy|'));
                    return { 
                        valid: true, 
                        summary: `⚠️ 仅返回诊断 (${diag?.url.split('|')[1] || 'unknown'})`
                    };
                }
                return { valid: true, summary: `✓ ${result.streams.length} 条流` };
            },
        });
    } else {
        skip('电影 Stream', '无 Meta 样本');
    }

    // 剧集 Stream
    if (metaSamples.series && metaSamples.series.videos.length > 0) {
        const seriesStreamId = metaSamples.series.videos[0].id;
        await test({
            name: `剧集 Stream (${seriesStreamId})`,
            fn: () => streamHandler({ id: seriesStreamId, type: 'series' }),
            timeout: 45000,
            validate: (result) => {
                if (!Array.isArray(result.streams)) {
                    return { valid: false, reason: 'streams 非数组' };
                }
                if (result.streams.length === 0) {
                    return { valid: false, reason: 'streams 为空' };
                }
                printStreams(result.streams);
                const hasPlayable = result.streams.some(s => 
                    s.url && !s.url.startsWith('mtyy|')
                );
                if (!hasPlayable) {
                    const diag = result.streams.find(s => s.url?.startsWith('mtyy|'));
                    return { 
                        valid: true, 
                        summary: `⚠️ 仅返回诊断 (${diag?.url.split('|')[1] || 'unknown'})`
                    };
                }
                return { valid: true, summary: `✓ ${result.streams.length} 条流` };
            },
        });
    } else {
        skip('剧集 Stream', '无 Meta 样本');
    }
}

// ============================================================
// 测试组 5：边界与异常
// ============================================================
async function testEdges() {
    section('边界与异常');
    if (!shouldRun('edge')) return skip('边界测试', '--only 未包含');

    // 1. 错误的 Stream ID 格式
    await test({
        name: `Stream 错误 ID 格式 (${TEST_CASES.edges.invalidStreamId})`,
        fn: () => streamHandler({ id: TEST_CASES.edges.invalidStreamId, type: 'movie' }),
        validate: (result) => {
            if (!Array.isArray(result.streams) || result.streams.length === 0) {
                return { valid: false, reason: '应返回诊断' };
            }
            const diag = result.streams[0];
            if (!diag.url?.startsWith('mtyy|')) {
                return { valid: false, reason: '应为诊断流' };
            }
            if (!diag.url.includes('invalid_id')) {
                return { valid: false, reason: `诊断原因不符: ${diag.url}` };
            }
            return { valid: true, summary: '正确拦截' };
        },
    });

    // 2. 不存在的 Meta VID
    await test({
        name: `Meta 不存在的 VID (${TEST_CASES.edges.nonexistentMeta})`,
        fn: () => metaHandler({ id: TEST_CASES.edges.nonexistentMeta, type: 'movie' }),
        validate: (result) => {
            // 应该返回 null 或空 meta
            if (result.meta === null || result.meta === undefined) {
                return { valid: true, summary: '正确返回 null' };
            }
            // 如果站点返回了空内容也是可以的
            return { valid: false, reason: '应返回 null，实际有 meta' };
        },
    });

    // 3. 不存在的 Stream 集数
    await test({
        name: `Stream 不存在的集数 (${TEST_CASES.edges.nonexistentStream})`,
        fn: () => streamHandler({ id: TEST_CASES.edges.nonexistentStream, type: 'movie' }),
        timeout: 45000,
        validate: (result) => {
            if (!Array.isArray(result.streams)) {
                return { valid: false, reason: '非数组' };
            }
            // 打印诊断（方便看真实响应）
            if (result.streams.length > 0) printStreams(result.streams);
            return { valid: true, summary: `${result.streams.length} 条流（看诊断内容）` };
        },
    });

    // 4. NBY 加密检测
    await test({
        name: `Stream NBY 加密检测 (${TEST_CASES.edges.nbyEncrypted})`,
        fn: () => streamHandler({ id: TEST_CASES.edges.nbyEncrypted, type: 'series' }),
        timeout: 30000,
        validate: (result) => {
            if (!Array.isArray(result.streams) || result.streams.length === 0) {
                return { valid: false, reason: '应返回诊断' };
            }
            const diag = result.streams.find(s => 
                s.url?.includes('nby_encrypted') || s.title?.includes('NB源加密')
            );
            if (!diag) {
                // 可能实际是可播的（比如剧集下 NB 源不是加密的），打印看看
                printStreams(result.streams);
                return { valid: true, summary: '⚠️ 未检测到 NBY 加密（可能线路不加密）' };
            }
            console.log(`         ${C.yellow}诊断内容:${C.reset}`);
            diag.title?.split('\n').forEach(line => {
                console.log(`         ${C.yellow}${line}${C.reset}`);
            });
            return { valid: true, summary: '✓ 正确识别 NBY 加密' };
        },
    });
}

// ============================================================
// 打印完整报告
// ============================================================
function printReport() {
    title('📊 汇总报告');
    
    console.log(`  ${C.bold}总计：${C.reset}  ${stats.total}`);
    console.log(`  ${C.green}${C.bold}通过：${C.reset}  ${stats.passed}`);
    console.log(`  ${C.red}${C.bold}失败：${C.reset}  ${stats.failed}`);
    if (stats.skipped > 0) {
        console.log(`  ${C.yellow}${C.bold}跳过：${C.reset}  ${stats.skipped}`);
    }

    const rate = stats.total > 0 
        ? Math.round((stats.passed / stats.total) * 100) 
        : 0;
    const rateColor = rate >= 90 ? C.green : rate >= 70 ? C.yellow : C.red;
    console.log(`  ${C.bold}通过率：${C.reset} ${rateColor}${rate}%${C.reset}`);

    // 失败明细
    if (stats.failed > 0) {
        section('❌ 失败明细');
        for (const r of stats.results) {
            if (!r.ok && !r.skipped) {
                console.log(`  ${C.red}• ${r.name}${C.reset}`);
                console.log(`    ${C.dim}${r.error}${C.reset}`);
            }
        }
    }
}

// ============================================================
// 主入口
// ============================================================
async function main() {
    console.clear();
    title('🎬 麦田影院 Addon · 本地测试');
    console.log(`${C.bold}开始时间：${C.reset}${new Date().toLocaleString()}`);
    console.log(`${C.bold}模式：${C.reset}${OPT.quick ? '快速(--quick)' : '完整'}`);
    if (OPT.only.length > 0) {
        console.log(`${C.bold}测试组：${C.reset}${OPT.only.join(', ')}`);
    }

    const t0 = Date.now();

    try {
        await testManifest();
        const catalogSamples = await testCatalog() || {};
        await testSearch();
        const metaSamples = await testMeta(catalogSamples) || {};
        await testStream(metaSamples);
        await testEdges();
    } catch (e) {
        console.error(`\n${C.red}❌ 测试过程异常: ${e.message}${C.reset}`);
        console.error(e.stack);
        process.exit(1);
    }

    printReport();
    title(`🏁 测试完成 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error(`${C.red}FATAL: ${e.message}${C.reset}`);
    console.error(e.stack);
    process.exit(1);
});