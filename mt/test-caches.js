// test-cache.js
import { withCache, cacheGet, cacheSet, negSet, negGet, getCacheStatus, TTL, prefixKey } from './src/cache.js';

// 加载 .env.local
import { readFileSync } from 'fs';
try {
    const env = readFileSync('.env.local', 'utf-8');
    env.split('\n').forEach(line => {
        const m = line.match(/^([A-Z_]+)=["']?([^"'\n]*)["']?/);
        if (m) process.env[m[1]] = m[2];
    });
} catch {}

async function test() {
    console.log('=== 缓存状态 ===');
    console.log(getCacheStatus());

    console.log('\n=== 1. 写入 + 读取 ===');
    await cacheSet('test:key1', { hello: 'world' }, 60);
    const v1 = await cacheGet('test:key1');
    console.log('读到:', v1);
    console.assert(JSON.stringify(v1) === '{"hello":"world"}', '❌ 值不匹配');
    console.log('✅ PASS');

    console.log('\n=== 2. withCache 命中 ===');
    let callCount = 0;
    const fetcher = async () => { callCount++; return { n: callCount }; };
    const r1 = await withCache('test:key2', 60, fetcher);
    const r2 = await withCache('test:key2', 60, fetcher);
    console.log('第 1 次:', r1, 'fromCache:', r1.fromCache);
    console.log('第 2 次:', r2, 'fromCache:', r2.fromCache);
    console.assert(callCount === 1, '❌ fetcher 应只调用 1 次');
    console.assert(r2.fromCache === true, '❌ 第 2 次应从缓存');
    console.log('✅ PASS');

    console.log('\n=== 3. 负缓存 ===');
    await negSet('cdn:test.example.com', TTL.NEG_CDN);
    const neg = await negGet('cdn:test.example.com');
    console.log('负缓存:', neg);
    console.assert(neg !== null, '❌ 负缓存应存在');
    console.log('✅ PASS');

    console.log('\n=== 4. 前缀验证 ===');
    console.log('prefixKey test:', prefixKey('cache', 'test:key1'));
    console.assert(prefixKey('cache', 'test:key1') === 'mtyy:dev:cache:test:key1', '❌ 前缀错误');
    console.log('✅ PASS');

    console.log('\n=== 5. Redis 真实命中 ===');
    await cacheDel('test:key3');
    const miss = await cacheGet('test:key3');
    console.log('删除后读:', miss);
    console.assert(miss === null, '❌ 删除后应为 null');
    console.log('✅ PASS');

    console.log('\n最终状态:', getCacheStatus());
}

async function cacheDel(key) {
    const { cacheDel: del } = await import('./src/cache.js');
    return del(key);
}

test().catch(e => {
    console.error('❌ 测试失败:', e.message);
    console.error(e.stack);
    process.exit(1);
});