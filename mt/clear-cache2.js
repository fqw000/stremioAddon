/**
 * 清理 Redis 缓存
 * 
 * 用法：
 *   node scripts/clear-cache.js --all
 *   node scripts/clear-cache.js tt0109830
 */

import { readFileSync } from 'fs';

try {
    const env = readFileSync('.env.local', 'utf-8');
    env.split('\n').forEach(line => {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=["']?([^"'\n]*)["']?/);
        if (m) process.env[m[1]] = m[2];
    });
} catch (e) {
    console.error('❌ 无法读取 .env.local:', e.message);
    process.exit(1);
}

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = process.env.APP_PREFIX || 'mtyy:dev';

if (!URL_BASE || !TOKEN) {
    console.error('❌ 缺少 UPSTASH 环境变量');
    process.exit(1);
}

async function redis(commands) {
    const res = await fetch(URL_BASE + '/pipeline', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
    });
    return await res.json();
}

async function scanAndDelete(pattern) {
    let cursor = '0';
    let total = 0;
    do {
        const res = await redis([['SCAN', cursor, 'MATCH', pattern, 'COUNT', '100']]);
        const [next, keys] = res[0].result;
        cursor = next;
        if (keys.length > 0) {
            await redis(keys.map(k => ['DEL', k]));
            total += keys.length;
        }
    } while (cursor !== '0');
    return total;
}

async function main() {
    const arg = process.argv[2];
    let patterns;

    if (arg === '--all') {
        patterns = [`${PREFIX}:cache:*`, `${PREFIX}:neg:*`];
    } else if (arg && arg.startsWith('tt')) {
        patterns = [
            `${PREFIX}:cache:tt_map:${arg}:*`,
            `${PREFIX}:cache:neg:tt_fail:${arg}:*`,
        ];
    } else if (arg) {
        patterns = [`${PREFIX}:cache:${arg}*`, `${PREFIX}:neg:${arg}*`];
    } else {
        patterns = [
            `${PREFIX}:cache:tt_map:*`,
            `${PREFIX}:cache:neg:tt_fail:*`,
            `${PREFIX}:cache:stream:*`,
            `${PREFIX}:neg:stream:*`,
            `${PREFIX}:cache:catalog:*`,
            `${PREFIX}:cache:search:*`,
            `${PREFIX}:cache:meta:*`,
            `${PREFIX}:neg:meta:*`,
        ];
    }

    let total = 0;
    for (const p of patterns) {
        console.log(`扫描: ${p}`);
        total += await scanAndDelete(p);
    }
    console.log(`\n✅ 共删除 ${total} 个 key`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });