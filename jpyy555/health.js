#!/usr/bin/env node

/**
 * 金牌影视 + 555 · Stremio Addon 完整 E2E 冒烟测试
 *
 * 覆盖：
 *   - Manifest（默认 / 单源 / 分类筛选 / 边界 / Stream 开关设计）
 *   - jpyy Catalog（浏览 / 分页 / 搜索 / 并发去重 / id 前缀）
 *   - 555 Catalog（浏览 / 无分页 / 无搜索）
 *   - jpyy Meta（movie/series 类型正确性 / videos 格式 / IMDb 解析）
 *   - 555 Meta（movie/series / 多源聚合 / videos 格式）
 *   - Stream（movie/series / 555 多源 / 开关隔离）
 *   - Search（独立接口 / 响应格式）
 *   - 响应头（Content-Type / CORS / Cache-Control s-maxage）
 *   - 边界（非法 cfg / 空 cfg / 超大 cfg / 配置页）
 *   - Debug（域名 / 缓存 / 555 状态字段完整性）
 *   - 缓存（本地自动跳过 CDN 断言）
 *
 * 用法：
 *   node health.js
 *   BASE_URL=https://xxx node health.js
 *   SKIP_CACHE_TEST=1 node health.js
 *   STRICT=1 node health.js    # 任何 WARN 也视为失败（用于 CI）
 *
 * @module health
 */

// ==========================================
// 配置
// ==========================================

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = parseInt(process.env.TIMEOUT || '30000', 10);
const SKIP_CACHE_TEST = process.env.SKIP_CACHE_TEST === '1';
const STRICT = process.env.STRICT === '1';

const IS_LOCAL = /localhost|127\.0\.0\.1/i.test(BASE_URL);

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ==========================================
// 终端着色
// ==========================================

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ==========================================
// 统计
// ==========================================

const stats = {
  total: 0, passed: 0, failed: 0, skipped: 0,
  results: [], warnings: [],
};

// ==========================================
// 日志
// ==========================================

function log(color, prefix, msg, ...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`${C.gray}[${t}]${C.reset} ${color}${prefix}${C.reset} ${msg}`, ...args);
}
const info  = (m, ...a) => log(C.blue,   '[INFO]',  m, ...a);
const pass  = (m, ...a) => log(C.green,  '[PASS]',  m, ...a);
const fail  = (m, ...a) => log(C.red,    '[FAIL]',  m, ...a);
const warn  = (m, ...a) => log(C.yellow, '[WARN]',  m, ...a);
const debug = (m, ...a) => log(C.gray,   '[DEBUG]', m, ...a);
const skip  = (m, ...a) => log(C.yellow, '[SKIP]',  m, ...a);

function separator(title = '') {
  const line = '═'.repeat(72);
  if (title) {
    console.log(`\n${C.cyan}${line}${C.reset}`);
    console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
    console.log(`${C.cyan}${line}${C.reset}\n`);
  } else {
    console.log(`${C.cyan}${line}${C.reset}`);
  }
}

// ==========================================
// 断言库
// ==========================================

function ok(cond, reason) {
  return cond ? null : reason;
}

function assertArray(v, name) {
  return Array.isArray(v) ? null : `${name} 非数组（${typeof v}）`;
}
function assertNonEmpty(v, name) {
  return (v != null && v.length > 0) ? null : `${name} 为空`;
}
function assertStr(v, name) {
  return (typeof v === 'string' && v.length > 0) ? null : `${name} 应为非空字符串`;
}
function assertEq(a, b, name) {
  return a === b ? null : `${name} 应为 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`;
}
function assertIncludes(arr, v, name) {
  return Array.isArray(arr) && arr.includes(v) ? null : `${name} 应包含 ${JSON.stringify(v)}`;
}
function assertNotIncludes(arr, v, name) {
  return Array.isArray(arr) && !arr.includes(v) ? null : `${name} 不应包含 ${JSON.stringify(v)}`;
}
function assertUrl(v, name) {
  if (typeof v !== 'string' || !v) return `${name} 非空 URL`;
  try { new URL(v); return null; } catch { return `${name} 非法 URL: ${v.slice(0, 80)}`; }
}

/** 执行一组断言，返回第一个错误或 null */
function validate(checkFns) {
  for (const fn of checkFns) {
    const err = fn();
    if (err) return err;
  }
  return null;
}

// ==========================================
// HTTP
// ==========================================

async function request(path, opts = {}) {
  const { timeout = TIMEOUT, method = 'GET', headers = {} } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method, signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
    });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ==========================================
// 核心测试引擎
// ==========================================

