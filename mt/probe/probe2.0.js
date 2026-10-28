/**
 * 麦田影院 · Stremio Addon 底层接口完整测试 v6.2
 * 
 * 改进：
 *   1. 完整输出 Stream URL（不截断，可直接复制）
 *   2. 提供 curl 复现命令 + VLC CLI 测试命令
 *   3. M3U8 测试改用系统 curl（绕开 Node fetch 环境问题）
 *   4. 直链提取失败自动诊断播放页
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置
// ============================================================
const CONFIG = {
    HOSTS: [
        "https://mtyy5.com",
        "https://mtyy2.cc",
        "https://mtyy4.cc",
        "https://mtyy8.cc",
        "https://mtyy3.com"
    ],
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "text/html,application/xml;q=0.9,*/*;q=0.8"
    },
    timeout: 15000,
    CATEGORIES: [
        { tid: '1', label: '电影',   type: 'movie'  },
        { tid: '2', label: '电视剧', type: 'series' },
        { tid: '3', label: '动漫',   type: 'series' },
        { tid: '4', label: '综艺',   type: 'series' },
        { tid: '26', label: '短剧',  type: 'series' },
    ],
    SEARCH_KEYWORDS: [
        { keyword: '流浪地球', label: '电影' },
        { keyword: '庆余年',   label: '剧集' },
    ]
};

// 用于收集输出，最后写入文件方便复制
const REPORT = { lines: [], streamUrls: [] };

// ============================================================
// 着色 & 输出工具
// ============================================================
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
    magenta: '\x1b[35m',
};

const log = {
    ok:   (m) => { console.log(`${C.green}✅ [PASS]${C.reset} ${m}`); REPORT.lines.push(`[PASS] ${m.replace(/\x1b\[[0-9;]*m/g, '')}`); },
    fail: (m) => { console.log(`${C.red}❌ [FAIL]${C.reset} ${m}`); REPORT.lines.push(`[FAIL] ${m.replace(/\x1b\[[0-9;]*m/g, '')}`); },
    info: (m) => { console.log(`${C.blue}ℹ️  [INFO]${C.reset} ${m}`); REPORT.lines.push(`[INFO] ${m.replace(/\x1b\[[0-9;]*m/g, '')}`); },
    warn: (m) => { console.log(`${C.yellow}⚠️  [WARN]${C.reset} ${m}`); REPORT.lines.push(`[WARN] ${m.replace(/\x1b\[[0-9;]*m/g, '')}`); },
};
const title = (t) => {
    console.log(`\n${C.cyan}${'='.repeat(72)}${C.reset}`);
    console.log(`${C.cyan}${C.bold}  ${t}${C.reset}`);
    console.log(`${C.cyan}${'='.repeat(72)}${C.reset}`);
};
const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// ============================================================
// HTTP（Node fetch）
// ============================================================
async function http(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || CONFIG.timeout);
    try {
        const resp = await fetch(url, {
            method: 'GET',
            headers: { ...CONFIG.headers, ...(opts.headers || {}) },
            signal: ctrl.signal,
            redirect: 'follow'
        });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, text, url };
    } catch (e) {
        return { ok: false, status: 0, text: '', err: e.message, url };
    } finally {
        clearTimeout(timer);
    }
}

let ACTIVE_HOST = null;

async function httpHost(p) {
    if (ACTIVE_HOST) {
        const r = await http(ACTIVE_HOST + p);
        if (r.ok && r.text && r.text.length > 1000) return { ...r, host: ACTIVE_HOST };
    }
    for (const host of CONFIG.HOSTS) {
        const r = await http(host + p);
        if (r.ok && r.text && r.text.length > 1000) {
            ACTIVE_HOST = host;
            return { ...r, host };
        }
    }
    return { ok: false, text: '', host: null };
}

