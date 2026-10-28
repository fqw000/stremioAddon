/**
 * 麦田影院 · HTML 结构原始 dump
 * 
 * 输出：
 *   - 终端：关键区域片段
 *   - 文件：catalog-movie.html / detail-movie.html / detail-series.html
 */

"use strict";
const fs = require('fs');

const HOST = 'https://mtyy5.com';
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "text/html,application/xml;q=0.9,*/*;q=0.8",
    "Referer": HOST + "/"
};

async function fetchHtml(path) {
    const res = await fetch(HOST + path, { headers: HEADERS });
    return { status: res.status, html: await res.text() };
}

function save(name, html) {
    const file = `./dump-${name}.html`;
    fs.writeFileSync(file, html, 'utf-8');
    console.log(`  💾 已保存: ${file} (${html.length} 字符)`);
}

// 在 HTML 中定位关键片段（前后 N 字符）
function showAround(html, keyword, before = 200, after = 800, label = '') {
    const idx = html.indexOf(keyword);
    if (idx < 0) {
        console.log(`  ❌ 未找到关键字 "${keyword}"`);
        return;
    }
    const start = Math.max(0, idx - before);
    const end = Math.min(html.length, idx + after);
    console.log(`\n  📍 [${label || keyword}] @ 索引 ${idx}`);
    console.log('  ' + '─'.repeat(70));
    console.log(html.slice(start, end).replace(/></g, '>\n<'));
    console.log('  ' + '─'.repeat(70));
}

// 从任意 HTML 中提取第一个 voddetail 链接附近的完整 a 标签
function showFirstVideoCard(html, label) {
    const idx = html.search(/<a[^>]+href="[^"]*\/voddetail\//);
    if (idx < 0) {
        console.log(`  ❌ [${label}] 未找到 voddetail 链接`);
        return;
    }
    // 找到对应的 </a>
    const endIdx = html.indexOf('</a>', idx);
    const card = html.slice(idx, endIdx + 4);
    console.log(`\n  📍 [${label}] 首个影片卡片完整 HTML:`);
    console.log('  ' + '─'.repeat(70));
    console.log(card.replace(/></g, '>\n<'));
    console.log('  ' + '─'.repeat(70));
}

(async () => {
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  麦田影院 · HTML 原始结构 dump');
    console.log('══════════════════════════════════════════════════════════════');

    // ============================================
    // 1. 分类页（电影）
    // ============================================
    console.log('\n📂 [1] 抓取分类页 /vodtype/1.html (电影)');
    const cat = await fetchHtml('/vodtype/1.html');
    console.log(`  HTTP ${cat.status}, ${cat.html.length} 字符`);
    save('catalog-movie', cat.html);

    // 打印首个影片卡片完整结构
    showFirstVideoCard(cat.html, '分类页 - 影片卡片');

    // ============================================
    // 2. 详情页（电影 230035）
    // ============================================
    const movieVid = '230035';
    console.log(`\n🎬 [2] 抓取电影详情页 /voddetail/${movieVid}.html`);
    const movieDetail = await fetchHtml(`/voddetail/${movieVid}.html`);
    console.log(`  HTTP ${movieDetail.status}, ${movieDetail.html.length} 字符`);
    save('detail-movie', movieDetail.html);

    // 打印含 "简介"/"剧情" 的上下文
    for (const kw of ['简介', '剧情', 'vod_content', 'class="content']) {
        showAround(movieDetail.html, kw, 100, 600, `电影 - "${kw}"`);
    }

    // ============================================
    // 3. 详情页（剧集 209361）
    // ============================================
    const seriesVid = '209361';
    console.log(`\n📺 [3] 抓取剧集详情页 /voddetail/${seriesVid}.html`);
    const seriesDetail = await fetchHtml(`/voddetail/${seriesVid}.html`);
    console.log(`  HTTP ${seriesDetail.status}, ${seriesDetail.html.length} 字符`);
    save('detail-series', seriesDetail.html);

    for (const kw of ['简介', '剧情', 'vod_content']) {
        showAround(seriesDetail.html, kw, 100, 600, `剧集 - "${kw}"`);
    }

    // ============================================
    // 4. 页脚汇总
    // ============================================
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  已保存文件:');
    console.log('    - dump-catalog-movie.html');
    console.log('    - dump-detail-movie.html');
    console.log('    - dump-detail-series.html');
    console.log('\n  请把终端输出的片段（尤其是"电影 - 简介"那一段）'); 
    console.log('  或者直接打开 dump-detail-movie.html 搜索"简介"'); 
    console.log('  把真实 HTML 结构贴给我。');
    console.log('══════════════════════════════════════════════════════════════');
})();