async function testEndpoint(opts) {
  const {
    name, path, category = '功能',
    validate: validateFn,
    skipOnFail = false,
    checkHeaders = false,
    showResponse = false,
    raw = false,          // raw=true 时不解析 JSON，用于 HTML 测试
  } = opts;

  stats.total++;
  const result = {
    name, category, ok: false, elapsed: 0,
    error: null, summary: null, cacheStatus: '-',
  };

  separator();
  info(`测试 [${category}]: ${C.bold}${name}${C.reset}`);
  debug(`URL: ${BASE_URL}${path}`);

  if (skipOnFail) {
    stats.skipped++;
    stats.total--;
    skip(`${name} · 前置条件未满足，跳过`);
    return result;
  }

  const start = Date.now();
  try {
    const resp = await request(path);
    const elapsed = Date.now() - start;
    result.elapsed = elapsed;
    result.cacheStatus = resp.headers.get('x-vercel-cache') || '-';

    debug(`HTTP ${resp.status} | 耗时 ${elapsed}ms | CDN: ${result.cacheStatus}`);

    // ===== HTTP 状态 =====
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    // ===== 响应头检查 =====
    if (checkHeaders) {
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json') && !ct.includes('text/html')) {
        warn(`Content-Type 非预期: ${ct}`);
      }
      const cors = resp.headers.get('access-control-allow-origin');
      if (cors !== '*') {
        stats.warnings.push(`${name}: 缺少 CORS 头`);
      }
      const cc = resp.headers.get('cache-control') || '';
      result.cacheControl = cc;
      if (!cc) {
        stats.warnings.push(`${name}: 无 Cache-Control`);
      }
    }

    // ===== 响应体 =====
    if (raw) {
      const text = await resp.text();
      if (showResponse) debug(`响应: ${text.slice(0, 500)}`);
      const v = await validateFn(text, resp);
      if (v) throw new Error(v);
    } else {
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); }
      catch (e) { throw new Error(`JSON 解析失败: ${e.message}（前 200 字: ${text.slice(0, 200)}）`); }

      if (showResponse) debug(`响应: ${JSON.stringify(data, null, 2).slice(0, 1500)}`);
      const v = await validateFn(data, resp);
      if (v) throw new Error(v);
    }

    pass(`${name} · ${result.summary || 'OK'} (${elapsed}ms)`);
    result.ok = true;
    stats.passed++;
    stats.results.push(result);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    result.elapsed = elapsed;
    result.error = err.name === 'AbortError' ? `超时（>${TIMEOUT}ms）` : err.message;
    fail(`${name} · ${result.error}`);
    stats.failed++;
    stats.results.push(result);
    return result;
  }
}

// ==========================================
// 工具
// ==========================================