// ============================================================
// HTTP（系统 curl，用于 M3U8 测试，绕开 Node 网络问题）
// ============================================================
function curlTest(url, host, timeoutSec = 15) {
    const ua = CONFIG.headers['User-Agent'];
    const referer = host + '/';
    // -o /dev/null 只取头，-w 输出格式
    const args = [
        '-sS',
        '-o', '/dev/null',
        '-w', '%{http_code}|%{size_download}|%{time_total}',
        '-L',                        // 跟随重定向
        '--max-time', String(timeoutSec),
        '-H', `Referer: ${referer}`,
        '-H', `User-Agent: ${ua}`,
        url,
    ];

    try {
        const res = spawnSync('curl', args, { timeout: (timeoutSec + 3) * 1000 });
        if (res.error) {
            return { ok: false, err: res.error.message };
        }
        const out = (res.stdout || '').toString().trim();
        const err = (res.stderr || '').toString().trim();
        if (res.status !== 0) {
            return { ok: false, err: err || `curl exit ${res.status}` };
        }
        const [status, size, elapsed] = out.split('|');
        return {
            ok: true,
            status: parseInt(status, 10),
            size: parseInt(size, 10),
            elapsed: parseFloat(elapsed) * 1000,
        };
    } catch (e) {
        return { ok: false, err: e.message };
    }
}

function curlGetFirst(url, host, bytes = 500) {
    const ua = CONFIG.headers['User-Agent'];
    const referer = host + '/';
    const args = [
        '-sS',
        '-r', `0-${bytes - 1}`,
        '-L',
        '--max-time', '10',
        '-H', `Referer: ${referer}`,
        '-H', `User-Agent: ${ua}`,
        url,
    ];
    try {
        const res = spawnSync('curl', args, { timeout: 15000 });
        if (res.status !== 0) return '';
        return (res.stdout || '').toString();
    } catch {
        return '';
    }
}

// ============================================================
// 解析器
// ============================================================
function parseVideoList(html) {
    const items = [];
    const seen = new Set();
    const re = /<a[^>]*class="public-list-exp"[^>]*href="\/voddetail\/(\d+)\.html"[^>]*title="([^"]+)"([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const vid = m[1];
        if (seen.has(vid)) continue;
        seen.add(vid);
        const name = m[2].trim();
        const inner = m[3];
        const picM = inner.match(/<img[^>]*data-src="([^"]+)"/);
        const pic = picM ? picM[1] : '';
        const statusM = inner.match(/<span class="public-list-prb[^"]*">([^<]+)<\/span>/);
        const status = statusM ? statusM[1].trim() : '';
        const yearM = inner.match(/<span class="public-prt[^"]*">([^<]+)<\/span>/);
        const year = yearM ? yearM[1].trim() : '';
        const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 500);
        const typeM = tail.match(/<div class="public-list-subtitle[^"]*">([^<]*)<\/div>/);
        const type = typeM ? typeM[1].trim() : '';
        items.push({ vid, name, pic, status, year, type });
    }
    return items;
}

function parseRss(xml) {
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const get = (tag) => {
            const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
            const mm = block.match(re);
            return mm ? mm[1].trim() : '';
        };
        const title = get('title');
        const link = get('link');
        const description = get('description');
        const vidMatch = link.match(/\/voddetail\/(\d+)\.html/);
        if (!vidMatch) continue;
        const picMatch = description.match(/<img[^>]*src="([^"]+)"/);
        items.push({
            vid: vidMatch[1],
            name: title,
            pic: picMatch ? picMatch[1] : '',
        });
    }
    return items;
}

