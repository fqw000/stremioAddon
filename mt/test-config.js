// test-config.js
import { mergeConfig, extractUserConfig } from './src/config.js';

function b64url(obj) {
    const str = JSON.stringify(obj);
    // 模拟 Edge 环境的 btoa
    return Buffer.from(str).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

console.log('=== 测试 1：空配置（全默认）===');
const c1 = mergeConfig({}, { TMDB_API_KEY: 'env_key' });
console.log(c1);
console.assert(c1.cats.length === 5, '默认 5 个');
console.assert(c1.tmdbKey === 'env_key', '读 env');
console.assert(c1.isCustom === false, '非自定义');
console.log('✅ PASS\n');

console.log('=== 测试 2：用户只勾选 movie + series ===');
const c2 = mergeConfig({ cats: ['movie', 'series'] }, {});
console.log(c2);
console.assert(JSON.stringify(c2.cats) === '["movie","series"]', '2 个');
console.assert(c2.isCustom === true, '自定义');
console.log('✅ PASS\n');

console.log('=== 测试 3：用户传非法 cat ===');
const c3 = mergeConfig({ cats: ['movie', 'hack'] }, {});
console.log(c3);
console.assert(JSON.stringify(c3.cats) === '["movie"]', '过滤非法值');
console.log('✅ PASS\n');

console.log('=== 测试 4：用户覆盖 TMDB Key ===');
const c4 = mergeConfig({ tk: 'user_key' }, { TMDB_API_KEY: 'env_key' });
console.log(c4);
console.assert(c4.tmdbKey === 'user_key', '用户覆盖 env');
console.log('✅ PASS\n');

console.log('=== 测试 5：用户禁用 NBY（lines 黑名单）===');
const c5 = mergeConfig({ lines: ['4'] }, {});
console.log(c5);
console.assert(c5.lineBlacklist.includes('4'), 'sid 4 黑名单');
console.log('✅ PASS\n');

console.log('=== 测试 6：完整 URL 解码 ===');
const encoded = b64url({ cats: ['movie'], tk: 'abc' });
const url = new URL(`http://x/?cfg=${encoded}`);
const decoded = extractUserConfig(url);
console.log(decoded);
console.assert(JSON.stringify(decoded.cats) === '["movie"]', '解码正常');
console.log('✅ PASS\n');

console.log('全部测试通过');