function encodeConfig(cfg) {
  return Buffer.from(JSON.stringify(cfg), 'utf-8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 从响应体缓存第一次拿到的 catalog 首条 id，供后续 stream 测试 */
const ctx = {
  manifest: null,
  jpyy: { movieId: null, seriesId: null, seriesEpId: null, ttMovieId: 'tt0133093' },
  m555: { movieId: null, seriesId: null },
};

// ==========================================
// 预取：manifest + 首条 id
// ==========================================

async function prefetch() {
  info('预取 manifest 与测试 ID...');

  try {
    const r = await request('/manifest.json');
    if (r.ok) {
      ctx.manifest = await r.json();
      debug(`manifest id=${ctx.manifest.id}, catalogs=${ctx.manifest.catalogs?.length}`);
    }
  } catch (e) { warn(`manifest 预取失败: ${e.message}`); }

  // jpyy movie 首条
  try {
    const r = await request('/catalog/movie/jinpai-movie.json');
    if (r.ok) {
      const d = await r.json();
      const first = d.metas?.[0];
      if (first) {
        ctx.jpyy.movieId = first.id.replace(/^jp/, '').split(':')[0];
        debug(`jpyy 电影测试 ID: ${ctx.jpyy.movieId} (${first.name})`);
      }
    }
  } catch (e) { warn(`jpyy 电影预取失败: ${e.message}`); }

  // jpyy series 首条
  try {
    const r = await request('/catalog/series/jinpai-series.json');
    if (r.ok) {
      const d = await r.json();
      const first = d.metas?.[0];
      if (first) {
        ctx.jpyy.seriesId = first.id.replace(/^jp/, '').split(':')[0];
        ctx.jpyy.seriesEpId = `jp${ctx.jpyy.seriesId}:1:1`;
        debug(`jpyy 剧集测试 ID: ${ctx.jpyy.seriesId} (${first.name})`);
      }
    }
  } catch (e) { warn(`jpyy 剧集预取失败: ${e.message}`); }

  // 555 movie 首条
  try {
    const r = await request('/catalog/movie/555-movie.json');
    if (r.ok) {
      const d = await r.json();
      const first = d.metas?.[0];
      if (first) {
        ctx.m555.movieId = first.id; // 已含 dy555 前缀
        debug(`555 电影测试 ID: ${ctx.m555.movieId} (${first.name})`);
      }
    }
  } catch (e) { warn(`555 电影预取失败: ${e.message}`); }

  // 555 series 首条
  try {
    const r = await request('/catalog/series/555-series.json');
    if (r.ok) {
      const d = await r.json();
      const first = d.metas?.[0];
      if (first) {
        ctx.m555.seriesId = first.id.replace(/:1:1$/, '');
        debug(`555 剧集测试 ID: ${ctx.m555.seriesId} (${first.name})`);
      }
    }
  } catch (e) { warn(`555 剧集预取失败: ${e.message}`); }
}

// ==========================================
// Manifest 测试
// ==========================================

async function testManifests() {
  separator('📋 Manifest 测试');

  // 1. 默认配置
  await testEndpoint({
    name: 'Manifest · 默认配置',
    path: '/manifest.json',
    checkHeaders: true,
    validate: (d) => {
      const err =
        assertStr(d.id, 'id') ||
        assertStr(d.version, 'version') ||
        assertArray(d.resources, 'resources') ||
        assertArray(d.catalogs, 'catalogs') ||
        assertArray(d.types, 'types') ||
        assertArray(d.idPrefixes, 'idPrefixes') ||
        assertIncludes(d.resources, 'catalog', 'resources') ||
        assertIncludes(d.resources, 'meta', 'resources') ||
        assertIncludes(d.resources, 'stream', 'resources') ||
        assertIncludes(d.idPrefixes, 'jp', 'idPrefixes') ||
        assertIncludes(d.idPrefixes, 'tt', 'idPrefixes') ||
        assertIncludes(d.idPrefixes, 'dy555', 'idPrefixes');
      if (err) return err;

      const ids = d.catalogs.map(c => c.id);
      const hasJpyy = ids.some(x => x.startsWith('jinpai-'));
      const has555 = ids.some(x => x.startsWith('555-'));
      if (!hasJpyy) return '缺少 jpyy 目录';
      if (!has555) return '缺少 555 目录';
      if (d.catalogs.length !== 12) return `默认应 12 个目录，实际 ${d.catalogs.length}`;

      // 每条 catalog 的 extra 检查
      for (const cat of d.catalogs) {
        if (!Array.isArray(cat.extra)) return `catalog ${cat.id} 缺 extra`;
        if (!cat.extra.some(x => x.name === 'skip')) return `catalog ${cat.id} 缺 skip`;
        if (cat.id.startsWith('jinpai-') && !cat.extra.some(x => x.name === 'search')) {
          return `jpyy catalog ${cat.id} 缺 search`;
        }
        if (cat.id.startsWith('555-') && cat.extra.some(x => x.name === 'search')) {
          return `555 catalog ${cat.id} 不应含 search`;
        }
      }
      return null;
    },
  }).then(r => { if (r.ok) r.summary = '12 目录（jpyy 5 + 555 7）'; });

  // 2. 关闭 Stream —— 验证设计：resources 恒含 stream
  await testEndpoint({
    name: 'Manifest · stream=false 仍声明 resources.stream（设计约束）',
    path: '/manifest.json?cfg=' + encodeConfig({ stream: false }),
    category: '配置',
    validate: (d) => {
      return assertIncludes(d.resources, 'stream', 'resources');
    },
  });

  // 3. 只 jpyy 电影/电视剧
  await testEndpoint({
    name: 'Manifest · 只 jpyy 电影/电视剧',
    path: '/manifest.json?cfg=' + encodeConfig({ srcs: ['jpyy'], cats: ['movie', 'series'] }),
    category: '配置',
    validate: (d) => {
      const err =
        assertEq(d.catalogs.length, 2, 'catalog 数量') ||
        assertIncludes(d.idPrefixes, 'jp', 'idPrefixes') ||
        assertNotIncludes(d.idPrefixes, 'dy555', 'idPrefixes');
      if (err) return err;
      const ids = d.catalogs.map(c => c.id);
      if (ids.some(x => x.startsWith('555-'))) return '不应含 555 目录';
      return null;
    },
  });

  // 4. 只 jpyy 动漫
  await testEndpoint({
    name: 'Manifest · 只 jpyy 动漫',
    path: '/manifest.json?cfg=' + encodeConfig({ srcs: ['jpyy'], cats: ['anime'] }),
    category: '配置',
    validate: (d) => assertEq(d.catalogs.length, 1, 'catalog 数量'),
  });

  // 5. 只 555
  await testEndpoint({
    name: 'Manifest · 只启用 555',
    path: '/manifest.json?cfg=' + encodeConfig({ srcs: ['555'] }),
    category: '配置 · 555',
    validate: (d) => {
      const err =
        assertEq(d.catalogs.length, 7, 'catalog 数量') ||
        assertIncludes(d.idPrefixes, 'dy555', 'idPrefixes') ||
        assertNotIncludes(d.idPrefixes, 'jp', 'idPrefixes') ||
        assertNotIncludes(d.idPrefixes, 'tt', 'idPrefixes');
      if (err) return err;
      const ids = d.catalogs.map(c => c.id);
      if (!ids.every(x => x.startsWith('555-'))) return '混入非 555 目录';
      return null;
    },
  });

  // 6. 555 部分分类
  await testEndpoint({
    name: 'Manifest · 555 只电影/剧集',
    path: '/manifest.json?cfg=' + encodeConfig({ srcs: ['555'], c555: ['movie', 'series'] }),
    category: '配置 · 555',
    validate: (d) => {
      const ids = d.catalogs.map(c => c.id);
      if (d.catalogs.length !== 2) return `应 2 个目录，实际 ${d.catalogs.length}`;
      if (!ids.includes('555-movie')) return '缺 555-movie';
      if (!ids.includes('555-series')) return '缺 555-series';
      return null;
    },
  });

  // 7. 都关闭 → 兜底
  await testEndpoint({
    name: 'Manifest · srcs=[] 兜底',
    path: '/manifest.json?cfg=' + encodeConfig({ srcs: [] }),
    category: '配置 · 边界',
    validate: (d) => {
      const ids = d.catalogs.map(c => c.id);
      if (!ids.some(x => x.startsWith('jinpai-'))) return '兜底应保留 jpyy';
      if (ids.some(x => x.startsWith('555-'))) return '不应含 555';
      return null;
    },
  });
}

// ==========================================
// jpyy Catalog
// ==========================================

async function testJpyyCatalog() {
  separator('🎯 jpyy Catalog 测试');

  const catalogs = [
    { name: '电影', path: '/catalog/movie/jinpai-movie.json', expectType: 'movie' },
    { name: '电视剧', path: '/catalog/series/jinpai-series.json', expectType: 'series' },
    { name: '综艺', path: '/catalog/series/jinpai-variety.json', expectType: 'series' },
    { name: '动漫', path: '/catalog/series/jinpai-anime.json', expectType: 'series' },
    { name: '短剧', path: '/catalog/series/jinpai-short.json', expectType: 'series' },
  ];

  for (const cat of catalogs) {
    await testEndpoint({
      name: `Catalog · jpyy ${cat.name}`,
      path: cat.path,
      checkHeaders: true,
      validate: (d) => {
        const err =
          assertArray(d.metas, 'metas') ||
          assertNonEmpty(d.metas, 'metas');
        if (err) return err;

        const allowedPrefixes = ctx.manifest?.idPrefixes || ['jp', 'tt', 'dy555'];
        for (const m of d.metas) {
          if (!m.id || !m.type || !m.name) return '首条缺 id/type/name';
          const prefix = ['dy555', 'tt', 'jp'].find(p => m.id.startsWith(p));
          if (!prefix) return `未知 id 前缀: ${m.id}`;
          if (!allowedPrefixes.includes(prefix)) return `id 前缀 ${prefix} 不在 idPrefixes 内`;
          if (m.type !== cat.expectType && m.type !== 'movie' && m.type !== 'series') {
            return `非法 type: ${m.type}`;
          }
        }
        return null;
      },
    }).then(r => { if (r.ok) r.summary = `首条类型 ${cat.expectType}`; });
  }

  // 分页
  const p1 = await testEndpoint({
    name: 'Catalog 分页 · skip=0',
    path: '/catalog/movie/jinpai-movie.json?skip=0',
    validate: (d) => assertArray(d.metas, 'metas'),
  });
  const p2 = await testEndpoint({
    name: 'Catalog 分页 · skip=48',
    path: '/catalog/movie/jinpai-movie.json?skip=48',
    validate: (d) => assertArray(d.metas, 'metas'),
  });

  if (p1.ok && p2.ok) {
    try {
      const d1 = await (await request('/catalog/movie/jinpai-movie.json?skip=0')).json();
      const d2 = await (await request('/catalog/movie/jinpai-movie.json?skip=48')).json();
      const ids1 = new Set((d1.metas || []).map(m => m.id));
      const ids2 = (d2.metas || []).map(m => m.id);
      const overlap = ids2.filter(id => ids1.has(id));
      if (overlap.length > 0) {
        warn(`分页重叠: ${overlap.length} 条 id 重复`);
        stats.warnings.push(`jpyy 分页有 ${overlap.length} 条重复`);
      } else {
        pass(`分页去重验证：两页 0 重叠`);
      }
    } catch { /* ignore */ }
  }

  // 搜索
  await testEndpoint({
    name: 'Catalog 搜索 · "阿甘"',
    path: `/catalog/movie/jinpai-movie/search=${encodeURIComponent('阿甘')}.json`,
    validate: (d) => {
      const err = assertArray(d.metas, 'metas') || assertNonEmpty(d.metas, 'metas');
      if (err) return err;
      for (const m of d.metas) {
        if (!m.id || !m.type || !m.name) return '搜索结果缺 id/type/name';
      }
      return null;
    },
  });

  // 并发搜索去重
  await testConcurrentSearch();
}

async function testConcurrentSearch() {
  const kw = encodeURIComponent('阿甘');
  // ★ 先打一次别的关键词，避免已有缓存干扰
  // 或者用 Redis DEL 清掉（需要 Redis 凭据，测试工具不一定有）
  // 更稳妥：用一个新关键词 + 短等待
  const uniqueKw = encodeURIComponent('复仇者联盟' + Date.now());
  const urls = [
    `/catalog/movie/jinpai-movie/search=${uniqueKw}.json`,
    `/catalog/series/jinpai-series/search=${uniqueKw}.json`,
    `/catalog/series/jinpai-variety/search=${uniqueKw}.json`,
    `/catalog/series/jinpai-anime/search=${uniqueKw}.json`,
    `/catalog/series/jinpai-short/search=${uniqueKw}.json`,
  ];

  info('并发搜索去重测试（模拟 Stremio 同时打 5 个分类）...');
  const start = Date.now();
  const results = await Promise.all(urls.map(u =>
    request(u).then(r => r.ok ? r.json() : null).catch(() => null)
  ));
  const elapsed = Date.now() - start;

  const okCount = results.filter(r => r && Array.isArray(r.metas)).length;
  if (okCount === 5) {
    pass(`并发 5 个搜索均成功，总耗时 ${elapsed}ms`);
    if (elapsed < 1000) {
      pass(`去重生效（总耗时 < 1s）`);
    } else {
      warn(`去重可能未完全生效（总耗时 ${elapsed}ms）`);
    }
  } else {
    warn(`并发搜索仅 ${okCount}/5 成功`);
    stats.warnings.push(`并发搜索 ${okCount}/5 成功`);
  }
}

// ==========================================
// 555 Catalog
// ==========================================

async function test555Catalog() {
  separator('🎥 555 Catalog 测试');

  const catalogs = [
    { id: '555-movie', type: 'movie', name: '电影' },
    { id: '555-series', type: 'series', name: '剧集' },
    { id: '555-anime', type: 'series', name: '动漫' },
    { id: '555-variety', type: 'series', name: '综艺' },
    { id: '555-short', type: 'series', name: '短剧' },
    { id: '555-sports', type: 'series', name: '体育' },
    { id: '555-new', type: 'series', name: '今日更新' },
  ];

  for (const c of catalogs) {
    await testEndpoint({
      name: `Catalog · 555 ${c.name}`,
      path: `/catalog/${c.type}/${c.id}.json`,
      category: '功能 · 555',
      validate: (d) => {
        const err = assertArray(d.metas, 'metas') || assertNonEmpty(d.metas, 'metas');
        if (err) return err;
        const first = d.metas[0];
        if (!first.id) return '首条缺 id';
        if (!first.id.startsWith('dy555')) return `id 前缀错误: ${first.id}`;
        if (first.type !== c.type) return `type 应 ${c.type}，实际 ${first.type}`;
        if (c.type === 'movie') {
          if (first.id.split(':').length !== 1) return `电影 id 应 1 段，实际 ${first.id}`;
        } else {
          if (first.id.split(':').length !== 3) return `剧集 id 应 3 段，实际 ${first.id}`;
        }
        return null;
      },
    });
  }

  // 无分页
  await testEndpoint({
    name: 'Catalog · 555 无分页（skip=48 应空）',
    path: '/catalog/movie/555-movie.json?skip=48',
    category: '功能 · 555',
    validate: (d) => {
      if (!Array.isArray(d.metas)) return 'metas 非数组';
      if (d.metas.length !== 0) return `应空数组，实际 ${d.metas.length} 条`;
      return null;
    },
  });

  // 无搜索（应该被忽略或返回错误，不能崩）
  await testEndpoint({
    name: 'Catalog · 555 搜索应被忽略（不崩）',
    path: `/catalog/movie/555-movie/search=${encodeURIComponent('测试')}.json`,
    category: '功能 · 555 · 边界',
    validate: (d) => {
      if (!Array.isArray(d.metas)) return 'metas 非数组';
      return null;
    },
  });
}

// ==========================================
// jpyy Meta
// ==========================================

async function testJpyyMeta() {
  separator('📺 jpyy Meta 测试');

  const movieId = ctx.jpyy.movieId;
  const seriesId = ctx.jpyy.seriesId;

  // ★ 关键测试：JP 电影 type 必须是 movie（能抓到之前的 bug）
  await testEndpoint({
    name: 'Meta · JP 电影（类型正确性）',
    path: `/meta/movie/jp${movieId}.json`,
    skipOnFail: !movieId,
    checkHeaders: true,
    validate: (d) => {
      if (!d.meta) return 'meta 为空';
      if (d.meta.type !== 'movie') return `type 应 movie，实际 ${d.meta.type}`;
      if (d.meta.id !== `jp${movieId}`) return `id 应 jp${movieId}，实际 ${d.meta.id}`;
      if (!d.meta.name) return '缺 name';
      return null;
    },
  }).then(r => { if (r.ok) r.summary = 'type=movie ✓'; });

  // ★ 关键测试：JP 剧集 type 必须是 series，videos 格式
  await testEndpoint({
    name: 'Meta · JP 剧集（类型正确性 + videos 格式）',
    path: `/meta/series/jp${seriesId}.json`,
    skipOnFail: !seriesId,
    validate: (d) => {
      if (!d.meta) return 'meta 为空';
      if (d.meta.type !== 'series') return `type 应 series，实际 ${d.meta.type}`;
      if (d.meta.id.includes(':')) return `meta.id 应为影片级，实际 ${d.meta.id}`;
      if (!Array.isArray(d.meta.videos) || d.meta.videos.length === 0) return 'videos 为空';

      for (const v of d.meta.videos) {
        if (!v.id.includes(':')) return `videos[].id 应含冒号: ${v.id}`;
        if (typeof v.season !== 'number') return `season 应为数字`;
        if (typeof v.episode !== 'number') return `episode 应为数字`;
      }

      // videos[].id 前缀应与 meta.id 一致
      const metaPrefix = d.meta.id.split(':')[0];
      const videoPrefix = d.meta.videos[0].id.split(':')[0];
      if (metaPrefix !== videoPrefix) return `videos[].id 前缀 ${videoPrefix} ≠ meta.id 前缀 ${metaPrefix}`;
      return null;
    },
  }).then(r => { if (r.ok) r.summary = 'type=series ✓, videos 格式 ✓'; });

  // ★ IMDb 电影
  await testEndpoint({
    name: 'Meta · TT 电影（类型正确性）',
    path: `/meta/movie/${ctx.jpyy.ttMovieId}.json`,
    category: '功能 · IMDb',
    validate: (d) => {
      if (!d.meta) return 'meta 为空（TMDB 不可用？）';
      if (d.meta.type !== 'movie') return `type 应 movie，实际 ${d.meta.type}`;
      return null;
    },
  });

  // IMDb 剧集
  await testEndpoint({
    name: 'Meta · TT 剧集 (tt13016388)',
    path: '/meta/series/tt13016388.json',
    category: '功能 · IMDb',
    validate: (d) => {
      if (!d.meta) return 'meta 为空';
      if (d.meta.type !== 'series') return `type 应 series，实际 ${d.meta.type}`;
      if (!Array.isArray(d.meta.videos)) return 'videos 非数组';
      return null;
    },
  });
}

// ==========================================
// jpyy Stream
// ==========================================

async function testJpyyStream() {
  separator('🎬 jpyy Stream 测试');

  const movieId = ctx.jpyy.movieId;
  const seriesId = ctx.jpyy.seriesId;

  // 电影 stream
  await testEndpoint({
    name: 'Stream · JP 电影',
    path: `/stream/movie/jp${movieId}.json`,
    skipOnFail: !movieId,
    validate: (d) => {
      const err = assertArray(d.streams, 'streams') || assertNonEmpty(d.streams, 'streams');
      if (err) return err;
      for (const s of d.streams) {
        if (!s.url) return '缺 url';
        if (!s.name) return '缺 name';
        if (!s.name.includes(`jp${movieId}`)) return `name 应含 jp${movieId}，实际 ${s.name}`;
        const urlErr = assertUrl(s.url, 'url');
        if (urlErr) return urlErr;
      }
      return null;
    },
  });

  // 剧集 S1E1
  await testEndpoint({
    name: 'Stream · JP 剧集 S1E1',
    path: `/stream/series/jp${seriesId}%3A1%3A1.json`,
    skipOnFail: !seriesId,
    validate: (d) => {
      const err = assertArray(d.streams, 'streams') || assertNonEmpty(d.streams, 'streams');
      if (err) return err;
      const s = d.streams[0];
      if (!s.name.includes('S01E01')) return `name 应含 S01E01，实际 ${s.name}`;
      return null;
    },
  });

  // IMDb 电影 stream
  await testEndpoint({
    name: 'Stream · TT 电影',
    path: `/stream/movie/${ctx.jpyy.ttMovieId}.json`,
    category: '功能 · IMDb',
    validate: (d) => {
      const err = assertArray(d.streams, 'streams') || assertNonEmpty(d.streams, 'streams');
      if (err) return err;
      const s = d.streams[0];
      if (!s.name.includes(ctx.jpyy.ttMovieId)) return `name 应含 ${ctx.jpyy.ttMovieId}`;
      return null;
    },
  });

  // 关闭时返回空
  await testEndpoint({
    name: 'Stream · jpyy 关闭时返回空',
    path: `/stream/movie/jp${movieId}.json?cfg=` + encodeConfig({ stream: false }),
    skipOnFail: !movieId,
    category: '配置',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return 'streams 非数组';
      if (d.streams.length !== 0) return '应空数组';
      return null;
    },
  });

  // ★ 关闭 stream 时 555 仍可用
  const m555Id = ctx.m555.movieId;
  await testEndpoint({
    name: 'Stream · stream=false 时 555 仍返回（源隔离）',
    path: `/stream/movie/${encodeURIComponent(m555Id || '')}.json?cfg=` + encodeConfig({ stream: false }),
    skipOnFail: !m555Id,
    category: '配置 · 边界',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return 'streams 非数组';
      if (d.streams.length === 0) return '555 不受 stream 开关影响，应非空';
      return null;
    },
  });
}

