#!/usr/bin/env node
'use strict';

const HOSTS = {
  search:  'https://searchapi.nfb.ca',
  catalog: 'https://publicapi.nfb.ca',
  www:     'https://www.nfb.ca',
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const SLUG = 'bread-will-walk';

async function fetchText(url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, dur: Date.now() - t0, setCookie: res.headers.get('set-cookie') || '' };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e), dur: Date.now() - t0 };
  }
}

function tryJson(t) { try { return JSON.parse(t); } catch { return undefined; } }

// 从 HTML 抽 JSON-LD（meta 用）
function extractJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const o = JSON.parse(m[1]);
      const types = [].concat(o['@type']);
      if (types.some(x => x === 'Movie' || x === 'VideoObject')) return o;
    } catch {}
  }
  return null;
}

// 结构指纹：忽略动态字段（时间戳、签名、expires），只比较"形状"
function fingerprint(obj, depth = 0) {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) return obj.length ? `[${fingerprint(obj[0], depth + 1)}]` : '[]';
  const t = typeof obj;
  if (t !== 'object') return t;
  if (depth > 3) return '{…}';
  return '{' + Object.keys(obj).sort().map(k => `${k}:${fingerprint(obj[k], depth + 1)}`).join(',') + '}';
}

// 忽略动态值的对比（stream 的签名 URL、meta 的 csrf 每次不同）
function stableEqual(a, b, ignoreKeys = []) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a == b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => stableEqual(x, b[i], ignoreKeys));
  }
  const ka = Object.keys(a).filter(k => !ignoreKeys.includes(k));
  const kb = Object.keys(b).filter(k => !ignoreKeys.includes(k));
  if (ka.length !== kb.length) return false;
  return ka.every(k => stableEqual(a[k], b[k], ignoreKeys));
}

async function compare(name, url, optsA = {}, optsB = {}) {
  console.log(`\n── ${name} ─────────────────────────────────────`);
  console.log(`  URL  ${url.slice(0, 100)}${url.length > 100 ? '…' : ''}`);

  const [A, B] = await Promise.all([
    fetchText(url, optsA.headers),
    fetchText(url, optsB.headers),
  ]);

  const row = (label, a, b) =>
    console.log(`  ${label.padEnd(14)} ${String(a).padEnd(22)} ${String(b)}`);
  row('status', A.status, B.status);
  row('duration', `${A.dur}ms`, `${B.dur}ms`);
  row('size', `${A.text.length}B`, `${B.text.length}B`);

  // 业务等价性判断
  let verdict, detail = '';

  if (A.status !== B.status) {
    verdict = '❌ 状态码不同';
  } else if (name === 'meta') {
    const ja = extractJsonLd(A.text), jb = extractJsonLd(B.text);
    if (!ja && !jb) verdict = '⚠️ 两边都无 JSON-LD';
    else if (!ja || !jb) verdict = '❌ 一方缺 JSON-LD';
    else {
      const same = stableEqual(ja, jb);
      verdict = same ? '✅ JSON-LD 等价' : '⚠️ JSON-LD 字段有差异';
      detail = `name=${ja.name} duration=${ja.duration}`;
    }
  } else if (name === 'stream') {
    const ja = tryJson(A.text), jb = tryJson(B.text);
    if (!ja || !jb) verdict = '❌ 一方非 JSON';
    else {
      // 签名/expires 每次不同，只比结构
      const sameStruct = fingerprint(ja) === fingerprint(jb);
      const bothHaveHls = !!ja.hls && !!jb.hls;
      verdict = bothHaveHls ? '✅ 均含 hls' : '❌ 缺 hls';
      if (!sameStruct) detail = '结构略有差异（正常，签名动态）';
    }
  } else {
    const ja = tryJson(A.text), jb = tryJson(B.text);
    if (!ja || !jb) verdict = '⚠️ 一方非 JSON';
    else {
      const same = stableEqual(ja, jb);
      verdict = same ? '✅ 响应体等价' : '⚠️ 字段有差异';
    }
  }

  console.log(`  ${'verdict'.padEnd(14)} ${verdict}${detail ? '  · ' + detail : ''}`);
  if (A.setCookie) console.log(`  A set-cookie   ${A.setCookie.slice(0, 60)}…`);
  if (B.setCookie) console.log(`  B set-cookie   ${B.setCookie.slice(0, 60)}…`);

  return { A, B, verdict };
}

(async () => {
  console.log('🧪 NFB 接口对比测试：仅 UA  vs  完整头');

  // 先拿 csrf，供 B 组 stream 用
  const metaB = await fetchText(`${HOSTS.www}/film/${SLUG}/`, {
    Accept: 'text/html',
  });
  const csrf = (metaB.setCookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  console.log(`\n🔑 csrf captured: ${csrf ? csrf.slice(0, 12) + '…' : '❌ none'}`);

  // ① search
  await compare('search',
    `${HOSTS.search}/api/search/v4/films/?q=children&per_page=3`,
    { headers: { Accept: 'application/json' } },
    { headers: { Accept: 'application/json, text/plain, */*' } },
  );

  // ② catalog
  const catalogUrl = `${HOSTS.catalog}/api/v5/works?locale=en&size=3&page=1&include_series_episodes=true` +
    ['slug', 'duration', 'year', 'thumbnail', 'directors', 'availability']
      .map(f => `&include_fields=${f}`).join('');
  await compare('catalog', catalogUrl,
    { headers: { Accept: 'application/json' } },
    { headers: { Accept: 'application/json, text/plain, */*' } },
  );

  // ③ meta
  await compare('meta', `${HOSTS.www}/film/${SLUG}/`,
    { headers: { Accept: 'text/html' } },
    { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } },
  );

  // ④ stream
  const streamUrl = `${HOSTS.www}/api/v4/films/${SLUG}/stream`;
  const bHeaders = {
    Accept: 'application/json, text/plain, */*',
    Referer: `${HOSTS.www}/film/${SLUG}/`,
  };
  if (csrf) {
    bHeaders['X-CSRFToken'] = csrf;
    bHeaders['Cookie'] = `csrftoken=${csrf}`;
  }
  await compare('stream', streamUrl,
    { headers: { Accept: 'application/json' } },
    { headers: bHeaders },
  );

  console.log('\n✨ done');
})();