// cdn-check.js
const { spawnSync } = require('child_process');

const CDN = 'vodcnd11.myqqdd.com';

function run(cmd, args) {
    const r = spawnSync(cmd, args, { timeout: 10000 });
    return { stdout: (r.stdout || '').toString().trim(), status: r.status, error: (r.stderr || '').toString().trim() };
}

console.log('=== 1. DNS 解析 ===');
const dns = run('dig', ['+short', CDN]);
console.log(dns.stdout || '(无结果)');

console.log('\n=== 2. Ping（可能被禁 ICMP）===');
const ping = run('ping', ['-c', '2', '-W', '3', CDN]);
console.log(ping.stdout.split('\n').slice(0, 5).join('\n'));

console.log('\n=== 3. TCP 443 连接（10s 超时）===');
const tcp = run('nc', ['-zv', '-w', '5', CDN, '443']);
console.log(tcp.stdout, tcp.error);

console.log('\n=== 4. TLS 握手（curl -v）===');
const tls = run('curl', ['-sv', '--max-time', '8', '-o', '/dev/null', `https://${CDN}/`]);
console.log(tls.error.split('\n').filter(l => l.includes('SSL') || l.includes('TLS') || l.includes('error')).slice(0, 5).join('\n'));

console.log('\n=== 5. 换一个 CDN 域名测试 ===');
// 麦田其他 CDN 域名
const altCdns = [
    'vodcnd1.myqqdd.com',
    'vodcnd10.myqqdd.com',
    'vodcnd11.myqqdd.com',
];
for (const c of altCdns) {
    const r = run('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', `https://${c}/`]);
    console.log(`  ${c} → ${r.stdout || 'ERR'}`);
}