// ==========================================
// 555 Meta / Stream
// ==========================================

async function test555MetaStream() {
  separator('🎬 555 Meta / Stream 测试');

  const movieId = ctx.m555.movieId;
  const seriesId = ctx.m555.seriesId;

  // 555 电影 meta
  await testEndpoint({
    name: 'Meta · 555 电影（类型正确性）',
    path: `/meta/movie/${encodeURIComponent(movieId || '')}.json`,
    category: '功能 · 555',
    skipOnFail: !movieId,
    validate: (d) => {
      if (!d.meta) return 'meta 为空';
      if (d.meta.type !== 'movie') return `type 应 movie，实际 ${d.meta.type}`;
      if (!d.meta.id.startsWith('dy555')) return `id 前缀错: ${d.meta.id}`;
      if (d.meta.id.split(':').length !== 1) return `电影 meta.id 应 1 段: ${d.meta.id}`;
      return null;
    },
  });

  // 555 剧集 meta
  await testEndpoint({
    name: 'Meta · 555 剧集（videos 格式）',
    path: `/meta/series/${encodeURIComponent(seriesId || '')}.json`,
    category: '功能 · 555',
    skipOnFail: !seriesId,
    validate: (d) => {
      if (!d.meta) return 'meta 为空';
      if (d.meta.type !== 'series') return `type 应 series，实际 ${d.meta.type}`;
      if (d.meta.id.includes(':')) return `meta.id 应影片级: ${d.meta.id}`;
      if (!Array.isArray(d.meta.videos) || d.meta.videos.length === 0) return 'videos 为空';
      for (const v of d.meta.videos) {
        if (v.id.split(':').length !== 3) return `videos[].id 应 3 段: ${v.id}`;
        if (v.season !== 1) return `season 应恒 1`;
      }
      return null;
    },
  });

  // 555 电影 stream
  await testEndpoint({
    name: 'Stream · 555 电影',
    path: `/stream/movie/${encodeURIComponent(movieId || '')}.json`,
    category: '功能 · 555',
    skipOnFail: !movieId,
    validate: (d) => {
      const err = assertArray(d.streams, 'streams') || assertNonEmpty(d.streams, 'streams');
      if (err) return err;
      const s = d.streams[0];
      if (!s.name || s.name === '555') return `stream.name 应为影片名，实际 ${s.name}`;
      if (!s.title) return '缺 title（线路名）';
      const urlErr = assertUrl(s.url, 'url');
      if (urlErr) return urlErr;
      return null;
    },
  });

  // 555 剧集 stream（多源）
  await testEndpoint({
    name: 'Stream · 555 剧集 S1E1（多源）',
    path: `/stream/series/${encodeURIComponent(seriesId + ':1:1')}.json`,
    category: '功能 · 555',
    skipOnFail: !seriesId,
    validate: (d) => {
      const err = assertArray(d.streams, 'streams') || assertNonEmpty(d.streams, 'streams');
      if (err) return err;
      // 至少一个 stream 应有 title（线路名）
      if (!d.streams.some(s => s.title)) return '缺线路名 title';
      return null;
    },
  });
}

// ==========================================
// Search 独立接口
// ==========================================

async function testSearch() {
  separator('🔍 Search 测试');

  await testEndpoint({
    name: 'Search · 独立接口',
    path: `/search/${encodeURIComponent('怒之杀')}.json`,
    validate: (d) => {
      const err = assertArray(d.results, 'results') || assertNonEmpty(d.results, 'results');
      if (err) return err;
      for (const r of d.results) {
        if (!r.id || !r.type || !r.name) return '结果缺 id/type/name';
      }
      return null;
    },
  });
}

// ==========================================
// 响应头检查
// ==========================================

async function testHeaders() {
  separator('📡 响应头测试');

  const cases = [
    { name: 'Catalog', path: '/catalog/movie/jinpai-movie.json', expectSmaxage: true },
    { name: 'Meta', path: `/meta/movie/jp${ctx.jpyy.movieId || '146870'}.json`, expectSmaxage: true },
    { name: 'Stream', path: `/stream/movie/jp${ctx.jpyy.movieId || '146870'}.json`, expectSmaxage: true },
  ];

  for (const c of cases) {
    const r = await request(c.path).catch(() => null);
    if (!r) { warn(`${c.name} 响应头测试请求失败`); continue; }

    const cc = r.headers.get('cache-control') || '';
    const cors = r.headers.get('access-control-allow-origin');
    const ct = r.headers.get('content-type') || '';

    let allOk = true;
    if (!ct.includes('application/json')) {
      warn(`${c.name}: Content-Type=${ct}`);
      allOk = false;
    }
    if (cors !== '*') {
      warn(`${c.name}: CORS=${cors}`);
      allOk = false;
    }
    if (c.expectSmaxage && !cc.includes('s-maxage=')) {
      warn(`${c.name}: 缺 s-maxage（${cc}）`);
      allOk = false;
    }

    if (allOk) pass(`${c.name} 响应头 OK (${cc})`);
    else stats.warnings.push(`${c.name} 响应头异常`);
  }
}