function parseDetail(html, vid) {
    let name = '';
    for (const p of [
        /<div class="this-desc-title">([^<]+)<\/div>/,
        /<li>\s*<em class="cor4">片名：<\/em>\s*<span>([^<]+)<\/span>/,
        /<meta\s+name="keywords"\s+content="([^,，]+)/,
        /<title>([^-<]+)-麦田影院<\/title>/,
    ]) {
        const mm = html.match(p);
        if (mm) {
            const cand = stripTags(mm[1]).trim();
            if (cand && cand.length < 100) { name = cand; break; }
        }
    }

    let pic = '';
    const pic1 = html.match(/<div class="this-pic-bj" style="background-image: url\('([^']+)'\)"/);
    if (pic1) pic = pic1[1];
    if (!pic) {
        const pic2 = html.match(/<img[^>]*class="lazy[^"]*gen-movie-img[^"]*"[^>]*data-src="([^"]+)"/);
        if (pic2) pic = pic2[1];
    }

    let desc = '';
    const d1 = html.match(/<div id="height_limit" class="text"><strong[^>]*>描述:<\/strong>([\s\S]*?)<\/div>/);
    if (d1) desc = stripTags(d1[1]).trim();
    if (!desc || desc.length < 10) {
        const d2 = html.match(/<li class="top26"><em class="cor4">简介：<\/em>([\s\S]*?)<\/li>/);
        if (d2) desc = stripTags(d2[1]).trim();
    }

    const scoreM = html.match(/<span class="this-desc-score[^"]*"><i[^>]*><\/i>([\d.]+)<\/span>/);
    const rating = scoreM ? scoreM[1] : '';

    const yearM = html.match(/<i>年份<\/i>(\d{4})/);
    const year = yearM ? yearM[1] : '';

    let region = '', language = '', status = '';
    const infoM = html.match(/<div class="this-desc-info">([\s\S]*?)<\/div>/);
    if (infoM) {
        const spans = [...infoM[1].matchAll(/<span>([^<]+)<\/span>/g)].map(x => x[1].trim());
        if (spans.length >= 3) { region = spans[0]; language = spans[1]; status = spans[2]; }
    }

    let genres = [];
    const tagsM = html.match(/<div class="this-desc-tags">([\s\S]*?)<\/div>/);
    if (tagsM) genres = [...tagsM[1].matchAll(/<span>([^<]+)<\/span>/g)].map(x => x[1]);

    const dirM = html.match(/<strong class="r6">导演:<\/strong>([\s\S]*?)<\/div>/);
    const directors = dirM ? [...dirM[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map(x => x[1]) : [];
    const castM = html.match(/<strong class="r6">演员:<\/strong>([\s\S]*?)<\/div>/);
    const cast = castM ? [...castM[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map(x => x[1]) : [];

    const lineNames = [];
    const tabM = html.match(/<div class="anthology-tab[^"]*">([\s\S]*?)<\/div>\s*<\/div>/);
    if (tabM) {
        const nameRe = /<a class="swiper-slide"><i[^>]*><\/i>&nbsp;([^<]+?)(?:<span class="badge">\d+<\/span>)?<\/a>/g;
        let nm;
        while ((nm = nameRe.exec(tabM[1])) !== null) lineNames.push(nm[1].trim());
    }

    const allBoxes = [];
    const boxRe = /<div class="anthology-list-box[^"]*">\s*<div>\s*<ul class="anthology-list-play[^"]*">([\s\S]*?)<\/ul>/g;
    let bm;
    while ((bm = boxRe.exec(html)) !== null) {
        const eps = [];
        const epRe = /<a class="hide" href="\/vodplay\/(\d+)-(\d+)-(\d+)\.html">([^<]+)<\/a>/g;
        let em;
        while ((em = epRe.exec(bm[1])) !== null) {
            eps.push({ vid: em[1], sid: em[2], nid: em[3], title: em[4].trim() });
        }
        allBoxes.push(eps);
    }

    const lines = [];
    for (let i = 0; i < allBoxes.length; i++) {
        if (allBoxes[i].length === 0) continue;
        lines.push({
            name: lineNames[i] || `线路${i + 1}`,
            sid: allBoxes[i][0].sid,
            episodes: allBoxes[i],
        });
    }

    const isMovie =
        lines.length > 0 &&
        lines[0].episodes.length === 1 &&
        /^(正片|HD|HD国语|HD中字|1080P|720P|蓝光|TC|抢先版|超清|完结|VIP|第0?1集|更新至.*)$/i.test(lines[0].episodes[0].title);

    return { vid, name, pic, desc, rating, year, region, language, status, genres, directors, cast, lines, isMovie };
}

function parsePlayerUrl(html) {
    const m = html.match(/"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/i)
           || html.match(/"url_next"\s*:\s*"([^"]+\.m3u8[^"]*)"/i);
    return m ? m[1].replace(/\\\//g, '/') : '';
}

/**
 * 完整输出 Stream 信息 + VLC/Curl 测试命令
 */
function printStreamFull(label, directUrl, host, epTitle, lineName) {
    const referer = host + '/';
    const ua = CONFIG.headers['User-Agent'];

    console.log(`\n  ${C.cyan}${'─'.repeat(70)}${C.reset}`);
    console.log(`  ${C.bold}${label}${C.reset}`);
    console.log(`  ${C.cyan}${'─'.repeat(70)}${C.reset}`);
    console.log(`  ${C.bold}完整 URL (可直接复制):${C.reset}`);
    console.log(`  ${C.green}${directUrl}${C.reset}`);
    console.log(`\n  ${C.bold}Referer:${C.reset} ${referer}`);
    console.log(`  ${C.bold}User-Agent:${C.reset} ${ua}`);

    console.log(`\n  ${C.bold}${C.yellow}📺 VLC CLI 测试命令（复制到另一个终端直接跑）:${C.reset}`);
    const isMac = process.platform === 'darwin';
    const vlcPath = isMac ? '/Applications/VLC.app/Contents/MacOS/VLC' : 'vlc';
    console.log(`  ${C.gray}# macOS / Linux${C.reset}`);
    console.log(`  ${vlcPath} --http-referrer="${referer}" "${directUrl}"`);
    console.log(`\n  ${C.gray}# Windows (PowerShell)${C.reset}`);
    console.log(`  & "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --http-referrer="${referer}" "${directUrl}"`);

    console.log(`\n  ${C.bold}${C.yellow}🔧 curl 复现命令（验证 HTTP 状态和内容）:${C.reset}`);
    console.log(`  ${C.gray}# 看 HTTP 头${C.reset}`);
    console.log(`  curl -sS -I -H "Referer: ${referer}" -H "User-Agent: ${ua}" "${directUrl}"`);
    console.log(`  ${C.gray}# 看 M3U8 前 500 字节（应该是 #EXTM3U 开头）${C.reset}`);
    console.log(`  curl -sS -r 0-499 -H "Referer: ${referer}" -H "User-Agent: ${ua}" "${directUrl}"`);

    console.log(`\n  ${C.bold}${C.yellow}🔄 ffplay 备选测试命令（更快，无 UI）:${C.reset}`);
    console.log(`  ffplay -headers "Referer: ${referer}\\r\\nUser-Agent: ${ua}" "${directUrl}"`);

    console.log(`  ${C.cyan}${'─'.repeat(70)}${C.reset}`);

    // 记录到报告
    REPORT.streamUrls.push({
        label,
        lineName,
        epTitle,
        url: directUrl,
        referer,
        ua,
    });
}

// ============================================================
// 测试流程
// ============================================================
async function testHosts() {
    title('[Boot] 多域名连通性');
    const alive = [];
    for (const host of CONFIG.HOSTS) {
        const t0 = Date.now();
        const r = await http(host, { timeout: 8000 });
        const elapsed = Date.now() - t0;
        if (r.ok && r.text.length > 1000) {
            alive.push({ host, elapsed });
            log.ok(`${host} (${elapsed}ms)`);
        } else {
            log.fail(`${host} (${r.err || r.status})`);
        }
    }
    if (alive.length === 0) throw new Error('所有域名均不可用');
    alive.sort((a, b) => a.elapsed - b.elapsed);
    ACTIVE_HOST = alive[0].host;
    log.info(`选定主域名: ${ACTIVE_HOST}`);
    return alive.length;
}

async function testCatalog() {
    title('[Catalog] 分类页列表解析');
    const results = {};
    for (const cat of CONFIG.CATEGORIES) {
        const r = await httpHost(`/vodtype/${cat.tid}.html`);
        if (!r.ok) {
            log.fail(`${cat.label} (HTTP 失败)`);
            results[cat.tid] = { ok: false, count: 0, sample: null };
            continue;
        }
        const items = parseVideoList(r.text);
        if (items.length === 0) {
            log.fail(`${cat.label} (解析出 0 条)`);
            results[cat.tid] = { ok: false, count: 0, sample: null };
            continue;
        }
        log.ok(`${cat.label}: ${items.length} 部`);
        results[cat.tid] = { ok: true, count: items.length, sample: items[0] };
    }
    return results;
}

async function testSearch() {
    title('[Search] RSS 搜索解析');
    const results = {};
    for (const t of CONFIG.SEARCH_KEYWORDS) {
        const r = await httpHost(`/rss.xml?wd=${encodeURIComponent(t.keyword)}`);
        if (!r.ok) {
            log.fail(`${t.label} "${t.keyword}" (HTTP 失败)`);
            results[t.keyword] = { ok: false, count: 0 };
            continue;
        }
        const items = parseRss(r.text);
        log.ok(`${t.label} "${t.keyword}": ${items.length} 条`);
        results[t.keyword] = { ok: true, count: items.length, sample: items[0] };
    }
    return results;
}

async function testDetail(catalogResults) {
    title('[Meta] 详情页元数据 + 剧集列表');
    const targets = [];
    if (catalogResults['1'] && catalogResults['1'].ok) targets.push({ vid: catalogResults['1'].sample.vid, label: '电影' });
    if (catalogResults['2'] && catalogResults['2'].ok) targets.push({ vid: catalogResults['2'].sample.vid, label: '剧集' });

    const results = {};
    for (const t of targets) {
        const r = await httpHost(`/voddetail/${t.vid}.html`);
        if (!r.ok) {
            log.fail(`${t.label} (HTTP 失败)`);
            results[t.vid] = { ok: false };
            continue;
        }
        const d = parseDetail(r.text, t.vid);
        const checks = {
            name: !!d.name,
            pic: !!d.pic,
            desc: d.desc.length > 10,
            lines: d.lines.length > 0,
        };
        const passCount = Object.values(checks).filter(Boolean).length;
        if (passCount === Object.keys(checks).length) {
            log.ok(`${t.label} "${d.name}" ${d.isMovie ? '(电影)' : `(剧集 ${d.lines.length} 线路)`}`);
        } else {
            log.warn(`${t.label} "${d.name}" ${passCount}/${Object.keys(checks).length} 字段`);
        }
        results[t.vid] = { ok: true, detail: d, label: t.label };
    }
    return results;
}

async function testStream(detailResults) {
    title('[Stream] 播放页直链 + 真实 M3U8 可播性');

    const streamResults = {};

    for (const [vid, r] of Object.entries(detailResults)) {
        if (!r.ok) continue;
        const d = r.detail;
        if (d.lines.length === 0) {
            log.fail(`${r.label} "${d.name}" (无线路)`);
            continue;
        }

        // 尝试第一条线路第一集
        const line = d.lines[0];
        const ep = line.episodes[0];
        const playPath = `/vodplay/${ep.vid}-${ep.sid}-${ep.nid}.html`;

        console.log(`\n  ${C.dim}${r.label} "${d.name}" → ${playPath}${C.reset}`);
        const playRes = await httpHost(playPath);
        if (!playRes.ok) {
            log.fail(`播放页请求失败`);
            continue;
        }

        const directUrl = parsePlayerUrl(playRes.text);
        if (!directUrl) {
            log.fail(`直链提取失败 (${line.name} 线路)`);
            // 诊断：打印 player_data 附近的 HTML
            console.log(`  ${C.yellow}--- 播放页诊断 (${playPath}) ---${C.reset}`);
            const hasPlayerData = playRes.text.includes('player_data');
            const hasM3U8 = playRes.text.includes('.m3u8');
            const hasIframe = playRes.text.includes('<iframe');
            console.log(`    含 player_data: ${hasPlayerData}`);
            console.log(`    含 .m3u8: ${hasM3U8}`);
            console.log(`    含 iframe: ${hasIframe}`);

            // 打印 URL 相关的片段
            const urlMatches = playRes.text.match(/"url[^"]*"\s*:\s*"[^"]+"/g);
            if (urlMatches) {
                console.log(`    找到 url 字段:`);
                urlMatches.slice(0, 3).forEach(u => console.log(`      ${u.substring(0, 150)}`));
            }
            const m3u8Matches = playRes.text.match(/https?:\/\/[^"'\s>]+\.m3u8[^"'\s>]*/g);
            if (m3u8Matches) {
                console.log(`    找到 m3u8 链接:`);
                m3u8Matches.slice(0, 3).forEach(u => console.log(`      ${u.substring(0, 120)}`));
            }
            continue;
        }

        // ========================================================
        // ✅ 关键：完整输出 URL + 测试命令
        // ========================================================
        printStreamFull(
            `${r.label} "${d.name}" → ${line.name} · ${ep.title}`,
            directUrl,
            playRes.host,
            ep.title,
            line.name
        );

        // ========================================================
        // 用系统 curl 测试 M3U8 可播性
        // ========================================================
        console.log(`  ${C.blue}ℹ️${C.reset}  测试 M3U8 (系统 curl)...`);

        const curlResult = curlTest(directUrl, playRes.host);
        if (!curlResult.ok) {
            log.warn(`curl 失败: ${curlResult.err}`);
            streamResults[vid] = { ok: false, url: directUrl, err: curlResult.err };
            continue;
        }

        console.log(`     HTTP ${curlResult.status} · ${curlResult.size} 字节 · ${curlResult.elapsed.toFixed(0)}ms`);

        if (curlResult.status === 200 && curlResult.size > 0) {
            // 拉取前 500 字节验证 M3U8 头
            const head = curlGetFirst(directUrl, playRes.host, 500);
            if (head.includes('#EXTM3U')) {
                log.ok(`M3U8 可播 ✅ (返回标准 #EXTM3U 头)`);
                streamResults[vid] = { ok: true, url: directUrl };
            } else {
                log.warn(`HTTP 200 但内容非标准 M3U8，前 100 字符: ${head.substring(0, 100)}`);
                streamResults[vid] = { ok: true, url: directUrl, warning: 'content_unknown' };
            }
        } else if (curlResult.status === 403) {
            log.fail(`HTTP 403 拒绝访问（防盗链）`);
            streamResults[vid] = { ok: false, url: directUrl, err: 'HTTP 403' };
        } else {
            log.fail(`HTTP ${curlResult.status}`);
            streamResults[vid] = { ok: false, url: directUrl, err: `HTTP ${curlResult.status}` };
        }

        // 多线路尝试：如果第一条线路失败，试试其他线路
        if (!streamResults[vid].ok && d.lines.length > 1) {
            console.log(`  ${C.yellow}尝试其他线路...${C.reset}`);
            for (let i = 1; i < d.lines.length; i++) {
                const altLine = d.lines[i];
                const altEp = altLine.episodes[0];
                const altPath = `/vodplay/${altEp.vid}-${altEp.sid}-${altEp.nid}.html`;
                const altRes = await httpHost(altPath);
                if (!altRes.ok) continue;
                const altUrl = parsePlayerUrl(altRes.text);
                if (!altUrl) {
                    console.log(`    [${altLine.name}] 直链提取失败`);
                    continue;
                }
                const altCurl = curlTest(altUrl, altRes.host);
                if (altCurl.ok && altCurl.status === 200) {
                    const altHead = curlGetFirst(altUrl, altRes.host, 500);
                    if (altHead.includes('#EXTM3U')) {
                        log.ok(`备选线路 [${altLine.name}] 可播`);
                        console.log(`     完整 URL: ${altUrl}`);
                        streamResults[vid] = { ok: true, url: altUrl, line: altLine.name };
                        REPORT.streamUrls.push({
                            label: `${r.label} "${d.name}" → ${altLine.name} · ${altEp.title} (备选)`,
                            lineName: altLine.name,
                            epTitle: altEp.title,
                            url: altUrl,
                            referer: altRes.host + '/',
                            ua: CONFIG.headers['User-Agent'],
                        });
                        break;
                    }
                } else {
                    console.log(`    [${altLine.name}] 测试失败 (HTTP ${altCurl.ok ? altCurl.status : 'ERR'})`);
                }
            }
        }
    }

    return streamResults;
}

async function testSubtitles() {
    title('[Subtitles] 字幕资源探测');
    log.info('麦田影院无独立字幕 API，m3u8 内嵌字幕由 Stremio 播放器自动加载');
    log.info('Addon 端不声明 subtitles 资源');
}

function printSummary(catalogRes, searchRes, detailRes, streamRes) {
    title('📊 汇总报告');

    const catalogOk = Object.values(catalogRes).filter(r => r.ok).length;
    const searchOk = Object.values(searchRes).filter(r => r.ok && r.count > 0).length;
    const metaOk = Object.values(detailRes).filter(r => r.ok).length;
    const streamOk = Object.values(streamRes).filter(r => r.ok).length;

    console.log(`\n${C.bold}模块就绪度：${C.reset}`);
    console.log(`  Catalog:    ${catalogOk}/${CONFIG.CATEGORIES.length} 分类`);
    console.log(`  Search:     ${searchOk}/${CONFIG.SEARCH_KEYWORDS.length} 关键词`);
    console.log(`  Meta:       ${metaOk} 样本`);
    console.log(`  Stream:     ${streamOk} 可播链接`);

    if (REPORT.streamUrls.length > 0) {
        title('📺 所有 Stream URL 汇总（可复制到 VLC 手动测试）');
        for (const s of REPORT.streamUrls) {
            console.log(`\n${C.bold}${s.label}${C.reset}`);
            console.log(`  ${C.green}${s.url}${C.reset}`);
            console.log(`  ${C.gray}Referer: ${s.referer}${C.reset}`);
        }

        console.log(`\n${C.cyan}${'─'.repeat(72)}${C.reset}`);
        console.log(`${C.bold}🎬 批量测试命令（macOS）：${C.reset}`);
        console.log(`${C.cyan}${'─'.repeat(72)}${C.reset}`);
        const vlcPath = process.platform === 'darwin' ? '/Applications/VLC.app/Contents/MacOS/VLC' : 'vlc';
        for (const s of REPORT.streamUrls) {
            console.log(`${vlcPath} --http-referrer="${s.referer}" "${s.url}"`);
        }
    }

    // 关键结论
    console.log(`\n${C.cyan}${'─'.repeat(72)}${C.reset}`);
    console.log(`${C.bold}🎯 Addon 开发关键决策：${C.reset}`);
    console.log(`${C.cyan}${'─'.repeat(72)}${C.reset}`);
    console.log(`1. 播放流必带 proxyHeaders + notWebReady=true`);
    console.log(`2. videos[].id 格式: mtyy_{vid}:{sid}:{nid}`);
    console.log(`3. 搜索走 RSS（/rss.xml?wd={kw}），不用网页搜索`);
    console.log(`4. Catalog 不要 skip 参数（分页无效）`);
    console.log(`5. Stream 的 headers 必须包含 Referer 和 User-Agent`);
    console.log(`6. 多域名容灾：${CONFIG.HOSTS.length} 个备选，运行时自动切换`);
}

// 将报告写入文件便于复制
function writeReport() {
    const reportPath = path.join(process.cwd(), 'probe-report.txt');
    fs.writeFileSync(reportPath, REPORT.lines.join('\n') + '\n\n=== STREAM URLS ===\n' +
        REPORT.streamUrls.map(s =>
            `\n[${s.label}]\nURL: ${s.url}\nReferer: ${s.referer}\nUA: ${s.ua}`
        ).join('\n')
    );
    console.log(`\n${C.cyan}📄 报告已写入: ${reportPath}${C.reset}`);
}

// ============================================================
// 主入口
// ============================================================
async function main() {
    console.clear();
    title('🎬 麦田影院 · Stremio Addon 底层接口完整测试 v6.2');
    console.log(`开始时间: ${new Date().toISOString()}`);
    console.log(`平台: ${process.platform}\n`);

    const startTime = Date.now();

    try {
        await testHosts();
        const catalogRes = await testCatalog();
        const searchRes = await testSearch();
        const detailRes = await testDetail(catalogRes);
        const streamRes = await testStream(detailRes);
        await testSubtitles();
        printSummary(catalogRes, searchRes, detailRes, streamRes);
    } catch (e) {
        console.error(`\n${C.red}❌ 测试过程异常: ${e.message}${C.reset}`);
        console.error(e.stack);
        process.exit(1);
    }

    const totalTime = Date.now() - startTime;
    title(`🏁 测试完成，耗时 ${(totalTime / 1000).toFixed(1)}s`);

    writeReport();
}

main().catch((e) => {
    console.error(`\n${C.red}FATAL: ${e.message}${C.reset}`);
    console.error(e.stack);
    process.exit(1);
});