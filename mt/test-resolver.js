// test-resolver.js
import { readFileSync } from 'fs';

// 1. 先读环境变量
try {
    const env = readFileSync('.env.local', 'utf-8');
    env.split('\n').forEach(line => {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=["']?([^"'\n]*)["']?/);
        if (m) process.env[m[1]] = m[2];
    });
    console.log('✅ .env.local 加载成功');
    console.log('   TMDB_API_KEY:', process.env.TMDB_API_KEY ? `✅ ${process.env.TMDB_API_KEY.slice(0, 8)}...` : '❌ 未找到');
} catch (e) {
    console.warn('❌ 无法读取 .env.local:', e.message);
    process.exit(1);
}

// 2. 关键：动态 import（此时 process.env 已经就绪）
const { resolveImdbToMtyy } = await import('./src/resolver.js');

async function test() {
    console.log('\n=== 测试 tt0109830（阿甘正传）===');
    const r1 = await resolveImdbToMtyy('tt0109830', 'movie');
    console.log('结果:', r1);

    console.log('\n=== 测试 tt0944947（权游 S01E01）===');
    const r2 = await resolveImdbToMtyy('tt0944947', 'series', 1, 1);
    console.log('结果:', r2);

    console.log('\n=== 测试不存在的 tt ===');
    const r3 = await resolveImdbToMtyy('tt9999999', 'movie');
    console.log('结果:', r3);

    console.log('\n=== 二次调用（验证缓存）===');
    const t0 = Date.now();
    const r4 = await resolveImdbToMtyy('tt0109830', 'movie');
    const elapsed = Date.now() - t0;
    console.log(`结果: ${JSON.stringify(r4)} (耗时 ${elapsed}ms)`);
    console.log('缓存生效:', elapsed < 500 ? '✅' : '❌');
}

test().catch(console.error);