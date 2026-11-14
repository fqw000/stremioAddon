// run.js
'use strict';

// ── 1) 代理：只有需要时才启用（默认注入到全局 fetch）
try {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new ProxyAgent('http://localhost:9090'));
  console.log('[proxy] http://localhost:9090');
} catch {
  console.warn('[proxy] undici 未安装，直连');
}

const NFB = require('./nfb-probe');

// ── 2) 配置：上报打印 + 超时阈值
NFB.configure({
  release: 'nfb-probe-local@0.1.0',
  slowThresholdMs: 3000,
  captureBody: false,
  reportHook: r => {
    const ok = r.anomaly ? `⚠ ${r.anomaly}(${r.anomalyDetail || ''})` : '✓';
    console.log(`  [${r.endpoint}] ${ok} ${r.httpStatus} ${r.duration}ms ${r.responseSize}B`);
  },
});

(async () => {
  const step = t => console.log(`\n=== ${t} ===`);

  // ── search
  step('1) search: q=children, perPage=3');
  const s = await NFB.search({ q: 'children', perPage: 3 });
  if (!s.json) return console.error('search failed:', s.record);
  console.log('  items:', s.json.items.length, '/ total:', s.json.meta.total, '/ pages:', s.json.meta.pages);
  console.log('  biz:', s.record.biz);
  console.log('  previews:',
    NFB.metaPreviewFromSearch(s.json.items, s.json.meta)
       .map(m => `${m.id} [${m.type}] ${m.name} ${m.runtime || '-'} ${m.poster ? '🖼' : '∅'}`));

  // ── catalog
  step('2) catalog: size=3, page=1（验证 include_fields 多值）');
  const c = await NFB.catalog({ size: 3, page: 1 });
  if (!c.json) return console.error('catalog failed:', c.record);
  console.log('  items:', c.json.items.length, '/ pages:', c.json.meta.pagination.pages, '/ total:', c.json.meta.pagination.total);
  console.log('  biz:', c.record.biz);
  // 检查 include_fields 是否真的生效
  console.log('  first item has directors?', Array.isArray(c.json.items[0].directors),
              '/ has availability?', !!c.json.items[0].availability);

  // ── meta
  step('3) meta: bread-will-walk');
  const slug = 'bread-will-walk';
  const m = await NFB.meta(slug);
  if (!m.movie) return console.error('meta failed:', m.record);
  console.log('  movie:', m.movie.name, '| duration:', m.movie.duration, '| uploadDate:', m.movie.uploadDate);
  console.log('  biz:', m.record.biz);
  const detail = NFB.metaDetailFromJsonLd(m.movie, slug);
  console.log('  Stremio MetaDetail:', {
    id: detail.id, type: detail.type, name: detail.name,
    poster: detail.poster, posterShape: detail.posterShape,
    background: detail.background, runtime: detail.runtime,
    releaseInfo: detail.releaseInfo, directors: detail.directors,
  });
  console.log('  setCookie contains csrftoken?', /csrftoken=/.test(m.setCookie || ''));

  // ── stream
  step('4) stream: bread-will-walk');
  const csrf = (m.setCookie || '').match(/csrftoken=([^;]+)/)?.[1];
  if (!csrf) console.warn('  ⚠ 没拿到 csrftoken，stream 可能 403');
  const st = await NFB.stream(slug, {
    csrfToken: csrf,
    cookie: csrf ? `csrftoken=${csrf}` : undefined,
  });
  if (!st.json) return console.error('stream failed:', st.record);
  console.log('  biz:', st.record.biz);
  const streams = NFB.streamsFromStream(st.json, slug);
  streams.forEach(x => console.log('  →', x.title, x.url.slice(0, 90) + '…', 'expires=', x._probe.expires));

  // ── 统计
  step('5) getStats()');
  console.log(JSON.stringify(NFB.getStats(), null, 2));
})();