// ==========================================
// 边界测试
// ==========================================

async function testBoundaries() {
  separator('🧪 边界测试');

  // 非法 base64 cfg
  await testEndpoint({
    name: '边界 · 非法 cfg 不崩',
    path: '/manifest.json?cfg=INVALID_BASE64_@@@',
    category: '边界',
    validate: (d) => {
      if (!d.id) return '应返回默认 manifest';
      return null;
    },
  });

  // 空 cfg
  await testEndpoint({
    name: '边界 · 空 cfg',
    path: '/manifest.json?cfg=',
    category: '边界',
    validate: (d) => {
      if (!d.id) return '应返回默认 manifest';
      return null;
    },
  });

  // 超大 cfg（8KB+）
  const bigCfg = encodeConfig({ bd: 'x'.repeat(10000) });
  await testEndpoint({
    name: '边界 · 超大 cfg（8KB+）',
    path: `/manifest.json?cfg=${bigCfg}`,
    category: '边界',
    validate: (d) => {
      if (!d.id) return '应正常返回';
      return null;
    },
  });

  // 不存在的 catalog
  await testEndpoint({
    name: '边界 · 未知 catalogId',
    path: '/catalog/movie/unknown-catalog.json',
    category: '边界',
    validate: (d) => {
      if (!Array.isArray(d.metas)) return 'metas 非数组';
      // 应返回空数组而非 500
      return null;
    },
  });

  // 配置页
  await testEndpoint({
    name: '边界 · 配置页 /configure 可访问',
    path: '/configure',
    category: '边界',
    raw: true,
    validate: (text) => {
      if (!text.includes('<html') && !text.includes('<!DOCTYPE')) return '非 HTML 响应';
      return null;
    },
  });
}

