#!/usr/bin/env node
'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   NFB Probe · 单文件探针
   用法：
     node nfb-probe.js                                # 直连
     PROXY=http://localhost:9090 node nfb-probe.js    # 走代理
   依赖：Node 18+；走代理时需要 undici（npm i undici）
   ═══════════════════════════════════════════════════════════════════════ */

const HOSTS = {
  search:  'https://searchapi.nfb.ca',
  catalog: 'https://publicapi.nfb.ca',
  www:     'https://www.nfb.ca',
};
const CONFIG = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  release: 'nfb-probe@2.1',
  slowMs: 3000,
  captureBody: false,
};

if (process.env.PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(process.env.PROXY));
    console.log(`🔌 proxy  ${process.env.PROXY}`);
  } catch (e) {
    console.log(`⚠️  proxy  setup failed (${e.message}) → 直连`);
  }
}

// ───────────────────────────────────────────────────────────────────────
// 控制台
// ───────────────────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', gray:'\x1b[90m' };
const paint = (s, c) => process.stdout.isTTY ? c + s + C.reset : String(s);
const pad = (s, n) => String(s).padEnd(n);

function header(title) {
  const w = 64;
  console.log('\n' + paint('╭' + '─'.repeat(w) + '╮', C.gray));
  console.log(paint('│', C.gray) + ' ' + paint(pad(title, w - 2), C.bold) + ' ' + paint('│', C.gray));
  console.log(paint('╰' + '─'.repeat(w) + '╯', C.gray));
}
function kv(k, v) {
  console.log(`  ${paint(pad(k, 14), C.gray)} ${v}`);
}
function sub(label) {
  console.log(`  ${paint('· ' + label, C.dim)}`);
}

// ───────────────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────────────
let _rid = 0;
const nextId = () => `nfb-${(++_rid).toString(36)}-${Date.now().toString(36).slice(-4)}`;
const now    = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const bytes  = s => s ? new TextEncoder().encode(s).length : 0;
const tryJson = t => { try { return JSON.parse(t); } catch { return undefined; } };

