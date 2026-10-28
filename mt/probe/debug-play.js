/**
 * 独立排障脚本：暴力扒出播放页里的 m3u8 上下文
 */
const URL = 'https://mtyy5.com/vodplay/6409-1-1.html';

(async () => {
    console.log('正在请求:', URL);
    
    const res = await fetch(URL, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Referer': 'https://mtyy5.com/'
        }
    });
    
    const html = await res.text();
    
    console.log('\n=== 基本信息 ===');
    console.log('HTTP 状态:', res.status);
    console.log('HTML 总长度:', html.length, '字符');
    console.log('是否包含 ".m3u8":', html.includes('.m3u8'));
    console.log('是否包含 "player_aaaa":', html.includes('player_aaaa'));
    console.log('是否包含 "player_data":', html.includes('player_data'));
    console.log('是否包含 "url_next":', html.includes('url_next'));

    // 1. 暴力寻找所有 .m3u8 的位置
    console.log('\n=== 所有 ".m3u8" 出现位置 (前后 300 字符) ===');
    let idx = -1;
    let count = 0;
    while ((idx = html.indexOf('.m3u8', idx + 1)) !== -1 && count < 10) {
        count++;
        const start = Math.max(0, idx - 300);
        const end = Math.min(html.length, idx + 300);
        const snippet = html.substring(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' ');
        console.log(`\n--- 位置 ${count} (索引 ${idx}) ---`);
        console.log(snippet);
    }
    if (count === 0) {
        console.log('未找到 .m3u8');
    }

    // 2. 暴力寻找所有 script 标签内的内容
    console.log('\n=== 包含 "player" 或 "url" 的 <script> 块 ===');
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let sm;
    let scriptCount = 0;
    while ((sm = scriptRegex.exec(html)) !== null) {
        const content = sm[1];
        if (content.includes('player') || content.includes('url') || content.includes('m3u8')) {
            scriptCount++;
            if (scriptCount > 5) break; // 最多看 5 个
            console.log(`\n--- Script 块 ${scriptCount} (前 1000 字符) ---`);
            console.log(content.substring(0, 1000).replace(/\n/g, ' '));
        }
    }

    // 3. 如果有 playerconfig.js，扒出来看看
    console.log('\n=== playerconfig.js 内容 (前 2000 字符) ===');
    const jsUrl = 'https://mtyy5.com/static/js/playerconfig.js?t=20261028';
    try {
        const jsRes = await fetch(jsUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const jsText = await jsRes.text();
        console.log(jsText.substring(0, 2000));
    } catch (e) {
        console.log('请求 playerconfig.js 失败:', e.message);
    }
})();