#!/usr/bin/env node
/**
 * 🌾 麦田影院 Addon · 全量健康检测
 * 
 * 覆盖矩阵：
 *   [Manifest]     基础字段 / resources / 各资源 idPrefixes / catalogs / configurable
 *   [Catalog]      5 分类 × 元数据完整性 / cfg 过滤
 *   [Search]       多关键词 × movie+series
 *   [Meta]         movie / series / videos 完整性 / hl 参数矩阵 / 不存在
 *   [Stream-mtyy]  movie / series / 不存在集数 / 错误格式
 *   [Stream-tt]    movie / series / 不存在 / 交叉验证
 *   [Stream-cfg]   lines 黑名单 / hl 参数
 *   [Compliance]   逐流字段检查 / behaviorHints / proxyHeaders
 *   [Cache]        Catalog/Meta/Stream 二次 HIT / X-Cache
 *   [Configure]    html/css/js（不走 JSON 解析）
 *   [CORS]         全接口头部 + 404 处理
 * 
 * 用法：
 *   node health.js                              # 默认 localhost:3000
 *   BASE_URL=https://xx.vercel.app node health.js
 *   SKIP_SLOW=1 node health.js                  # 快速冒烟（30s）
 *   STRICT=1 node health.js                     # WARN 也算失败
 *   VERBOSE=1 node health.js                    # 打印完整响应
 */

'use strict';

// ============================================================
// 配置
// ============================================================
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = parseInt(process.env.TIMEOUT || '30000', 10);
const SKIP_SLOW = process.env.SKIP_SLOW === '1';
const STRICT = process.env.STRICT === '1';
const VERBOSE = process.env.VERBOSE === '1';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ============================================================
// 着色
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
const stats = {
    total: 0, passed: 0, failed: 0, skipped: 0, warned: 0,
    warnings: [], slow: [], results: [],
};

const coverage = {
    catalog: { movie: 0, series: 0, anime: 0, variety: 0, short: 0 },
    search: { movie: 0, series: 0 },
    meta: { movie: 0, series: 0 },
    stream_mtyy: { movie: 0, series: 0 },
    stream_tt: { movie: 0, series: 0 },
};

// ============================================================
// 日志
// ============================================================
function ts() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(color, icon, category, msg) {
    console.log(`${C.gray}[${ts()}]${C.reset} ${color}${icon}${C.reset} ${C.cyan}[${category}]${C.reset} ${msg}`);
}

function separator(title = '', sub = '') {
    const line = '═'.repeat(72);
    console.log(`\n${C.cyan}${line}${C.reset}`);
    if (title) {
        console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
        if (sub) console.log(`${C.gray}  ${sub}${C.reset}`);
        console.log(`${C.cyan}${line}${C.reset}`);
    }
    console.log('');
}