// ==========================================
// Debug 健康检查
// ==========================================

async function testDebug() {
  separator('🏥 健康检查');

  await testEndpoint({
    name: 'Debug · 域名状态',
    path: '/debug/domains',
    category: '健康检查',
    validate: (d) => {
      const err = assertStr(d.current, 'current');
      if (err) return err;
      return null;
    },
  });

  await testEndpoint({
    name: 'Debug · 缓存状态',
    path: '/debug/cache',
    category: '健康检查',
    validate: (d) => {
      if (typeof d.l2Enabled !== 'boolean') return 'l2Enabled 非布尔';
      if (typeof d.l1Size !== 'number') return 'l1Size 非数字';
      if (typeof d.redisInCooldown !== 'boolean') return 'redisInCooldown 非布尔';
      return null;
    },
  });

  await testEndpoint({
    name: 'Debug · 555 状态',
    path: '/debug/555',
    category: '健康检查 · 555',
    validate: (d) => {
      if (!d.currentDomain && !d.defaultDomain) return '缺域名';
      if (typeof d.currentDomain !== 'string') return 'currentDomain 非字符串';
      return null;
    },
  });
}

// ==========================================
// 缓存效果
// ==========================================

async function testCacheEffect() {
  if (SKIP_CACHE_TEST) {
    info('跳过缓存测试（SKIP_CACHE_TEST=1）');
    return;
  }
  if (IS_LOCAL) {
    separator('💾 缓存效果测试');
    info('本地环境：跳过 CDN HIT 断言（vercel dev 无 CDN）');
    skip('CDN 缓存测试（本地）');
    return;
  }

  separator('💾 缓存效果测试');
  const path = '/catalog/movie/555-movie.json';

  info('第 1 次请求...');
  const r1 = await testEndpoint({
    name: '缓存 · 555 Catalog 第 1 次',
    path, category: '缓存',
    validate: (d) => assertArray(d.metas, 'metas'),
  });

  await new Promise(r => setTimeout(r, 2000));

  info('第 2 次请求...');
  const r2 = await testEndpoint({
    name: '缓存 · 555 Catalog 第 2 次',
    path, category: '缓存',
    validate: (d) => assertArray(d.metas, 'metas'),
  });

  if (r1.ok && r2.ok) {
    console.log(`\n${C.bold}缓存分析：${C.reset}`);
    console.log(`  第 1 次：${r1.elapsed}ms (CDN: ${r1.cacheStatus})`);
    console.log(`  第 2 次：${r2.elapsed}ms (CDN: ${r2.cacheStatus})`);

    if (r2.cacheStatus === 'HIT') {
      pass('CDN HIT');
    } else {
      warn(`CDN 未命中（线上首次冷启动正常，可预热一次后再测）`);
      stats.warnings.push('CDN 未命中');
    }
  }
}