const SENS_KEY = /token|password|secret|csrf|auth|cookie|session|signature|policy|key-pair/i;
const SENS_VAL = /^[A-Za-z0-9+/=._~\-]{40,}$/;
function redact(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(redact);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = SENS_KEY.test(k) ? '[REDACTED]' : redact(v[k]);
    return o;
  }
  if (typeof v === 'string' && v.length > 40 && SENS_VAL.test(v)) return `[REDACTED:${v.length}]`;
  return v;
}
function redactUrl(u) {
  try {
    const x = new URL(u);
    for (const [k, val] of x.searchParams) {
      if (SENS_KEY.test(k) || (val.length > 60 && SENS_VAL.test(val))) x.searchParams.set(k, '[REDACTED]');
    }
    return x.toString().replace(/#expires=\d+/, '#expires=⏳');
  } catch { return u; }
}
function summarize(v, d = 0, max = 3) {
  if (v === null) return { t: 'null' };
  if (Array.isArray(v)) {
    const r = { t: 'array', n: v.length };
    if (v.length && d < max) r.sample = summarize(v[0], d + 1, max);
    return r;
  }
  const t = typeof v;
  if (t === 'string') return v.length <= 40 ? { t, v } : { t, n: v.length };
  if (t !== 'object') return { t, v };
  if (d >= max) return { t: 'object', truncated: true };
  const f = {};
  for (const k of Object.keys(v).slice(0, 12)) f[k] = summarize(v[k], d + 1, max);
  return { t: 'object', n: Object.keys(v).length, f };
}

// ───────────────────────────────────────────────────────────────────────
// Schema
// ───────────────────────────────────────────────────────────────────────
const S = {
  obj: (props, opt = {}) => ({ type: 'object', props, ...opt }),
  arr: (items, opt = {}) => ({ type: 'array', items, ...opt }),
  str: (opt = {}) => ({ type: 'string', ...opt }),
  num: (opt = {}) => ({ type: 'number', ...opt }),
  bool: (opt = {}) => ({ type: 'boolean', ...opt }),
  nullable: s => ({ ...s, nullable: true }),
  any: () => ({ type: 'any' }),
};
const SCHEMA = {
  search: S.obj({
    items: S.arr(S.obj({
      slug: S.str(), title: S.str(), year: S.num(),
      thumbnail_path: S.nullable(S.str()),
      directors: S.arr(S.obj({ name: S.str() })),
    })),
    meta: S.obj({ total: S.num(), pages: S.num() }),
  }),
  catalog: S.obj({
    items: S.arr(S.obj({ slug: S.str(), title: S.str(), id: S.num() })),
    meta: S.obj({ pagination: S.obj({ total: S.num() }) }),
  }),
  jsonld: S.obj({ name: S.str() }),
  stream: S.obj({ hls: S.str() }),
};
function check(schema, data, path = '$') {
  const errs = [];
  (function walk(s, d, p) {
    if (!s) return;
    if (s.nullable && d == null) return;
    if (d === undefined) return errs.push({ code: 'missing', path: p });
    if (d === null) return errs.push({ code: 'null', path: p });
    if (s.type === 'any') return;
    if (typeof d !== s.type) return errs.push({ code: 'type', path: p, expected: s.type });
    if (s.type === 'array' && s.items) d.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
    if (s.type === 'object' && s.props)
      for (const [k, sub] of Object.entries(s.props)) walk(sub, d[k], `${p}.${k}`);
  })(schema, data, path);
  return errs;
}

// ───────────────────────────────────────────────────────────────────────
// 核心 fetch（带监控）
// ───────────────────────────────────────────────────────────────────────
const _stats = new Map();
function track(ep, r) {
  if (!_stats.has(ep)) _stats.set(ep, { n:0, ok:0, fail:0, durs:[], sizes:[], anomalies:{}, biz:{} });
  const s = _stats.get(ep);
  s.n++;
  if (r.anomaly && r.anomaly !== 'slow') s.fail++; else s.ok++;
  s.durs.push(r.dur); s.sizes.push(r.size);
  if (r.anomaly) s.anomalies[r.anomaly] = (s.anomalies[r.anomaly] || 0) + 1;
}
function mergeBiz(ep, biz) {
  const s = _stats.get(ep); if (!s) return;
  for (const [k, v] of Object.entries(biz || {})) {
    s.biz[k] = s.biz[k] || { sum: 0, n: 0 };
    s.biz[k].sum += typeof v === 'number' ? v : (v ? 1 : 0);
    s.biz[k].n++;
  }
}
function getStats() {
  const out = {};
  for (const [ep, s] of _stats) {
    const d = [...s.durs].sort((a, b) => a - b), n = d.length;
    const biz = {};
    for (const [k, v] of Object.entries(s.biz)) biz[k] = +(v.sum / Math.max(v.n, 1)).toFixed(2);
    out[ep] = {
      n: s.n, ok: s.ok, fail: s.fail,
      avg: Math.round(d.reduce((a, b) => a + b, 0) / Math.max(n, 1)),
      p50: d[Math.floor(n * 0.5)] || 0,
      p95: d[Math.floor(n * 0.95)] || 0,
      max: d[n - 1] || 0,
      avgSize: Math.round(s.sizes.reduce((a, b) => a + b, 0) / Math.max(n, 1)),
      anomalies: s.anomalies, biz,
    };
  }
  return out;
}

async function call(endpoint, url, opts = {}, schema = null) {
  const reqId = nextId();
  const start = Date.now(), t = now();
  let status = 0, ctype = '', text = '', size = 0, json, netErr = null, setCookie = '';

  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': CONFIG.ua, ...(opts.headers || {}) },
    });
    status = res.status;
    ctype = res.headers.get('content-type') || '';
    setCookie = (typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')]
    ).filter(Boolean).join('; ');
    text = await res.text();
    size = bytes(text);
    if (/json/i.test(ctype) || /^\s*[{[]/.test(text)) json = tryJson(text);
  } catch (e) {
    netErr = String(e);
  }

  const dur = Math.round(now() - t);
  const anomalies = [];
  if (netErr) anomalies.push({ code: 'network', d: netErr.slice(0, 80) });
  else if (status >= 400) anomalies.push({ code: 'http', d: `status=${status}` });
  if (dur > CONFIG.slowMs) anomalies.push({ code: 'slow', d: `${dur}ms` });
  if (json && schema) {
    const errs = check(schema, json);
    if (errs.length) anomalies.push({ code: 'schema', d: errs.slice(0, 3).map(e => `${e.path}:${e.code}`).join(','), errs });
  }
  if (json?.error) anomalies.push({ code: 'biz', d: String(json.error).slice(0, 80) });

  const rec = {
    endpoint, reqId, url: redactUrl(url), method: opts.method || 'GET',
    start, dur, status, ctype, size, setCookie,
    anomaly: anomalies[0]?.code || null, anomalies,
    summary: json !== undefined ? summarize(redact(json)) : { t: 'text', n: text.length },
    body: CONFIG.captureBody && json !== undefined ? redact(json) : undefined,
  };
  track(endpoint, rec);

  const icon = anomalies.length ? (status >= 400 || netErr ? '❌' : '⚠️ ') : '✅';
  const tail = anomalies.length ? ' · ' + anomalies.map(a => a.code).join(',') : '';
  console.log(`  ${icon} [${endpoint}] ${paint(String(status || 'ERR'), status >= 400 ? C.red : C.green)} · ${dur}ms · ${size}B${paint(tail, C.yellow)}`);

  return { rec, json, text, status, setCookie };
}