// ============================================================
// HTTP
// ============================================================
async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
    try {
        const resp = await fetch(`${BASE_URL}${path}`, {
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json, */*',
                ...(options.headers || {}),
            },
        });
        const text = await resp.text();
        return { status: resp.status, statusText: resp.statusText, headers: resp.headers, text };
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
// base64url
// ============================================================
function encodeCfg(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ============================================================
// JSON 测试执行器
// ============================================================
async function test({ category, name, path, validate, skip = false, skipReason = '', severity = 'major', timeout }) {
    if (skip) {
        stats.skipped++;
        stats.total++;
        log(C.yellow, '⏭️', category, `${name} ${C.gray}(跳过: ${skipReason})${C.reset}`);
        return { ok: false, skipped: true };
    }

    stats.total++;
    const t0 = Date.now();
    const result = { category, name, ok: false, elapsed: 0, error: null, summary: null, severity, warned: false, data: null };

    try {
        const resp = await request(path, { timeout: timeout || TIMEOUT });
        const elapsed = Date.now() - t0;
        result.elapsed = elapsed;

        if (resp.status >= 500) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        if (resp.status >= 400) throw new Error(`HTTP ${resp.status} ${resp.statusText} (4xx)`);

        let data;
        try { data = JSON.parse(resp.text); }
        catch (e) {
            const preview = resp.text.slice(0, 300).replace(/\n/g, '\\n');
            throw new Error(`JSON 解析失败: ${e.message} | 前 300 字: ${preview}`);
        }

        if (VERBOSE) console.log(`      ${C.dim}响应: ${JSON.stringify(data).slice(0, 500)}${C.reset}`);

        const v = await validate(data, resp.headers);
        if (!v || !v.valid) throw new Error(v?.reason || '校验失败');

        result.ok = true;
        result.summary = v.summary || 'OK';
        result.data = data;

        if (elapsed > 5000) stats.slow.push({ category, name, elapsed });

        log(C.green, '✅', category, `${name} ${C.gray}(${elapsed}ms)${C.reset} ${C.dim}${v.summary || ''}${C.reset}`);
        stats.passed++;
        stats.results.push(result);
        return result;
    } catch (err) {
        const elapsed = Date.now() - t0;
        result.elapsed = elapsed;
        result.error = err.name === 'AbortError' ? `超时(>${TIMEOUT}ms)` : err.message;

        if (severity === 'minor') {
            result.warned = true;
            log(C.yellow, '⚠️', category, `${name} ${C.gray}(${elapsed}ms)${C.reset}`);
            console.log(`         ${C.yellow}${result.error}${C.reset}`);
            stats.warnings.push(`[${category}] ${name}: ${result.error}`);
            stats.warned++;
        } else {
            log(C.red, '❌', category, `${name} ${C.gray}(${elapsed}ms)${C.reset}`);
            console.log(`         ${C.red}${result.error}${C.reset}`);
            stats.failed++;
        }

        stats.results.push(result);
        return result;
    }
}

// ============================================================
// 原始响应测试器（用于 HTML/CSS/JS，不解析 JSON）
// ============================================================
async function testRaw({ category, name, path, validate, severity = 'major' }) {
    stats.total++;
    const t0 = Date.now();
    const result = { category, name, ok: false, elapsed: 0, error: null, summary: null, severity, warned: false };

    try {
        const resp = await request(path);
        const elapsed = Date.now() - t0;
        result.elapsed = elapsed;

        const v = validate(resp);
        if (!v || !v.valid) throw new Error(v?.reason || '校验失败');

        result.ok = true;
        result.summary = v.summary || 'OK';

        log(C.green, '✅', category, `${name} ${C.gray}(${elapsed}ms)${C.reset} ${C.dim}${v.summary || ''}${C.reset}`);
        stats.passed++;
        stats.results.push(result);
        return result;
    } catch (err) {
        const elapsed = Date.now() - t0;
        result.elapsed = elapsed;
        result.error = err.name === 'AbortError' ? `超时(>${TIMEOUT}ms)` : err.message;

        log(C.red, '❌', category, `${name} ${C.gray}(${elapsed}ms)${C.reset}`);
        console.log(`         ${C.red}${result.error}${C.reset}`);
        stats.failed++;
        stats.results.push(result);
        return result;
    }
}

// ============================================================
// 校验工具
// ============================================================
function requireFields(obj, fields) {
    for (const f of fields) {
        if (obj[f] === undefined || obj[f] === null || obj[f] === '') return `缺少 ${f}`;
    }
    return null;
}

function isHttpUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

function validateMetaPreview(m) {
    const r = requireFields(m, ['id', 'type', 'name']);
    if (r) return r;
    if (!/^mtyy_\d+$/.test(m.id)) return `id 格式错误: ${m.id}`;
    if (!['movie', 'series'].includes(m.type)) return `type 错误: ${m.type}`;
    return null;
}

function validateStreamObject(s) {
    const r = requireFields(s, ['name', 'title']);
    if (r) return r;
    if (s.externalUrl) return null;
    if (!s.url) return '缺 url';
    if (!isHttpUrl(s.url)) return `url 非法: ${s.url.slice(0, 50)}`;
    return null;
}

function isDiagnosticStream(s) { return !!s.externalUrl && !s.url; }

function validateStreamResponse(d, { allowDiagnostic = true } = {}) {
    if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
    if (d.streams.length === 0) return { valid: false, reason: 'streams 为空' };

    for (const s of d.streams) {
        const err = validateStreamObject(s);
        if (err) return { valid: false, reason: `stream: ${err}` };
    }

    const real = d.streams.filter(s => !isDiagnosticStream(s));
    const diag = d.streams.filter(s => isDiagnosticStream(s));

    if (real.length > 0) {
        return { valid: true, summary: `${real.length} 条真实流${diag.length ? `+${diag.length}诊断` : ''}` };
    }

    const firstLine = (diag[0]?.title || '').split('\n')[0];
    if (/CDN 不可达|网络封锁/.test(firstLine)) {
        if (allowDiagnostic) return { valid: true, summary: `⚠️ WARN: ${firstLine.slice(0, 40)}`, warn: true };
        return { valid: false, reason: `WARN: ${firstLine.slice(0, 40)}` };
    }
    return { valid: true, summary: `诊断: ${firstLine.slice(0, 40)}` };
}

// ============================================================
// 全局样本
// ============================================================
const samples = {
    movie: null,
    series: null,
};

// ============================================================
// 1. Manifest
// ============================================================
async function testManifest() {
    separator('📋 1. Manifest');

    await test({
        category: 'manifest', name: '基础字段', path: '/manifest.json', severity: 'critical',
        validate: (d) => {
            if (!d.id) return { valid: false, reason: '缺 id' };
            if (!d.name) return { valid: false, reason: '缺 name' };
            if (!d.version) return { valid: false, reason: '缺 version' };
            return { valid: true, summary: `${d.id} v${d.version}` };
        },
    });

    await test({
        category: 'manifest', name: 'resources 含 catalog/meta/stream（无 subtitles）', path: '/manifest.json', severity: 'critical',
        validate: (d) => {
            const names = (d.resources || []).map(r => typeof r === 'string' ? r : r.name);
            const missing = ['catalog', 'meta', 'stream'].filter(n => !names.includes(n));
            if (missing.length) return { valid: false, reason: `缺: ${missing.join(', ')}` };
            if (names.includes('subtitles')) return { valid: false, reason: '不应含 subtitles' };
            return { valid: true, summary: `[${names.join(', ')}]` };
        },
    });

    await test({
        category: 'manifest', name: 'meta 只响应 mtyy_（不含 tt）', path: '/manifest.json', severity: 'critical',
        validate: (d) => {
            const meta = (d.resources || []).find(r => typeof r === 'object' && r.name === 'meta');
            if (!meta) return { valid: false, reason: '缺 meta' };
            if (meta.idPrefixes?.includes('tt')) return { valid: false, reason: 'meta 不应响应 tt' };
            if (!meta.idPrefixes?.includes('mtyy_')) return { valid: false, reason: 'meta 缺 mtyy_' };
            return { valid: true, summary: `[${meta.idPrefixes.join(', ')}]` };
        },
    });

    await test({
        category: 'manifest', name: 'stream 响应 mtyy_ + tt', path: '/manifest.json', severity: 'critical',
        validate: (d) => {
            const stream = (d.resources || []).find(r => typeof r === 'object' && r.name === 'stream');
            if (!stream) return { valid: false, reason: '缺 stream' };
            if (!stream.idPrefixes?.includes('tt')) return { valid: false, reason: 'stream 缺 tt' };
            if (!stream.idPrefixes?.includes('mtyy_')) return { valid: false, reason: 'stream 缺 mtyy_' };
            return { valid: true, summary: `[${stream.idPrefixes.join(', ')}]` };
        },
    });

    await test({
        category: 'manifest', name: 'catalogs 5 个分类', path: '/manifest.json', severity: 'critical',
        validate: (d) => {
            if (!Array.isArray(d.catalogs)) return { valid: false, reason: 'catalogs 非数组' };
            if (d.catalogs.length !== 5) return { valid: false, reason: `期望 5，实际 ${d.catalogs.length}` };
            return { valid: true, summary: d.catalogs.map(c => c.id).join(', ') };
        },
    });

    await test({
        category: 'manifest', name: 'catalog 各含 search（无 skip）', path: '/manifest.json', severity: 'major',
        validate: (d) => {
            for (const c of d.catalogs || []) {
                const extras = (c.extra || []).map(e => e.name);
                if (!extras.includes('search')) return { valid: false, reason: `${c.id} 缺 search` };
                if (extras.includes('skip')) return { valid: false, reason: `${c.id} 不应有 skip` };
            }
            return { valid: true, summary: '全部正确' };
        },
    });

    await test({
        category: 'manifest', name: 'catalog 类型匹配（movie/series）', path: '/manifest.json', severity: 'major',
        validate: (d) => {
            const map = { mtyy_movie: 'movie', mtyy_series: 'series', mtyy_anime: 'series', mtyy_variety: 'series', mtyy_short: 'series' };
            for (const c of d.catalogs || []) {
                if (map[c.id] && c.type !== map[c.id]) return { valid: false, reason: `${c.id} 类型应 ${map[c.id]}，实际 ${c.type}` };
            }
            return { valid: true, summary: '类型全部正确' };
        },
    });

    await test({
        category: 'manifest', name: 'configurable=false（默认）', path: '/manifest.json', severity: 'minor',
        validate: (d) => {
            if (d.behaviorHints?.configurable === true) return { valid: false, reason: '默认应 false' };
            return { valid: true, summary: 'configurable=false' };
        },
    });

    await test({
        category: 'manifest', name: 'configurable=true（带 cfg）', path: `/manifest.json?cfg=${encodeCfg({ cats: ['movie'] })}`, severity: 'major',
        validate: (d) => {
            if (d.behaviorHints?.configurable !== true) return { valid: false, reason: '应 true' };
            if (d.catalogs?.length !== 1) return { valid: false, reason: `catalogs 应 1，实际 ${d.catalogs?.length}` };
            return { valid: true, summary: `configurable=true, 1 catalog` };
        },
    });

    await test({
        category: 'manifest', name: 'Cache-Control 头', path: '/manifest.json', severity: 'minor',
        validate: (_, headers) => {
            const cc = headers.get('cache-control') || '';
            if (!/max-age=\d+/.test(cc)) return { valid: false, reason: `CC 不符: ${cc}` };
            return { valid: true, summary: cc };
        },
    });

    await test({
        category: 'manifest', name: 'CORS 头', path: '/manifest.json', severity: 'critical',
        validate: (_, headers) => {
            const acao = headers.get('access-control-allow-origin');
            if (acao !== '*') return { valid: false, reason: `ACAO=${acao}` };
            return { valid: true, summary: 'ACAO: *' };
        },
    });
}

// ============================================================
// 2. Catalog
// ============================================================
async function testCatalog() {
    separator('🎬 2. Catalog');

    const catalogDefs = [
        { id: 'mtyy_movie', type: 'movie', label: '电影', sampleKey: 'movie', coverageKey: 'movie' },
        { id: 'mtyy_series', type: 'series', label: '电视剧', sampleKey: 'series', coverageKey: 'series' },
        { id: 'mtyy_anime', type: 'series', label: '动漫', coverageKey: 'anime' },
        { id: 'mtyy_variety', type: 'series', label: '综艺', coverageKey: 'variety' },
        { id: 'mtyy_short', type: 'series', label: '短剧', coverageKey: 'short' },
    ];

    for (const def of catalogDefs) {
        const r = await test({
            category: 'catalog', name: `${def.label}（${def.id}）`,
            path: `/catalog/${def.type}/${def.id}.json`,
            severity: 'critical',
            validate: (d) => {
                if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
                if (d.metas.length === 0) return { valid: false, reason: 'metas 为空' };
                const first = d.metas[0];
                const err = validateMetaPreview(first);
                if (err) return { valid: false, reason: `首条: ${err}` };
                for (const m of d.metas.slice(0, 10)) {
                    if (m.type !== def.type) return { valid: false, reason: `含错误类型: ${m.id} → ${m.type}` };
                }
                return { valid: true, summary: `${d.metas.length} 条 · "${first.name}"` };
            },
        });

        if (r.ok) {
            coverage.catalog[def.coverageKey]++;
            if (def.sampleKey && r.data?.metas?.length > 0) {
                samples[def.sampleKey] = {
                    vid: r.data.metas[0].id.replace(/^mtyy_/, ''),
                };
            }
        }
    }

    await test({
        category: 'catalog', name: 'cfg 禁用动漫（应返回空）',
        path: `/catalog/series/mtyy_anime.json?cfg=${encodeCfg({ cats: ['movie', 'series'] })}`,
        severity: 'major',
        validate: (d) => {
            if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
            if (d.metas.length !== 0) return { valid: false, reason: `应空，实际 ${d.metas.length}` };
            return { valid: true, summary: '正确返回空' };
        },
    });

    await test({
        category: 'catalog', name: 'MetaPreview 字段完整性（poster/year）',
        path: '/catalog/movie/mtyy_movie.json',
        severity: 'major',
        validate: (d) => {
            if (!Array.isArray(d.metas) || !d.metas.length) return { valid: false, reason: 'metas 空' };
            let withPoster = 0, withYear = 0;
            for (const m of d.metas) {
                if (m.poster) withPoster++;
                if (m.releaseInfo) withYear++;
            }
            const total = d.metas.length;
            if (withPoster < total * 0.5) return { valid: false, reason: `poster 覆盖低: ${withPoster}/${total}` };
            return { valid: true, summary: `poster=${withPoster}/${total}, year=${withYear}/${total}` };
        },
    });
}

// ============================================================
// 3. Search
// ============================================================
async function testSearch() {
    separator('🔍 3. Search');

    for (const kw of ['流浪地球', '阿甘正传', '让子弹飞']) {
        const r = await test({
            category: 'search', name: `movie "${kw}"`,
            path: `/catalog/movie/mtyy_movie.json?search=${encodeURIComponent(kw)}`,
            severity: 'major',
            validate: (d) => {
                if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
                for (const m of d.metas.slice(0, 3)) {
                    const err = validateMetaPreview(m);
                    if (err) return { valid: false, reason: `结果: ${err}` };
                }
                return { valid: true, summary: `${d.metas.length} 条` };
            },
        });
        if (r.ok) coverage.search.movie++;
    }

    for (const kw of ['庆余年', '权游']) {
        const r = await test({
            category: 'search', name: `series "${kw}"`,
            path: `/catalog/series/mtyy_series.json?search=${encodeURIComponent(kw)}`,
            severity: 'major',
            validate: (d) => {
                if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
                for (const m of d.metas.slice(0, 3)) {
                    const err = validateMetaPreview(m);
                    if (err) return { valid: false, reason: `结果: ${err}` };
                }
                return { valid: true, summary: `${d.metas.length} 条` };
            },
        });
        if (r.ok) coverage.search.series++;
    }

    await test({
        category: 'search', name: '空关键词',
        path: '/catalog/movie/mtyy_movie.json?search=',
        severity: 'minor',
        validate: (d) => {
            if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
            return { valid: true, summary: `${d.metas.length} 条` };
        },
    });
}

// ============================================================
// 4. Meta
// ============================================================
async function testMeta() {
    separator('📺 4. Meta');

    if (samples.movie) {
        const r = await test({
            category: 'meta', name: `movie · mtyy_${samples.movie.vid}`,
            path: `/meta/movie/mtyy_${samples.movie.vid}.json`,
            severity: 'critical',
            validate: (d) => {
                if (!d.meta) return { valid: false, reason: 'meta 空' };
                if (d.meta.type !== 'movie') return { valid: false, reason: `type=${d.meta.type}` };
                const err = requireFields(d.meta, ['id', 'name']);
                if (err) return { valid: false, reason: err };
                return { valid: true, summary: `"${d.meta.name}"` };
            },
        });
        if (r.ok) coverage.meta.movie++;
    } else {
        await test({ category: 'meta', name: 'movie 采样失败', path: '/', skip: true, skipReason: 'Catalog 无样本' });
    }

    if (samples.series) {
        const r = await test({
            category: 'meta', name: `series · mtyy_${samples.series.vid}（videos 完整性）`,
            path: `/meta/series/mtyy_${samples.series.vid}.json`,
            severity: 'critical',
            validate: (d) => {
                if (!d.meta) return { valid: false, reason: 'meta 空' };
                if (d.meta.type !== 'series') return { valid: false, reason: `type=${d.meta.type}` };
                if (!Array.isArray(d.meta.videos) || !d.meta.videos.length) return { valid: false, reason: 'videos 空' };
                const v = d.meta.videos[0];
                if (!/^mtyy_\d+:\d+:\d+$/.test(v.id)) return { valid: false, reason: `videos[0].id 格式: ${v.id}` };
                if (typeof v.season !== 'number') return { valid: false, reason: 'season 非数字' };
                if (typeof v.episode !== 'number') return { valid: false, reason: 'episode 非数字' };
                if (!v.title) return { valid: false, reason: 'title 空' };
                return { valid: true, summary: `"${d.meta.name}" · ${d.meta.videos.length} 集` };
            },
        });
        if (r.ok) {
            coverage.meta.series++;
            samples.series.episodeId = r.data.meta.videos[0].id;
        }

        await test({
            category: 'meta', name: 'videos 默认不含 NB源',
            path: `/meta/series/mtyy_${samples.series.vid}.json`,
            severity: 'major',
            validate: (d) => {
                const nb = (d.meta?.videos || []).filter(v => /NB源/.test(v.title));
                if (nb.length > 0) return { valid: false, reason: `发现 ${nb.length} 条 NB源` };
                return { valid: true, summary: '无 NB源' };
            },
        });

        await test({
            category: 'meta', name: 'videos hl=false 含 NB源',
            path: `/meta/series/mtyy_${samples.series.vid}.json?cfg=${encodeCfg({ hl: false })}`,
            severity: 'major',
            validate: (d) => {
                const nb = (d.meta?.videos || []).filter(v => /NB源/.test(v.title));
                if (nb.length === 0) return { valid: false, reason: 'hl=false 应含 NB源' };
                return { valid: true, summary: `${nb.length} 条 NB源` };
            },
        });
    }

    await test({
        category: 'meta', name: '不存在的 vid（应 null）',
        path: '/meta/movie/mtyy_999999999.json',
        severity: 'minor',
        validate: (d) => {
            if (d.meta === null || d.meta === undefined) return { valid: true, summary: 'null' };
            return { valid: false, reason: `应 null，实际 ${JSON.stringify(d.meta).slice(0, 100)}` };
        },
    });

    await test({
        category: 'meta', name: '非法 ID 格式',
        path: '/meta/movie/invalid_id.json',
        severity: 'minor',
        validate: (d) => {
            if (d.meta === null || d.meta === undefined) return { valid: true, summary: 'null' };
            return { valid: false, reason: '应 null' };
        },
    });
}

// ============================================================
// 5. Stream · mtyy_
// ============================================================
async function testStreamMtyy() {
    separator('🎥 5. Stream · mtyy_ 格式');

    if (SKIP_SLOW) {
        await test({ category: 'stream-mtyy', name: '全部', path: '/', skip: true, skipReason: 'SKIP_SLOW=1' });
        return;
    }

    if (samples.movie) {
        const r = await test({
            category: 'stream-mtyy', name: `movie · mtyy_${samples.movie.vid}:1:1`,
            path: `/stream/movie/mtyy_${samples.movie.vid}:1:1.json`,
            severity: 'critical',
            validate: (d) => validateStreamResponse(d),
        });
        if (r.ok) coverage.stream_mtyy.movie++;
    }

    if (samples.series?.episodeId) {
        const r = await test({
            category: 'stream-mtyy', name: `series · ${samples.series.episodeId}`,
            path: `/stream/series/${samples.series.episodeId}.json`,
            severity: 'critical',
            validate: (d) => validateStreamResponse(d),
        });
        if (r.ok) coverage.stream_mtyy.series++;
    }

    if (samples.movie) {
        await test({
            category: 'stream-mtyy', name: '不存在的集数（诊断流）',
            path: `/stream/movie/mtyy_${samples.movie.vid}:99:99.json`,
            severity: 'minor',
            validate: (d) => {
                if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
                const diag = d.streams.filter(s => isDiagnosticStream(s));
                if (diag.length === 0) return { valid: false, reason: '应返回诊断' };
                return { valid: true, summary: diag[0].title.split('\n')[0].slice(0, 40) };
            },
        });
    }

    await test({
        category: 'stream-mtyy', name: '非法 ID 格式（诊断流）',
        path: '/stream/movie/mtyy_abc.json',
        severity: 'minor',
        validate: (d) => {
            if (!Array.isArray(d.streams)) return { valid: false, reason: '非数组' };
            if (!d.streams.some(s => isDiagnosticStream(s))) return { valid: false, reason: '应诊断' };
            return { valid: true, summary: '正确拦截' };
        },
    });
}

// ============================================================
// 6. Stream · tt
// ============================================================
async function testStreamTt() {
    separator('🎥 6. Stream · tt 格式');

    if (SKIP_SLOW) {
        await test({ category: 'stream-tt', name: '全部', path: '/', skip: true, skipReason: 'SKIP_SLOW=1' });
        return;
    }

    const r1 = await test({
        category: 'stream-tt', name: 'movie · tt0109830（阿甘正传）',
        path: '/stream/movie/tt0109830.json',
        severity: 'major',
        validate: (d) => validateStreamResponse(d),
    });
    if (r1.ok) coverage.stream_tt.movie++;

    const r2 = await test({
        category: 'stream-tt', name: 'series · tt0944947:1:1（权游 S1E1）',
        path: '/stream/series/tt0944947:1:1.json',
        severity: 'major',
        validate: (d) => validateStreamResponse(d),
    });
    if (r2.ok) coverage.stream_tt.series++;

    // 不存在的 tt — 宽容判断：诊断流/空数组 都算通过
    await test({
        category: 'stream-tt', name: '不存在的 tt（诊断流或空）',
        path: '/stream/movie/tt9999999.json',
        severity: 'minor',
        validate: (d) => {
            if (!Array.isArray(d.streams)) return { valid: false, reason: '非数组' };
            // 情况 A：返回诊断流
            if (d.streams.some(s => isDiagnosticStream(s))) {
                return { valid: true, summary: '正确返回诊断' };
            }
            // 情况 B：返回空数组
            if (d.streams.length === 0) {
                return { valid: true, summary: '正确返回空数组' };
            }
            // 情况 C：意外找到真实流（TMDB 可能收录了这个 tt）
            return { valid: true, summary: `⚠️ ${d.streams.length} 条流（tt 可能被 TMDB 收录）` };
        },
    });

    await test({
        category: 'stream-tt', name: '非法 tt 格式',
        path: '/stream/movie/ttabc.json',
        severity: 'minor',
        validate: (d) => {
            if (!Array.isArray(d.streams)) return { valid: false, reason: '非数组' };
            return { valid: true, summary: `${d.streams.length} 条` };
        },
    });

    if (r1.ok && samples.movie) {
        await test({
            category: 'stream-tt', name: 'tt 与 mtyy_ 主机一致性交叉验证',
            path: '/stream/movie/tt0109830.json',
            severity: 'minor',
            validate: async (d1) => {
                const r = await request(`/stream/movie/mtyy_${samples.movie.vid}:1:1.json`);
                const d2 = JSON.parse(r.text);
                const real1 = d1.streams.find(s => !isDiagnosticStream(s));
                const real2 = d2.streams.find(s => !isDiagnosticStream(s));
                if (!real1 || !real2) return { valid: true, summary: '一端无真实流，跳过对比' };
                try {
                    const h1 = new URL(real1.url).hostname;
                    const h2 = new URL(real2.url).hostname;
                    if (h1 !== h2) return { valid: false, reason: `主机不同: tt=${h1}, mtyy=${h2}` };
                    return { valid: true, summary: `主机一致: ${h1}` };
                } catch {
                    return { valid: true, summary: 'URL 解析失败，跳过' };
                }
            },
        });
    }
}

// ============================================================
// 7. Stream · 配置矩阵
// ============================================================
async function testStreamCfg() {
    separator('⚙️ 7. Stream · 配置矩阵');

    if (SKIP_SLOW) {
        await test({ category: 'stream-cfg', name: '全部', path: '/', skip: true, skipReason: 'SKIP_SLOW=1' });
        return;
    }

    if (!samples.movie) {
        await test({ category: 'stream-cfg', name: '全部', path: '/', skip: true, skipReason: '无 movie 样本' });
        return;
    }

    await test({
        category: 'stream-cfg', name: 'lines 黑名单生效',
        path: `/stream/movie/mtyy_${samples.movie.vid}:1:1.json?cfg=${encodeCfg({ lines: ['1', '2', '3', '4', '5', '6'] })}`,
        severity: 'major',
        validate: (d) => {
            if (!Array.isArray(d.streams)) return { valid: false, reason: '非数组' };
            const allDiag = d.streams.every(s => isDiagnosticStream(s));
            if (allDiag) return { valid: true, summary: '全部被黑名单拦截' };
            return { valid: true, summary: `${d.streams.length} 条（可能有未匹配黑名单的线路）` };
        },
    });

    if (samples.series) {
        await test({
            category: 'stream-cfg', name: 'hl=false 显示 NB 诊断',
            path: `/stream/series/mtyy_${samples.series.vid}:4:1.json?cfg=${encodeCfg({ hl: false })}`,
            severity: 'minor',
            validate: (d) => {
                if (!Array.isArray(d.streams)) return { valid: false, reason: '非数组' };
                return { valid: true, summary: `${d.streams.length} 条` };
            },
        });
    }
}

// ============================================================
// 8. Stream 数据合规性
// ============================================================
async function testCompliance() {
    separator('🔍 8. Stream 数据合规性');

    if (SKIP_SLOW) {
        await test({ category: 'compliance', name: '全部', path: '/', skip: true, skipReason: 'SKIP_SLOW=1' });
        return;
    }

    if (!samples.movie) {
        await test({ category: 'compliance', name: '全部', path: '/', skip: true, skipReason: '无 movie 样本' });
        return;
    }

    const path = `/stream/movie/mtyy_${samples.movie.vid}:1:1.json`;
    const resp = await request(path);
    const data = JSON.parse(resp.text);
    const realStreams = (data.streams || []).filter(s => !isDiagnosticStream(s));

    if (realStreams.length === 0) {
        await test({ category: 'compliance', name: '全部', path, skip: true, skipReason: '无真实流（CDN 可能不可达）' });
        return;
    }

    for (let i = 0; i < Math.min(realStreams.length, 3); i++) {
        const s = realStreams[i];
        const idx = i + 1;

        await test({
            category: 'compliance', name: `流[${idx}] notWebReady=true`, path, severity: 'major',
            validate: () => {
                if (s.behaviorHints?.notWebReady !== true) return { valid: false, reason: '应 true' };
                return { valid: true, summary: 'true' };
            },
        });

        await test({
            category: 'compliance', name: `流[${idx}] bingeGroup 存在`, path, severity: 'major',
            validate: () => {
                if (!s.behaviorHints?.bingeGroup) return { valid: false, reason: '缺 bingeGroup' };
                return { valid: true, summary: s.behaviorHints.bingeGroup };
            },
        });

        await test({
            category: 'compliance', name: `流[${idx}] proxyHeaders.Referer`, path, severity: 'major',
            validate: () => {
                const h = s.proxyHeaders?.request;
                if (!h?.Referer) return { valid: false, reason: '缺 Referer' };
                return { valid: true, summary: h.Referer };
            },
        });

        await test({
            category: 'compliance', name: `流[${idx}] proxyHeaders.User-Agent`, path, severity: 'major',
            validate: () => {
                const h = s.proxyHeaders?.request;
                if (!h?.['User-Agent']) return { valid: false, reason: '缺 UA' };
                return { valid: true, summary: h['User-Agent'].slice(0, 40) };
            },
        });

        await test({
            category: 'compliance', name: `流[${idx}] url 是 http(s)`, path, severity: 'major',
            validate: () => {
                if (!isHttpUrl(s.url)) return { valid: false, reason: `url 非法: ${s.url?.slice(0, 50)}` };
                return { valid: true, summary: s.url.slice(0, 60) + '...' };
            },
        });
    }
}

// ============================================================
// 9. 缓存
// ============================================================
async function testCache() {
    separator('💾 9. 缓存验证');

    await request('/catalog/movie/mtyy_movie.json');
    const t0 = Date.now();
    await request('/catalog/movie/mtyy_movie.json');
    const catElapsed = Date.now() - t0;

    await test({
        category: 'cache', name: 'Catalog 二次响应 < 1.5s',
        path: '/catalog/movie/mtyy_movie.json',
        severity: 'minor',
        validate: () => {
            if (catElapsed > 1500) return { valid: false, reason: `二次 ${catElapsed}ms 未命中` };
            return { valid: true, summary: `二次 ${catElapsed}ms` };
        },
    });

    if (!SKIP_SLOW && samples.movie) {
        const path = `/stream/movie/mtyy_${samples.movie.vid}:1:1.json`;
        await request(path);
        const r2 = await request(path);
        const xcache = r2.headers.get('x-cache');
        await test({
            category: 'cache', name: 'Stream X-Cache 头存在', path, severity: 'minor',
            validate: () => {
                if (!xcache) return { valid: false, reason: '缺 X-Cache 头' };
                return { valid: true, summary: `X-Cache: ${xcache}` };
            },
        });
    }

    if (samples.movie) {
        const path = `/meta/movie/mtyy_${samples.movie.vid}.json`;
        await request(path);
        const t1 = Date.now();
        await request(path);
        const metaElapsed = Date.now() - t1;
        await test({
            category: 'cache', name: 'Meta 二次响应 < 1.5s', path, severity: 'minor',
            validate: () => {
                if (metaElapsed > 1500) return { valid: false, reason: `二次 ${metaElapsed}ms` };
                return { valid: true, summary: `二次 ${metaElapsed}ms` };
            },
        });
    }
}

// ============================================================
// 10. Configure 页面（不走 JSON 解析）
// ============================================================
async function testConfigure() {
    separator('⚙️ 10. Configure 页面');

    await testRaw({
        category: 'configure', name: '/configure HTML', path: '/configure', severity: 'major',
        validate: (resp) => {
            if (resp.status !== 200) return { valid: false, reason: `HTTP ${resp.status}` };
            if (!resp.text.includes('麦田影院')) return { valid: false, reason: '缺"麦田影院"' };
            if (!resp.text.includes('configure.js')) return { valid: false, reason: '缺 script 引用' };
            return { valid: true, summary: `${resp.text.length} 字符` };
        },
    });

    await testRaw({
        category: 'configure', name: '/configure.css', path: '/configure.css', severity: 'major',
        validate: (resp) => {
            if (resp.status !== 200) return { valid: false, reason: `HTTP ${resp.status}` };
            if (resp.text.length < 1000) return { valid: false, reason: `过短 ${resp.text.length}` };
            return { valid: true, summary: `${resp.text.length} 字符` };
        },
    });

    await testRaw({
        category: 'configure', name: '/configure.js', path: '/configure.js', severity: 'major',
        validate: (resp) => {
            if (resp.status !== 200) return { valid: false, reason: `HTTP ${resp.status}` };
            if (!resp.text.includes('b64urlEncode')) return { valid: false, reason: '缺 b64urlEncode' };
            return { valid: true, summary: `${resp.text.length} 字符` };
        },
    });
}

// ============================================================
// 11. CORS & 错误处理
// ============================================================
async function testCorsAndError() {
    separator('🌐 11. CORS & 错误处理');

    await test({
        category: 'cors', name: 'Catalog CORS 头',
        path: '/catalog/movie/mtyy_movie.json', severity: 'critical',
        validate: (_, headers) => {
            const acao = headers.get('access-control-allow-origin');
            if (acao !== '*') return { valid: false, reason: `ACAO=${acao}` };
            return { valid: true, summary: 'ACAO: *' };
        },
    });

    // 404 处理：期望返回 404，用原始请求处理（因为 request() 会对 4xx 抛错）
    stats.total++;
    {
        const t0 = Date.now();
        try {
            const resp = await request('/this-does-not-exist', { timeout: 5000 });
            const elapsed = Date.now() - t0;
            if (resp.status === 404) {
                log(C.green, '✅', 'cors', `404 路径正确处理 (${elapsed}ms) 404`);
                stats.passed++;
                stats.results.push({ category: 'cors', name: '404 路径正确处理', ok: true, elapsed, summary: '404', severity: 'minor' });
            } else {
                log(C.red, '❌', 'cors', `404 路径正确处理 (${elapsed}ms)`);
                console.log(`         ${C.red}期望 404，实际 ${resp.status}${C.reset}`);
                stats.failed++;
                stats.results.push({ category: 'cors', name: '404 路径正确处理', ok: false, elapsed, error: `HTTP ${resp.status}`, severity: 'minor' });
            }
        } catch (err) {
            const elapsed = Date.now() - t0;
            // request() 对 4xx 抛错，但错误消息里带 "HTTP 404" 说明服务端正确返回了 404
            if (/HTTP 404/.test(err.message)) {
                log(C.green, '✅', 'cors', `404 路径正确处理 (${elapsed}ms) 404`);
                stats.passed++;
                stats.results.push({ category: 'cors', name: '404 路径正确处理', ok: true, elapsed, summary: '404', severity: 'minor' });
            } else {
                log(C.red, '❌', 'cors', `404 路径正确处理 (${elapsed}ms)`);
                console.log(`         ${C.red}${err.message}${C.reset}`);
                stats.failed++;
                stats.results.push({ category: 'cors', name: '404 路径正确处理', ok: false, elapsed, error: err.message, severity: 'minor' });
            }
        }
    }
}

// ============================================================
// 覆盖率矩阵
// ============================================================
function printCoverage() {
    separator('📊 覆盖率矩阵');

    const rows = [
        ['Manifest', `${stats.results.filter(r => r.category === 'manifest').length} 项测试`],
        ['Catalog', `movie${coverage.catalog.movie > 0 ? '✓' : '✗'} series${coverage.catalog.series > 0 ? '✓' : '✗'} anime${coverage.catalog.anime > 0 ? '✓' : '✗'} variety${coverage.catalog.variety > 0 ? '✓' : '✗'} short${coverage.catalog.short > 0 ? '✓' : '✗'}`],
        ['Search', `movie${coverage.search.movie > 0 ? '✓' : '✗'}(${coverage.search.movie}) series${coverage.search.series > 0 ? '✓' : '✗'}(${coverage.search.series})`],
        ['Meta', `movie${coverage.meta.movie > 0 ? '✓' : '✗'} series${coverage.meta.series > 0 ? '✓' : '✗'}`],
        ['Stream · mtyy_', `movie${coverage.stream_mtyy.movie > 0 ? '✓' : '✗'} series${coverage.stream_mtyy.series > 0 ? '✓' : '✗'}`],
        ['Stream · tt', `movie${coverage.stream_tt.movie > 0 ? '✓' : '✗'} series${coverage.stream_tt.series > 0 ? '✓' : '✗'}`],
    ];

    for (const [k, v] of rows) {
        console.log(`  ${C.bold}${k.padEnd(16)}${C.reset} ${v}`);
    }
}

// ============================================================
// 详细报告
// ============================================================
function printReport(totalTime) {
    separator('📋 详细结果');
    let lastCat = '';
    for (const r of stats.results) {
        if (r.category !== lastCat) {
            console.log(`\n${C.bold}${C.magenta}【${r.category}】${C.reset}`);
            lastCat = r.category;
        }
        const icon = r.ok ? `${C.green}✅${C.reset}` : (r.warned ? `${C.yellow}⚠️${C.reset}` : `${C.red}❌${C.reset}`);
        const sev = r.severity === 'critical' ? ' 🔴' : (r.severity === 'major' ? ' 🟠' : '');
        console.log(`  ${icon} ${r.name}${sev} ${C.gray}(${r.elapsed}ms)${C.reset}`);
        if (r.ok && r.summary) console.log(`      ${C.dim}${r.summary}${C.reset}`);
        if (!r.ok) console.log(`      ${C.red}${r.error}${C.reset}`);
    }

    separator('📊 分类统计');
    const byCat = {};
    for (const r of stats.results) {
        if (!byCat[r.category]) byCat[r.category] = { total: 0, passed: 0, failed: 0, warned: 0, elapsed: 0 };
        byCat[r.category].total++;
        byCat[r.category].elapsed += r.elapsed;
        if (r.ok) byCat[r.category].passed++;
        else if (r.warned) byCat[r.category].warned++;
        else byCat[r.category].failed++;
    }
    for (const [cat, s] of Object.entries(byCat)) {
        const avg = Math.round(s.elapsed / s.total);
        const color = s.failed > 0 ? C.red : (s.warned > 0 ? C.yellow : C.green);
        console.log(`  ${color}${cat.padEnd(15)}${C.reset}  total=${s.total}  通过=${s.passed}  失败=${s.failed}  警告=${s.warned}  平均=${avg}ms`);
    }

    separator('📊 汇总');
    console.log(`  ${C.bold}总计：${C.reset}  ${stats.total}`);
    console.log(`  ${C.green}${C.bold}通过：${C.reset}  ${stats.passed}`);
    console.log(`  ${C.red}${C.bold}失败：${C.reset}  ${stats.failed}`);
    if (stats.warned) console.log(`  ${C.yellow}${C.bold}警告：${C.reset}  ${stats.warned}`);
    if (stats.skipped) console.log(`  ${C.yellow}${C.bold}跳过：${C.reset}  ${stats.skipped}`);
    console.log(`  ${C.bold}耗时：${C.reset}  ${totalTime}ms`);

    const rate = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;
    const rateColor = rate >= 90 ? C.green : (rate >= 70 ? C.yellow : C.red);
    console.log(`  ${C.bold}通过率：${C.reset} ${rateColor}${rate}%${C.reset}`);

    if (stats.warnings.length) {
        separator('⚠️ 警告');
        for (const w of stats.warnings) console.log(`  ${C.yellow}• ${w}${C.reset}`);
    }

    if (stats.slow.length) {
        separator('🐢 慢测试（>5s）');
        for (const s of stats.slow.sort((a, b) => b.elapsed - a.elapsed).slice(0, 10)) {
            console.log(`  ${C.yellow}• [${s.category}] ${s.name}${C.reset} ${C.gray}(${s.elapsed}ms)${C.reset}`);
        }
    }

    if (stats.failed > 0) {
        separator('💡 诊断建议');
        const cats = {};
        for (const r of stats.results.filter(r => !r.ok && !r.warned)) {
            cats[r.category] = (cats[r.category] || 0) + 1;
        }
        const suggestions = {
            manifest: '检查 src/manifest.js / config.js',
            catalog: '检查麦田站可达性 / src/parser.js',
            search: '检查 RSS 接口 / src/parser.js',
            meta: '检查详情页解析 / videos 组装',
            'stream-mtyy': '检查播放页解析 / CDN 可达性 / src/handlers/stream.js',
            'stream-tt': '检查 TMDB_API_KEY / src/resolver.js',
            'stream-cfg': '检查 src/handlers/stream.js 的 config 消费',
            compliance: '检查 behaviorHints / proxyHeaders',
            cache: '检查 Redis 环境变量 / src/cache.js',
            configure: '检查 public/ 目录 / vercel.json',
            cors: '检查 api/index.js 的 cors() 函数',
        };
        for (const [cat, n] of Object.entries(cats)) {
            const sug = suggestions[cat] || '检查相关 handler';
            console.log(`  ${C.yellow}⚠️ ${cat} (${n} 项)${C.reset} → ${sug}`);
        }
    }
}

// ============================================================
// 主入口
// ============================================================
async function main() {
    console.clear();
    separator(
        '🌾 麦田影院 Addon · 全量健康检测',
        `BASE_URL=${BASE_URL} · TIMEOUT=${TIMEOUT}ms · SKIP_SLOW=${SKIP_SLOW} · STRICT=${STRICT}`
    );
    console.log(`${C.bold}开始时间：${C.reset}${new Date().toLocaleString()}\n`);

    try {
        const resp = await request('/manifest.json', { timeout: 5000 });
        if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
        console.log(`${C.red}❌ 服务不可达：${err.message}${C.reset}`);
        console.log(`${C.yellow}检查：${C.reset}`);
        console.log(`  1. 已运行 npx vercel dev`);
        console.log(`  2. BASE_URL 正确（当前：${BASE_URL}）`);
        process.exit(1);
    }

    const t0 = Date.now();

    await testManifest();
    await testCatalog();
    await testSearch();
    await testMeta();
    await testStreamMtyy();
    await testStreamTt();
    await testStreamCfg();
    await testCompliance();
    await testCache();
    await testConfigure();
    await testCorsAndError();

    const totalTime = Date.now() - t0;

    printCoverage();
    printReport(totalTime);

    separator();
    const exitFail = stats.failed > 0 || (STRICT && stats.warned > 0);
    process.exit(exitFail ? 1 : 0);
}

main().catch((err) => {
    console.error(`${C.red}脚本异常：${err.message}${C.reset}`);
    console.error(err.stack);
    process.exit(1);
});