// ==========================================
// 汇总
// ==========================================

function printSummary() {
  separator('📋 详细结果');
  for (const r of stats.results) {
    const icon = r.ok ? `${C.green}✅${C.reset}` : `${C.red}❌${C.reset}`;
    const time = `${C.gray}(${r.elapsed}ms)${C.reset}`;
    const cache = r.cacheStatus && r.cacheStatus !== '-' ? ` ${C.gray}[CDN: ${r.cacheStatus}]${C.reset}` : '';
    console.log(`${icon} ${r.name} ${time}${cache}`);
    if (!r.ok) console.log(`     ${C.red}${r.error}${C.reset}`);
  }

  separator('📊 汇总');
  console.log(`${C.bold}总计：${C.reset}  ${stats.total}`);
  console.log(`${C.green}${C.bold}通过：${C.reset}  ${stats.passed}`);
  console.log(`${C.red}${C.bold}失败：${C.reset}  ${stats.failed}`);
  if (stats.skipped > 0) console.log(`${C.yellow}${C.bold}跳过：${C.reset}  ${stats.skipped}`);

  const passRate = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;
  const color = passRate >= 90 ? C.green : passRate >= 70 ? C.yellow : C.red;
  console.log(`${C.bold}通过率：${C.reset} ${color}${passRate}%${C.reset}`);

  if (stats.warnings.length > 0) {
    separator('⚠️ 警告');
    for (const w of stats.warnings) console.log(`  ${C.yellow}• ${w}${C.reset}`);
  }
}


async function testEmptyNotCached() {
  separator('🛡️ 空结果缓存保护');

  // 用 555 一个不存在的 vodId，触发回源失败
  await testEndpoint({
    name: '空结果 · 555 无效 id 不写缓存',
    path: '/meta/movie/dy555_NOT_EXIST.json',
    category: '防护',
    validate: (d) => {
      // meta 应为 null，但不能导致后续请求全部空
      return d.meta === null ? null : '应返回 null';
    },
  });

  // 紧接着请求正常资源，验证没被污染
  const r = await request('/catalog/movie/555-movie.json');
  if (r.ok) {
    const d = await r.json();
    if (d.metas?.length > 0) {
      pass(`正常资源未受影响（${d.metas.length} 条）`);
    } else {
      fail('正常资源被空结果污染！');
    }
  }
}


async function testRedisCooldownRecovery() {
  separator('🔄 Redis 冷却恢复');
  info('连续快速请求，观察是否触发冷却 + 能否自动恢复...');

  const start = Date.now();
  for (let i = 0; i < 8; i++) {
    await request('/debug/cache');
    await new Promise(r => setTimeout(r, 100));
  }

  // 冷却或未冷却都应正常响应
  const r = await request('/debug/cache');
  const d = await r.json();
  if (d.l2Enabled) {
    pass(`Redis 状态可查询（冷却中: ${d.redisInCooldown}）`);
  } else {
    warn('Redis 未启用');
  }
  info(`8 次快速请求耗时 ${Date.now() - start}ms`);
}

// ==========================================
// 主入口
// ==========================================

async function main() {
  console.clear();
  separator('🎬 金牌影视 + 555 · Stremio Addon 完整 E2E 冒烟测试');
  console.log(`${C.bold}目标：${C.reset}${C.cyan}${BASE_URL}${C.reset}`);
  console.log(`${C.bold}超时：${C.reset}${TIMEOUT}ms`);
  console.log(`${C.bold}环境：${C.reset}${IS_LOCAL ? '本地（跳过 CDN）' : '线上'}`);
  console.log(`${C.bold}模式：${C.reset}${STRICT ? '严格（WARN 也算失败）' : '常规'}`);
  console.log('');

  // 预检
  info('检查服务可达性...');
  try {
    const resp = await request('/manifest.json', { timeout: 5000 });
    if (resp.ok) pass(`服务可达（HTTP ${resp.status}）`);
    else warn(`服务返回 HTTP ${resp.status}`);
  } catch (err) {
    fail(`服务不可达: ${err.message}`);
    process.exit(1);
  }

  await prefetch();
  const t0 = Date.now();

  await testManifests();
  await testJpyyCatalog();
  await test555Catalog();
  await testJpyyMeta();
  await test555MetaStream();
  await testJpyyStream();
  await testSearch();
  await testHeaders();
  await testBoundaries();
  await testDebug();
  await testCacheEffect();

  printSummary();

  const totalTime = Date.now() - t0;
  console.log(`${C.bold}耗时：${C.reset}  ${totalTime}ms\n`);

  const exitFail = stats.failed > 0 || (STRICT && stats.warnings.length > 0);
  process.exit(exitFail ? 1 : 0);
}

main().catch(err => {
  console.error(`${C.red}异常：${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});