// ───────────────────────────────────────────────────────────────────────
// Stremio 映射
// ───────────────────────────────────────────────────────────────────────
function thumbPattern(meta) {
  return meta?.mixed_media?.thumbnail_url?.film
      || meta?.thumbnail_pattern
      || 'https://assets.nfbcdn.ca/medias/norman/{path}?w={width}&h={height}';
}
function thumbUrl(p, path, w = 300, h = 200) {
  if (!p || !path) return null;
  return p.replace('{path}', path).replace('{width}', w).replace('{height}', h);
}
function parseDur(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.round(v);
  const m = String(v).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (m) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  const c = String(v).match(/^PT(\d{2}):(\d{2}):(\d{2})$/i);
  if (c) return +c[1] * 3600 + +c[2] * 60 + +c[3];
  return 0;
}
function fmtDur(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}min` : `${m}min`;
}
function toPreview(item, meta) {
  const pattern = thumbPattern(meta);
  const poster = thumbUrl(pattern, item.thumbnail_path || item.thumbnail || item.jacket, 300, 200);
  const durSec = parseDur(item.time) || (typeof item.duration === 'number' ? Math.round(item.duration) : 0);
  const directors = (item.directors || [])
    .map(d => d.name || `${d.first_name || ''} ${d.last_name || ''}`.trim())
    .filter(Boolean);
  const streamable = item.is_streamable_for_free ?? item.availability?.is_public ?? true;
  const type = (item.seasons_count > 0 || item.category === 'series') ? 'series'
             : item.category === 'collection' ? 'collection' : 'movie';
  return {
    id: item.slug, type, name: item.title, poster, posterShape: 'landscape',
    description: item.description?.en || (typeof item.description === 'string' ? item.description : ''),
    releaseInfo: String(item.year || ''),
    runtime: fmtDur(durSec),
    directors,
    _p: !!poster, _r: !!durSec, _d: directors.length > 0, _s: !!streamable,
  };
}
function toDetail(jsonld, slug) {
  const poster = jsonld.image || null;
  const background = jsonld.thumbnailUrl
    ? jsonld.thumbnailUrl.split('?')[0] + '?w=1920&h=1080'
    : poster;
  const year = jsonld.uploadDate ? jsonld.uploadDate.slice(0, 4) : '';
  return {
    id: slug, type: 'movie',
    name: jsonld.name || '',
    poster, posterShape: 'poster', background,
    description: jsonld.description || '',
    releaseInfo: year, year,
    runtime: fmtDur(parseDur(jsonld.duration)),
    directors: (jsonld.director || []).map(d => d.name).filter(Boolean),
  };
}
function toStreams(data, slug) {
  if (!data) return [];
  const strip = u => u ? u.split('#')[0] : null;
  const exp = u => { const m = u && u.match(/#expires=(\d+)/); return m ? +m[1] : null; };
  const group = `nfb-${slug}`;
  const out = [];
  if (data.hls) out.push({
    url: strip(data.hls), name: 'NFB', title: 'HLS / Auto',
    behaviorHints: { bingeGroup: group }, _expires: exp(data.hls),
  });
  if (data.hls_dv) out.push({
    url: strip(data.hls_dv), name: 'NFB', title: 'HLS / Dolby Vision',
    behaviorHints: { bingeGroup: group }, _expires: exp(data.hls_dv),
  });
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// 端点
// ───────────────────────────────────────────────────────────────────────
async function search({ q, page = 1, perPage = 10, sortBy = 'relevance', orderBy = 'desc', safeSearch = false, include = 'description' } = {}) {
  if (!q) throw new Error('search: q required');
  const sp = new URLSearchParams({
    q, per_page: String(perPage), page: String(page),
    sort_by: sortBy, order_by: orderBy, safe_search: String(safeSearch), include,
  });
  return call('search', `${HOSTS.search}/api/search/v4/films/?${sp}`,
    { headers: { Accept: 'application/json' } }, SCHEMA.search);
}
async function catalog({ locale = 'en', size = 20, page = 1, includeSeriesEpisodes = true } = {}) {
  const fields = ['slug','duration','year','thumbnail','directors','cc','dv','rating',
    'coming_soon','is_new_release','leaving_soon','availability','geoblocked','producers',
    'year_max','year_min','seasons_count','episodes_count','cataloging_language',
    'story_art_horizontal','jacket','category'];
  const sp = new URLSearchParams({
    locale, size: String(size), page: String(page),
    include_series_episodes: String(includeSeriesEpisodes),
  });
  for (const f of fields) sp.append('include_fields', f);   // 必须 append
  return call('catalog', `${HOSTS.catalog}/api/v5/works?${sp}`,
    { headers: { Accept: 'application/json' } }, SCHEMA.catalog);
}
async function meta(slug) {
  const url = `${HOSTS.www}/film/${slug}/`;
  const r = await call('meta', url,
    { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } }, null);
  let jsonld = null;
  if (r.text) {
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(r.text))) {
      const o = tryJson(m[1]);
      if (!o) continue;
      const t = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
      if (t.some(x => x === 'Movie' || x === 'VideoObject')) { jsonld = o; break; }
    }
  }
  if (jsonld) {
    const errs = check(SCHEMA.jsonld, jsonld);
    if (errs.length) {
      r.rec.anomalies.push({ code: 'schema', d: 'jsonld', errs });
      r.rec.anomaly = r.rec.anomaly || 'schema';
    }
  }
  return { ...r, jsonld };
}
async function stream(slug, { csrfToken, cookie } = {}) {
  const url = `${HOSTS.www}/api/v4/films/${slug}/stream`;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: `${HOSTS.www}/film/${slug}/`,
  };
  if (csrfToken) headers['X-CSRFToken'] = csrfToken;
  if (cookie) headers['Cookie'] = cookie;
  return call('stream', url, { headers }, SCHEMA.stream);
}

// ───────────────────────────────────────────────────────────────────────
// 演示主流程
// ───────────────────────────────────────────────────────────────────────
async function main() {
  header('🚀 NFB Probe  ·  单文件  ·  Stremio Addon 数据体检');
  kv('release', CONFIG.release);
  kv('node', process.version);
  kv('proxy', process.env.PROXY || '直连');

  // ① search
  header('🎬 1/5  search  ·  q=children, perPage=3');
  const s = await search({ q: 'children', perPage: 3 });
  if (s.json?.items?.length) {
    const pv = s.json.items.map(it => toPreview(it, s.json.meta));
    mergeBiz('search', {
      streamable: pv.filter(p => p._s).length / pv.length,
      poster:     pv.filter(p => p._p).length / pv.length,
      runtime:    pv.filter(p => p._r).length / pv.length,
      director:   pv.filter(p => p._d).length / pv.length,
    });
    kv('total', s.json.meta.total);
    kv('pages', s.json.meta.pages);
    sub('previews');
    for (const p of pv) {
      const pIcon = p._p ? '🖼' : '▫️';
      const rTxt = p._r ? `⏱ ${p.runtime}` : '⏱ —';
      const dTxt = p._d ? `👤 ${p.directors.join(', ')}` : '👤 —';
      console.log(`    ${pIcon} ${pad(p.id, 26)} ${pad(p.type, 8)} ${pad(p.name, 22)} ${pad(rTxt, 16)} ${dTxt}`);
    }
  }

  // ② catalog
  header('📚 2/5  catalog  ·  size=3, page=1  (验证 include_fields 多值)');
  const c = await catalog({ size: 3, page: 1 });
  if (c.json?.items?.length) {
    const pv = c.json.items.map(it => toPreview(it, c.json.meta));
    mergeBiz('catalog', {
      poster:  pv.filter(p => p._p).length / pv.length,
      runtime: pv.filter(p => p._r).length / pv.length,
      director:pv.filter(p => p._d).length / pv.length,
      movie:   pv.filter(p => p.type === 'movie').length / pv.length,
      series:  pv.filter(p => p.type === 'series').length / pv.length,
    });
    kv('total', c.json.meta?.pagination?.total);
    kv('pages', c.json.meta?.pagination?.pages);
    kv('fields.ok', `directors=${Array.isArray(c.json.items[0].directors)} availability=${!!c.json.items[0].availability}`);
    sub('previews');
    for (const p of pv) {
      const pIcon = p._p ? '🖼' : '▫️';
      const rTxt = p._r ? `⏱ ${p.runtime}` : '⏱ —';
      console.log(`    ${pIcon} ${pad(p.id, 26)} ${pad(p.type, 11)} ${pad(p.name, 20)} ${rTxt}`);
    }
  }

  // ③ meta
  const slug = 'bread-will-walk';
  header(`📄 3/5  meta  ·  ${slug}`);
  const m = await meta(slug);
  const csrf = (m.setCookie || '').match(/csrftoken=([^;]+)/)?.[1];
  kv('jsonld', m.jsonld ? `✅ found · @type=${[].concat(m.jsonld['@type']).join('/')}` : '❌ not found');
  kv('csrf', csrf ? `✅ csrftoken captured` : '⚠️  not captured');
  if (m.jsonld) {
    const det = toDetail(m.jsonld, slug);
    mergeBiz('meta', {
      poster: det.poster ? 1 : 0,
      background: det.background ? 1 : 0,
      runtime: det.runtime ? 1 : 0,
      director: det.directors.length ? 1 : 0,
      year: det.year ? 1 : 0,
    });
    sub('Stremio MetaDetail');
    kv('id', det.id);
    kv('type', det.type);
    kv('name', det.name);
    kv('poster', det.poster ? `✅ ${det.poster.slice(0, 70)}…` : '❌');
    kv('posterShape', det.posterShape);
    kv('background', det.background ? `✅ ${det.background.slice(0, 70)}…` : '❌');
    kv('runtime', det.runtime || '—');
    kv('releaseInfo', det.releaseInfo || '—');
    kv('directors', det.directors.join(', ') || '—');
  }

  // ④ stream
  header(`▶️  4/5  stream  ·  ${slug}`);
  const st = await stream(slug, { csrfToken: csrf, cookie: csrf ? `csrftoken=${csrf}` : undefined });
  if (st.json) {
    const streams = toStreams(st.json, slug);
    const exp = streams[0]?._expires;
    const expIn = exp ? Math.round((exp * 1000 - Date.now()) / 1000) : null;
    mergeBiz('stream', {
      hls: st.json.hls ? 1 : 0,
      dv:  st.json.hls_dv ? 1 : 0,
      warnings: (st.json.trigger_warnings || []).length ? 1 : 0,
    });
    kv('hls', st.json.hls ? '✅' : '❌');
    kv('dv',  st.json.hls_dv ? '✅' : '❌');
    kv('expires', expIn != null ? `+${Math.floor(expIn / 3600)}h ${Math.floor((expIn % 3600) / 60)}min` : '—');
    sub('Stremio Stream[]');
    for (const s of streams) console.log(`    🔗 ${pad(s.title, 20)} ${s.url.slice(0, 72)}…`);
  }

  // ⑤ stats
  header('📊 5/5  getStats()  ·  各接口健康度');
  const stats = getStats();
  for (const [ep, s] of Object.entries(stats)) {
    const icon = s.fail ? '⚠️ ' : '✅';
    console.log(`\n  ${icon} ${paint(ep.toUpperCase(), C.bold)}  n=${s.n} ok=${s.ok} fail=${s.fail}`);
    kv('latency', `avg=${s.avg}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms`);
    kv('size', `avg=${s.avgSize}B`);
    const aKeys = Object.keys(s.anomalies);
    if (aKeys.length) kv('anomaly', paint(JSON.stringify(s.anomalies), C.yellow));
    const bKeys = Object.keys(s.biz);
    if (bKeys.length) {
      sub('biz');
      for (const [k, v] of Object.entries(s.biz)) {
        const n = Math.max(0, Math.min(10, Math.round(v * 10)));
        const bar = '█'.repeat(n) + '░'.repeat(10 - n);
        console.log(`      ${pad(k, 12)} ${bar} ${String((v * 100).toFixed(0)).padStart(3)}%`);
      }
    }
  }
  console.log('\n' + paint('✨ done', C.green) + '\n');
}

if (require.main === module) main().catch(e => { console.error('💥', e); process.exit(1); });

module.exports = { search, catalog, meta, stream, toPreview, toDetail, toStreams, getStats };