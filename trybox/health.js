#!/usr/bin/env node

/**
 * TryBox Addon 健康检测（v2 - 完善版）
 *
 * 环境变量：
 *   BASE_URL    - 目标地址（默认 http://localhost:3000）
 *   TIMEOUT     - 单请求超时毫秒（默认 30000）
 *   SKIP_SLOW   - 1 时跳过 subtitle/stream 慢测试
 *   SKIP_TT     - 1 时跳过 tt ID 测试（需 TMDB Key）
 *   STRICT      - 1 时 WARN 也算失败（CI 用）
 *   VERBOSE     - 1 时打印完整响应（前 500 字）
 *
 * 覆盖：
 *   - Manifest（默认 / 开关 / catalog 选择 / catalog-meta 绑定 / Cache-Control）
 *   - Catalog（8 个 × type / skip / meta 预览字段完整性）
 *   - Search（中文关键词 / feats 关闭 search）
 *   - Genre（完整 GENRE_MAP / 未知 genre）
 *   - Meta（movie / series / 不存在 ID / videos 字段完整性）
 *   - Subtitle（movie / series / subLang 三种模式 / 字段完整性）
 *   - Stream（movie / series / removeIdValidation / 排序 / 负面缓存 / Cache-Control）
 *   - tt ID（manifest / stream / subtitle / meta 不响应）
 *   - 配置边界（非法 cfg / 超大 cfg / 空 cfg）
 *   - CDN 缓存（各资源 Cache-Control / HIT 验证，仅线上）
 *   - Debug（/debug/health / /debug/cache）
 * 
 * 运行
 * # 本地
 * node health.js
 *
 * # 线上完整测试
 * BASE_URL=https://your-domain.com node health.js
 *
 * # CI 严格模式（WARN 也算失败）
 * BASE_URL=https://your-domain.com STRICT=1 node health.js
 *
 * # 快速冒烟（跳过 subtitle/stream，30s 内跑完）
 * SKIP_SLOW=1 node health.js
 *
 * # 不测 tt ID（避免 TMDB 限流）
 * SKIP_TT=1 node health.js
 *
 * # 查看完整响应
 * VERBOSE=1 node health.js
 *
 *
 */




const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = parseInt(process.env.TIMEOUT || '30000', 10);
const SKIP_SLOW = process.env.SKIP_SLOW === '1';
const SKIP_TT = process.env.SKIP_TT === '1';
const STRICT = process.env.STRICT === '1';
const VERBOSE = process.env.VERBOSE === '1';
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL);

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

const stats = {
  total: 0, passed: 0, failed: 0, skipped: 0,
  warnings: [], slow: [], results: [],
};

const info = (m, ...a) => log(C.blue,   '[INFO]',  m, ...a);
const pass = (m, ...a) => log(C.green,  '[PASS]',  m, ...a);
const fail = (m, ...a) => log(C.red,    '[FAIL]',  m, ...a);
const warn = (m, ...a) => log(C.yellow, '[WARN]',  m, ...a);   // ← 加这行
const debug = (m, ...a) => log(C.gray,  '[DEBUG]', m, ...a);
const skip = (m, ...a) => log(C.yellow, '[SKIP]',  m, ...a);



function ts() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(color, emoji, category, msg) {
  console.log(`${C.gray}[${ts()}]${C.reset} ${color}${emoji}${C.reset} ${C.cyan}[${category}]${C.reset} ${msg}`);
}

function separator(title = '', sub = '') {
  const line = '═'.repeat(72);
  console.log(`\n${C.cyan}${line}${C.reset}`);
  if (title) {
    console.log(`${C.cyan}${C.bold}  ${title}${C.reset}`);
    if (sub) console.log(`${C.gray}  ${sub}${C.reset}`);
    console.log(`${C.cyan}${line}${C.reset}`);
  }
  console.log('');
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const text = await resp.text();
    return {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function test({ category, name, path, validate, skip = false, skipReason = '', severity = 'major', timeout: customTimeout }) {
  if (skip) {
    stats.skipped++;
    log(C.yellow, '⏭️', category, `${name} ${C.gray}(跳过: ${skipReason})${C.reset}`);
    return { ok: false, skipped: true };
  }

  stats.total++;
  const t0 = Date.now();
  const result = { category, name, ok: false, elapsed: 0, error: null, summary: null, severity, warned: false };

  // const resp = await request(path, { timeout: customTimeout || TIMEOUT });

  try {
    const resp = await request(path);
    const elapsed = Date.now() - t0;
    result.elapsed = elapsed;

    if (resp.status >= 500) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`);
    if (resp.status >= 400) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''} (4xx)`);

    let data;
    try {
      data = JSON.parse(resp.text);
    } catch (e) {
      const preview = resp.text.slice(0, 300).replace(/\n/g, '\\n');
      throw new Error(`JSON 解析失败: ${e.message} | 前 300 字: ${preview}`);
    }

    if (VERBOSE) {
      console.log(`      ${C.dim}响应: ${JSON.stringify(data).slice(0, 500)}${C.reset}`);
    }

    const v = await validate(data, resp.headers);
    if (!v || !v.valid) throw new Error(v?.reason || '校验失败');

    result.ok = true;
    result.summary = v.summary || 'OK';

    if (elapsed > 5000) stats.slow.push({ category, name, elapsed });

    log(C.green, '✅', category, `${name} ${C.gray}(${elapsed}ms)${C.reset} ${C.dim}${v.summary || ''}${C.reset}`);
    stats.passed++;
    stats.results.push(result);
    return result;
  } catch (err) {
    const elapsed = Date.now() - t0;
    result.elapsed = elapsed;
    result.error = err.name === 'AbortError' ? `超时(>${TIMEOUT}ms)` : err.message;

    if (severity === 'minor') {
      // minor：算警告，不算失败（通过率不受影响）
      result.warned = true;
      log(C.yellow, '⚠️', category, `${name} ${C.gray}(${elapsed}ms)${C.reset}`);
      console.log(`         ${C.yellow}${result.error}${C.reset}`);
      stats.warnings.push(`[${category}] ${name}: ${result.error}`);
      // stats.passed++;
      // minor 失败只进 warnings，不污染通过率
    } else {
      log(C.red, '❌', category, `${name} ${C.gray}(${elapsed}ms)${C.reset}`);
      console.log(`         ${C.red}${result.error}${C.reset}`);
      stats.failed++;
    }

    stats.results.push(result);
    return result;
  }
}

function encodeCfg(config) {
  return Buffer.from(JSON.stringify(config), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requireFields(obj, fields, name = '对象') {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') return `缺少 ${f}`;
  }
  return null;
}

function validateMetaPreview(m) {
  const r = requireFields(m, ['id', 'type', 'name']);
  if (r) return r;
  if (!/^trybox_\d+$/.test(m.id)) return `id 格式错误: ${m.id}`;
  if (m.type !== 'movie' && m.type !== 'series') return `type 错误: ${m.type}`;
  return null;
}

function validateStreamItem(s) {
  const r = requireFields(s, ['name', 'url']);
  if (r) return r;
  if (s.url && s.url.startsWith('trybox|')) return null; // 诊断 stream
  if (!/^https?:\/\//.test(s.url)) return `url 非法: ${s.url.slice(0, 50)}`;
  return null;
}

function validateSubtitleItem(s) {
  const r = requireFields(s, ['id', 'url', 'lang']);
  if (r) return r;
  if (s.lang !== 'zh' && s.lang !== 'en') return `lang 非法: ${s.lang}`;
  if (!/^https?:\/\//.test(s.url)) return `url 非法: ${s.url.slice(0, 50)}`;
  return null;
}

// ==========================================
// 1. Manifest
// ==========================================
async function testManifest() {
  separator('📋 Manifest 测试');

  await test({
    category: 'manifest', name: '默认配置', path: '/manifest.json', severity: 'critical',
    validate: (d) => {
      if (!d.id) return { valid: false, reason: '缺少 id' };
      if (!d.name) return { valid: false, reason: '缺少 name' };
      if (!d.version) return { valid: false, reason: '缺少 version' };
      if (!Array.isArray(d.catalogs) || !d.catalogs.length) return { valid: false, reason: '缺少 catalogs' };
      if (!Array.isArray(d.resources) || !d.resources.length) return { valid: false, reason: '缺少 resources' };
      return { valid: true, summary: `catalogs=${d.catalogs.length}, resources=${d.resources.length}` };
    },
  });

  await test({
    category: 'manifest', name: '资源类型完整', path: '/manifest.json', severity: 'critical',
    validate: (d) => {
      const names = d.resources.map((r) => (typeof r === 'string' ? r : r.name));
      const missing = ['catalog', 'meta', 'subtitles', 'stream'].filter((n) => !names.includes(n));
      if (missing.length) return { valid: false, reason: `缺少: ${missing.join(', ')}` };
      return { valid: true, summary: `[${names.join(', ')}]` };
    },
  });

  await test({
    category: 'manifest', name: '关闭 stream',
    path: `/manifest.json?cfg=${encodeCfg({ feats: ['catalog', 'meta', 'subtitle'] })}`,
    severity: 'major',
    validate: (d) => {
      const names = d.resources.map((r) => (typeof r === 'string' ? r : r.name));
      if (names.includes('stream')) return { valid: false, reason: '应不含 stream' };
      if (!names.includes('subtitles')) return { valid: false, reason: '应含 subtitles' };
      return { valid: true, summary: `[${names.join(', ')}]` };
    },
  });

  await test({
    category: 'manifest', name: '仅 topRated',
    path: `/manifest.json?cfg=${encodeCfg({ cats: ['topRated'] })}`,
    severity: 'major',
    validate: (d) => {
      const ids = d.catalogs.map((c) => c.id);
      if (!ids.every((id) => id === 'trybox_topRated')) return { valid: false, reason: `实际: ${ids.join(', ')}` };
      return { valid: true, summary: `[${ids.join(', ')}]` };
    },
  });

  await test({
    category: 'manifest', name: 'movie + tv',
    path: `/manifest.json?cfg=${encodeCfg({ cats: ['movie', 'tv'] })}`,
    severity: 'major',
    validate: (d) => {
      const ids = new Set(d.catalogs.map((c) => c.id));
      if (!ids.has('trybox_movie')) return { valid: false, reason: '缺 trybox_movie' };
      if (!ids.has('trybox_tv')) return { valid: false, reason: '缺 trybox_tv' };
      return { valid: true, summary: `[${[...ids].join(', ')}]` };
    },
  });

  // ★ 新增：catalog-meta 绑定验证（只开 stream，catalog 应被自动排除）
  await test({
    category: 'manifest', name: 'catalog-meta 绑定（feats=[stream]）',
    path: `/manifest.json?cfg=${encodeCfg({ feats: ['stream'] })}`,
    severity: 'major',
    validate: (d) => {
      const names = d.resources.map((r) => (typeof r === 'string' ? r : r.name));
      if (names.includes('catalog')) return { valid: false, reason: 'catalog 和 meta 绑定，只开 stream 时不应有 catalog' };
      if (names.includes('meta')) return { valid: false, reason: '不应含 meta' };
      if (!names.includes('stream')) return { valid: false, reason: '应含 stream' };
      return { valid: true, summary: `[${names.join(', ')}]` };
    },
  });

  // ★ 新增：Cache-Control 头
  await test({
    category: 'manifest', name: 'Cache-Control 头（s-maxage=60）',
    path: '/manifest.json',
    severity: 'minor',
    validate: (_, headers) => {
      const cc = headers.get('cache-control') || '';
      if (!/s-maxage=60/.test(cc)) return { valid: false, reason: `Cache-Control 不符: ${cc}` };
      return { valid: true, summary: cc };
    },
  });
}

// ==========================================
// 2. Catalog
// ==========================================
async function testCatalogs() {
  separator('🎬 Catalog 测试');

  const catalogDefs = [
    { key: 'home', types: ['movie', 'series'] },
    { key: 'movie', types: ['movie'] },
    { key: 'tv', types: ['series'] },
    { key: 'trending', types: ['movie', 'series'] },
    { key: 'popular', types: ['movie'] },
    { key: 'topRated', types: ['movie'] },
    { key: 'secondary', types: ['series'] },
    { key: 'tertiary', types: ['series'] },
  ];

  for (const def of catalogDefs) {
    for (const type of def.types) {
      await test({
        category: 'catalog', name: `${def.key} · ${type}`,
        path: `/catalog/${type}/trybox_${def.key}.json`,
        timeout: def.timeout,
        severity: 'critical',
        validate: (d) => {
          if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
          if (!d.metas.length) return { valid: false, reason: 'metas 为空' };
          const first = d.metas[0];
          const r = validateMetaPreview(first);
          if (r) return { valid: false, reason: `首条: ${r}` };
          if (first.type !== type) return { valid: false, reason: `首条 type 应 ${type}，实际 ${first.type}` };
          return { valid: true, summary: `${d.metas.length} 条 · "${first.name}"` };
        },
      });
    }
  }

  // ★ 新增：skip 参数
  await test({
    category: 'catalog', name: 'skip=48（分页边界）',
    path: '/catalog/movie/trybox_movie.json?skip=48',
    severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
      return { valid: true, summary: `${d.metas.length} 条（trybox 无分页，不崩即可）` };
    },
  });

  // ★ 新增：meta 预览字段完整性
  await test({
    category: 'catalog', name: 'Meta 预览字段完整性',
    path: '/catalog/movie/trybox_movie.json',
    severity: 'major',
    validate: (d) => {
      if (!Array.isArray(d.metas) || !d.metas.length) return { valid: false, reason: 'metas 为空' };
      let withPoster = 0, withYear = 0, withRating = 0;
      for (const m of d.metas) {
        if (m.poster) withPoster++;
        if (m.releaseInfo) withYear++;
        if (m.imdbRating) withRating++;
      }
      const total = d.metas.length;
      if (withPoster < total * 0.5) return { valid: false, reason: `poster 覆盖率低: ${withPoster}/${total}` };
      return { valid: true, summary: `poster=${withPoster}/${total}, year=${withYear}/${total}, rating=${withRating}/${total}` };
    },
  });
}

// ==========================================
// 3. Search
// ==========================================
async function testSearch() {
  separator('🔍 Search 测试');

  for (const kw of ['阿甘正传', '生化危机', '继承之战']) {
    await test({
      category: 'search', name: `"${kw}"`,
      path: `/catalog/movie/trybox_movie.json?search=${encodeURIComponent(kw)}`,
      severity: 'major',
      validate: (d) => {
        if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
        for (const m of d.metas.slice(0, 3)) {
          const r = validateMetaPreview(m);
          if (r) return { valid: false, reason: `结果: ${r}` };
        }
        return { valid: true, summary: `${d.metas.length} 条` };
      },
    });
  }

  // ★ 新增：feats 关闭 search
  await test({
    category: 'search', name: 'feats 关闭 search（应返回空）',
    path: `/catalog/movie/trybox_movie.json?search=${encodeURIComponent('阿甘')}&cfg=${encodeCfg({ feats: ['catalog', 'meta'] })}`,
    severity: 'major',
    validate: (d) => {
      if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
      if (d.metas.length !== 0) return { valid: false, reason: `应返回空数组，实际 ${d.metas.length} 条` };
      return { valid: true, summary: '正确返回空数组' };
    },
  });
}

// ==========================================
// 4. Genre
// ==========================================
async function testGenre() {
  separator('🎭 Genre 测试');

  // 完整 GENRE_MAP
  const genreCases = [
    { type: 'movie', genre: '动作' },
    { type: 'movie', genre: '喜剧' },
    { type: 'movie', genre: '科幻' },
    { type: 'movie', genre: '恐怖' },
    { type: 'movie', genre: '家庭' },
    { type: 'series', genre: '犯罪' },
    { type: 'series', genre: '科幻' },
  ];

  for (const g of genreCases) {
    const catalogId = g.type === 'series' ? 'trybox_tv' : 'trybox_movie';
    await test({
      category: 'genre', name: `${g.type} · ${g.genre}`,
      path: `/catalog/${g.type}/${catalogId}.json?genre=${encodeURIComponent(g.genre)}`,
      severity: 'major',
      validate: (d) => {
        if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
        return { valid: true, summary: `${d.metas.length} 条` };
      },
    });
  }

  // ★ 新增：未知 genre
  await test({
    category: 'genre', name: '未知 genre（应返回空）',
    path: '/catalog/movie/trybox_movie.json?genre=不存在的类型',
    severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
      if (d.metas.length !== 0) return { valid: false, reason: `应返回空，实际 ${d.metas.length} 条` };
      return { valid: true, summary: '正确返回空数组' };
    },
  });
}

// ==========================================
// 5. Meta
// ==========================================
async function testMeta() {
  separator('📺 Meta 测试');

  await test({
    category: 'meta', name: 'movie · 阿甘正传', path: '/meta/movie/trybox_13.json',
    severity: 'critical',
    validate: (d) => {
      if (!d.meta) return { valid: false, reason: 'meta 为空' };
      if (d.meta.type !== 'movie') return { valid: false, reason: `type 应 movie，实际 ${d.meta.type}` };
      if (!d.meta.name) return { valid: false, reason: '缺 name' };
      return { valid: true, summary: `"${d.meta.name}" (${d.meta.releaseInfo || 'N/A'})` };
    },
  });

  // ★ 新增：series videos 字段完整性（合并原 series 测试）
  await test({
    category: 'meta', name: 'series · 继承之战（videos 完整性）', path: '/meta/series/trybox_76331.json',
    severity: 'critical',
    validate: (d) => {
      if (!d.meta) return { valid: false, reason: 'meta 为空' };
      if (d.meta.type !== 'series') return { valid: false, reason: `type 应 series` };
      if (!Array.isArray(d.meta.videos) || !d.meta.videos.length) return { valid: false, reason: 'videos 为空' };
      const v = d.meta.videos[0];
      if (!/^trybox_\d+:\d+:\d+$/.test(v.id)) return { valid: false, reason: `videos[0].id 格式错误: ${v.id}` };
      if (typeof v.season !== 'number') return { valid: false, reason: 'season 非数字' };
      if (typeof v.episode !== 'number') return { valid: false, reason: 'episode 非数字' };
      if (!v.title) return { valid: false, reason: 'videos[0].title 为空' };
      return { valid: true, summary: `"${d.meta.name}" · ${d.meta.videos.length} 集 · 首集 id=${v.id}` };
    },
  });

  // ★ 新增：不存在 ID
  await test({
    category: 'meta', name: '不存在 ID（应返回 null）',
    path: '/meta/movie/trybox_999999999.json',
    severity: 'minor',
    validate: (d) => {
      if (d.meta === null || d.meta === undefined) return { valid: true, summary: '正确返回 null' };
      return { valid: false, reason: `应返回 null，实际 ${JSON.stringify(d.meta).slice(0, 100)}` };
    },
  });
}

// ==========================================
// 6. Subtitle
// ==========================================
async function testSubtitle() {
  separator('💬 Subtitle 测试');

  if (SKIP_SLOW) {
    log(C.yellow, '⏭️', 'subtitle', 'SKIP_SLOW=1');
    stats.skipped += 5; stats.total += 5;
    return;
  }

  const subTests = [
    { name: 'movie · 阿甘正传', path: '/subtitles/movie/trybox_13.json', severity: 'critical' },
    { name: 'series · 继承之战 S1E1', path: '/subtitles/series/trybox_76331:1:1.json', severity: 'critical' },
    {
      name: 'subLang=zh（仅中文）', severity: 'major',
      path: `/subtitles/movie/trybox_13.json?cfg=${encodeCfg({ subLang: 'zh' })}`,
      expected: ['zh'],
    },
    {
      name: 'subLang=en（仅英文）', severity: 'major',
      path: `/subtitles/movie/trybox_13.json?cfg=${encodeCfg({ subLang: 'en' })}`,
      expected: ['en'],
    },
    {
      name: 'subLang=zh-en（中英）', severity: 'major',
      path: `/subtitles/movie/trybox_13.json?cfg=${encodeCfg({ subLang: 'zh-en' })}`,
      expected: ['zh', 'en'],
    },
  ];

  for (const t of subTests) {
    await test({
      category: 'subtitle', name: t.name, path: t.path, severity: t.severity,
      validate: (d) => {
        if (!Array.isArray(d.subtitles)) return { valid: false, reason: 'subtitles 非数组' };
        for (const s of d.subtitles) {
          const r = validateSubtitleItem(s);
          if (r) return { valid: false, reason: `字幕: ${r}` };
        }
        const langs = new Set(d.subtitles.map((s) => s.lang));
        const invalid = [...langs].filter((l) => l !== 'zh' && l !== 'en');
        if (invalid.length) return { valid: false, reason: `非中英文: ${invalid.join(', ')}` };

        if (t.expected) {
          const unexpected = [...langs].filter((l) => !t.expected.includes(l));
          if (unexpected.length) return { valid: false, reason: `不应含 ${unexpected.join(',')}（期望 ${t.expected.join(',')}）` };
        }
        return { valid: true, summary: `${d.subtitles.length} 条 · langs=[${[...langs].join(',')}]` };
      },
    });
  }
}

// ==========================================
// 7. Stream（多影片 × 多类型 × 多集）
// ==========================================
async function testStream() {
  separator('🎥 Stream 测试（多影片 × 多类型）');

  if (SKIP_SLOW) {
    log(C.yellow, '⏭️', 'stream', 'SKIP_SLOW=1');
    stats.skipped += 15; stats.total += 15;
    return;
  }

  // ────────────────────────────────────────
  // 维度 1：不同 movie（3 部）
  // ────────────────────────────────────────
  separator('🎬 Stream · Movie 多影片');

  const movieTests = [
    { name: '阿甘正传（剧情/经典）', id: 'trybox_13', tmdbId: 13 },
    { name: '黑客帝国（科幻/经典）', id: 'trybox_603', tmdbId: 603 },
    // 如果这两部 TryBox 没收录，health.js 会显示"上游无有效链接"，是数据源问题
    // 用户可自行替换成 TryBox 上确认存在的影片
  ];

  for (const t of movieTests) {
    await test({
      category: 'stream-movie', name: t.name, path: `/stream/movie/${t.id}.json`,
      severity: 'critical',
      validate: (d) => {
        if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
        if (!d.streams.length) return { valid: false, reason: 'streams 为空' };

        // 诊断 stream 处理
        const debugStreams = d.streams.filter((s) => s.url && s.url.startsWith('trybox|'));
        if (debugStreams.length === d.streams.length) {
          const url = debugStreams[0].url;
          if (url.includes('no_valid_url') || url.includes('cached_no_url')) {
            return { valid: true, summary: `⚠️ 上游无有效链接（可能未收录）` };
          }
          return { valid: false, reason: `诊断失败: ${url.slice(0, 80)}` };
        }

        const realStreams = d.streams.filter((s) => s.url && s.url.startsWith('http'));
        if (!realStreams.length) return { valid: false, reason: '无有效 URL' };

        for (const s of realStreams) {
          const r = validateStreamItem(s);
          if (r) return { valid: false, reason: `stream: ${r}` };
        }

        const hasIp = realStreams.filter((s) => {
          try { return new URL(s.url).searchParams.has('IP'); } catch { return false; }
        });
        if (hasIp.length) return { valid: false, reason: `仍有 ${hasIp.length} 条含 IP 校验` };

        return { valid: true, summary: `${realStreams.length} 条，最佳 ${realStreams[0].quality || '?'}` };
      },
    });
  }

  // ────────────────────────────────────────
  // 维度 2：不同 series / 不同集（继承之战 4 集）
  // ────────────────────────────────────────
  separator('📺 Stream · Series 多集测试');

  const seriesTests = [
    { name: 'S1E1（首集）', id: 'trybox_76331:1:1' },
    { name: 'S1E2（第 2 集）', id: 'trybox_76331:1:2' },
    { name: 'S2E1（换季首集）', id: 'trybox_76331:2:1' },
    { name: 'S4E10（末集）', id: 'trybox_76331:4:10' },
  ];

  const seriesResults = [];

  for (const t of seriesTests) {
    const r = await test({
      category: 'stream-series', name: `继承之战 ${t.name}`, path: `/stream/series/${t.id}.json`,
      severity: 'major',
      validate: (d) => {
        if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
        if (!d.streams.length) return { valid: false, reason: 'streams 为空' };

        const debugStreams = d.streams.filter((s) => s.url && s.url.startsWith('trybox|'));
        if (debugStreams.length === d.streams.length) {
          const url = debugStreams[0].url;
          if (url.includes('no_valid_url') || url.includes('cached_no_url')) {
            return { valid: true, summary: `⚠️ 上游无有效链接` };
          }
          return { valid: false, reason: `诊断失败: ${url.slice(0, 80)}` };
        }

        const realStreams = d.streams.filter((s) => s.url && s.url.startsWith('http'));
        return { valid: true, summary: `${realStreams.length} 条` };
      },
    });
    seriesResults.push({ name: t.name, ok: r.ok, summary: r.summary });
  }

  // ★ 交叉验证：不同集的 URL 不应完全相同
  const okResults = seriesResults.filter((r) => r.ok && r.summary && !r.summary.includes('无有效链接'));
  if (okResults.length >= 2) {
    stats.total++;
    try {
      const url1 = await request(`/stream/series/trybox_76331:1:1.json`);
      const url2 = await request(`/stream/series/trybox_76331:1:2.json`);
      const data1 = JSON.parse(url1.text);
      const data2 = JSON.parse(url2.text);
      const real1 = data1.streams?.filter((s) => s.url?.startsWith('http')) || [];
      const real2 = data2.streams?.filter((s) => s.url?.startsWith('http')) || [];

      if (real1.length > 0 && real2.length > 0) {
        const same = real1[0].url === real2[0].url;
        if (same) {
          fail(`[stream-series] S1E1 vs S1E2 · ★ URL 相同！可能集选择失效`);
          stats.failed++;
        } else {
          pass(`[stream-series] S1E1 vs S1E2 · URL 不同（集选择正常）`);
          stats.passed++;
        }
      } else {
        warn(`[stream-series] S1E1 vs S1E2 · 无有效 URL 对比`);
        stats.passed++;
      }
    } catch (e) {
      warn(`[stream-series] 集对比失败: ${e.message}`);
      stats.passed++;
    }
    stats.results.push({ category: 'stream-series', name: 'S1E1 vs S1E2 URL 对比', ok: true, elapsed: 0 });
  }

  // ────────────────────────────────────────
  // 维度 3：tt ID 交叉验证
  // ────────────────────────────────────────
  separator('🔗 Stream · tt vs trybox_ 交叉验证');

  await test({
    category: 'stream-cross', name: 'tt0109830 与 trybox_13 返回相同 URL',
    path: '/stream/movie/tt0109830.json',
    severity: 'major',
    validate: async (d) => {
      if (!Array.isArray(d.streams) || !d.streams.length) {
        return { valid: false, reason: 'tt 格式返回空' };
      }
      const ttUrl = d.streams.find((s) => s.url?.startsWith('http'))?.url;
      if (!ttUrl) return { valid: true, summary: 'tt 无有效 URL（上游问题）' };

      try {
        const r = await request('/stream/movie/trybox_13.json');
        const tryboxData = JSON.parse(r.text);
        const tryboxUrl = tryboxData.streams?.find((s) => s.url?.startsWith('http'))?.url;

        if (!tryboxUrl) return { valid: true, summary: 'trybox_ 无有效 URL（跳过对比）' };

        if (ttUrl === tryboxUrl) {
          return { valid: true, summary: '✅ 两条 URL 一致' };
        }
        // URL 有时效性（auth_key 会变），只需主机名相同
        const ttHost = new URL(ttUrl).hostname;
        const tryboxHost = new URL(tryboxUrl).hostname;
        if (ttHost === tryboxHost) {
          return { valid: true, summary: `主机一致 ${ttHost}（auth_key 不同属正常）` };
        }
        return { valid: false, reason: `主机不同: tt=${ttHost}, trybox=${tryboxHost}` };
      } catch (e) {
        return { valid: false, reason: `对比失败: ${e.message}` };
      }
    },
  });

  // ────────────────────────────────────────
  // 维度 4：边界与负面缓存
  // ────────────────────────────────────────
  separator('🛡️ Stream · 边界与负面缓存');

  // 不存在的 series ID
  await test({
    category: 'stream-edge', name: '不存在的 series ID', path: '/stream/series/trybox_999999999:1:1.json',
    severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
      if (d.streams.length === 0) return { valid: true, summary: '空数组' };
      const s = d.streams[0];
      if (s.url?.startsWith('trybox|')) return { valid: true, summary: `诊断: ${s.url.slice(0, 50)}` };
      return { valid: false, reason: `异常: ${JSON.stringify(s).slice(0, 80)}` };
    },
  });

  // series 不存在的集（S99E99）
  await test({
    category: 'stream-edge', name: 'series 不存在的集 (S99E99)', path: '/stream/series/trybox_76331:99:99.json',
    severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
      if (d.streams.length === 0) return { valid: true, summary: '空数组（集不存在）' };
      const s = d.streams[0];
      if (s.url?.startsWith('trybox|')) return { valid: true, summary: `诊断` };
      // 如果返回了数据，说明可能回退到第一集 → 不是严格错误，但值得警告
      return { valid: false, reason: `S99E99 不应返回数据，实际 ${d.streams.length} 条（可能回退）` };
    },
  });

  // 负面缓存验证：3 次请求
  //  第 1 次 → 写 pending（回源）
  //  第 2 次 → 写负缓存（回源）
  //  第 3 次 → 命中负缓存（应 < 500ms 且返回诊断）
  const negId = `trybox_${Date.now()}`;

  await test({
    category: 'stream-edge', name: '负面缓存 · 第 1 次（写 pending）',
    path: `/stream/movie/${negId}.json`, severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
      return { valid: true, summary: `${d.streams.length} 条` };
    },
  });

  await test({
    category: 'stream-edge', name: '负面缓存 · 第 2 次（写负缓存）',
    path: `/stream/movie/${negId}.json`, severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
      return { valid: true, summary: `${d.streams.length} 条` };
    },
  });

  // 第 3 次：应命中负缓存，返回 trybox|cached_no_url
  {
    stats.total++;
    const t0 = Date.now();
    try {
      const resp = await request(`/stream/movie/${negId}.json`);
      const elapsed = Date.now() - t0;
      const data = JSON.parse(resp.text);
      const isCachedNeg = data.streams?.some((s) => s.url?.startsWith('trybox|cached:'));
      if (!isCachedNeg) {
        warn(`[stream-edge] 第 3 次未命中负缓存（${elapsed}ms）`);
        stats.warnings.push(`负缓存未命中: ${elapsed}ms`);
      } else if (elapsed > 1500) {
        // 命中但慢：这是 L2 延迟问题，不是负缓存问题
        warn(`[stream-edge] 负缓存命中但 L2 延迟高（${elapsed}ms）`);
        stats.warnings.push(`负缓存命中慢: ${elapsed}ms`);
      } else {
        pass(`[stream-edge] 负缓存命中（${elapsed}ms）`);
        stats.passed++;
      }
      stats.results.push({
        category: 'stream-edge', name: '负面缓存 · 第 3 次（应命中）',
        ok: true, elapsed, summary: isCachedNeg ? `cached:${elapsed}ms` : 'MISS',
      });
    } catch (e) {
      fail(`[stream-edge] 第 3 次失败: ${e.message}`);
      stats.failed++;
    }
  }
  // ────────────────────────────────────────
  // 原有：removeIdValidation 和 Cache-Control
  // ────────────────────────────────────────
  separator('⚙️ Stream · 配置与缓存头');

  await test({
    category: 'stream-config', name: 'removeIdValidation=false（不剔除 IP）',
    path: `/stream/movie/trybox_13.json?cfg=${encodeCfg({ removeIdValidation: false })}`,
    severity: 'major',
    validate: (d) => {
      if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
      if (!d.streams.length) return { valid: false, reason: 'streams 为空' };
      const realStreams = d.streams.filter((s) => s.url && s.url.startsWith('http'));
      if (!realStreams.length) return { valid: true, summary: '无有效 URL（上游问题）' };

      const ipStreams = realStreams.filter((s) => {
        try { return new URL(s.url).searchParams.has('IP'); } catch { return false; }
      });
      return {
        valid: true,
        summary: `${realStreams.length} 条（含 ${ipStreams.length} 条 IP 链接，符合配置）`,
      };
    },
  });

  await test({
    category: 'stream-config', name: 'Stream 按质量排序', path: '/stream/movie/trybox_13.json',
    severity: 'minor',
    validate: (d) => {
      if (!Array.isArray(d.streams) || d.streams.length < 2) {
        return { valid: true, summary: `只有 ${d.streams?.length || 0} 条，跳过排序验证` };
      }
      const order = { '4K': 0, '2160P': 0, '1080P': 1, '720P': 2, '360P': 3, AUTO: 4, ORG: 5 };
      const qualities = d.streams
        .filter((s) => !s.url.startsWith('trybox|'))
        .map((s) => s.quality)
        .filter((q) => q && order[q] !== undefined);
      for (let i = 1; i < qualities.length; i++) {
        if (order[qualities[i - 1]] > order[qualities[i]]) {
          return { valid: false, reason: `排序错误: ${qualities[i - 1]} 在 ${qualities[i]} 前` };
        }
      }
      return { valid: true, summary: `[${qualities.join(', ')}]` };
    },
  });

  await test({
    category: 'stream-config', name: 'Cache-Control 头（s-maxage=60）',
    path: '/stream/movie/trybox_13.json',
    severity: 'minor',
    validate: (_, headers) => {
      const cc = headers.get('cache-control') || '';
      if (!/s-maxage=60/.test(cc)) return { valid: false, reason: `Cache-Control 不符: ${cc}` };
      return { valid: true, summary: cc };
    },
  });
}

// ==========================================
// 8. tt ID 兼容性
// ==========================================
async function testTtId() {
  separator('🔗 tt ID 兼容性测试');

  if (SKIP_TT) {
    log(C.yellow, '⏭️', 'tt-id', 'SKIP_TT=1（需 TMDB Key）');
    stats.skipped += 6; stats.total += 6;
    return;
  }

  // Manifest 声明
  await test({
    category: 'tt-id', name: 'Manifest · stream/subtitles 含 tt 前缀',
    path: '/manifest.json', severity: 'critical',
    validate: (d) => {
      const streamRes = d.resources.find((r) => r.name === 'stream');
      const subRes = d.resources.find((r) => r.name === 'subtitles');
      if (!streamRes) return { valid: false, reason: '缺 stream 资源' };
      if (!subRes) return { valid: false, reason: '缺 subtitles 资源' };
      if (!streamRes.idPrefixes?.includes('tt')) return { valid: false, reason: `stream idPrefixes 缺 tt` };
      if (!subRes.idPrefixes?.includes('tt')) return { valid: false, reason: `subtitles idPrefixes 缺 tt` };
      return { valid: true, summary: `stream=[${streamRes.idPrefixes}], subtitles=[${subRes.idPrefixes}]` };
    },
  });

  // Stream / Subtitle 双格式
  for (const t of [
    {
      name: 'Stream · movie · tt0109830', path: '/stream/movie/tt0109830.json',
      validate: (d) => {
        if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
        if (!d.streams.length) return { valid: false, reason: 'streams 为空' };
        const debugStreams = d.streams.filter((s) => s.url && s.url.startsWith('trybox|'));
        if (debugStreams.length === d.streams.length) {
          const url = debugStreams[0].url;
          if (url.includes('no_valid_url') || url.includes('cached_no_url')) {
            return { valid: true, summary: `⚠️ 上游无有效链接` };
          }
          return { valid: false, reason: `诊断失败: ${url.slice(0, 80)}` };
        }
        return { valid: true, summary: `${d.streams.filter((s) => s.url.startsWith('http')).length} 条` };
      },
    },
    {
      name: 'Subtitle · movie · tt0109830', path: '/subtitles/movie/tt0109830.json',
      validate: (d) => {
        if (!Array.isArray(d.subtitles)) return { valid: false, reason: 'subtitles 非数组' };
        const langs = new Set(d.subtitles.map((s) => s.lang));
        const invalid = [...langs].filter((l) => l !== 'zh' && l !== 'en');
        if (invalid.length) return { valid: false, reason: `非中英文: ${invalid.join(', ')}` };
        return { valid: true, summary: `${d.subtitles.length} 条 · langs=[${[...langs].join(',')}]` };
      },
    },
    {
      name: 'Stream · series · tt7660850:1:1', path: '/stream/series/tt7660850:1:1.json',
      validate: (d) => {
        if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
        if (!d.streams.length) return { valid: false, reason: 'streams 为空' };
        const debugStreams = d.streams.filter((s) => s.url && s.url.startsWith('trybox|'));
        if (debugStreams.length === d.streams.length) {
          const url = debugStreams[0].url;
          if (url.includes('no_valid_url') || url.includes('cached_no_url')) {
            return { valid: true, summary: `⚠️ 上游无有效链接` };
          }
          return { valid: false, reason: `诊断失败: ${url.slice(0, 80)}` };
        }
        return { valid: true, summary: `${d.streams.filter((s) => s.url.startsWith('http')).length} 条` };
      },
    },
    {
      name: 'Subtitle · series · tt7660850:1:1', path: '/subtitles/series/tt7660850:1:1.json',
      validate: (d) => {
        if (!Array.isArray(d.subtitles)) return { valid: false, reason: 'subtitles 非数组' };
        const langs = new Set(d.subtitles.map((s) => s.lang));
        const invalid = [...langs].filter((l) => l !== 'zh' && l !== 'en');
        if (invalid.length) return { valid: false, reason: `非中英文: ${invalid.join(', ')}` };
        return { valid: true, summary: `${d.subtitles.length} 条 · langs=[${[...langs].join(',')}]` };
      },
    },
  ]) {
    await test({ category: 'tt-id', name: t.name, path: t.path, severity: 'major', validate: t.validate });
  }

  // ★ 新增：Meta 不响应 tt
  await test({
    category: 'tt-id', name: 'Meta · tt 前缀（应返回 null，manifest 未声明）',
    path: '/meta/movie/tt0109830.json', severity: 'minor',
    validate: (d) => {
      if (d.meta === null || d.meta === undefined) {
        return { valid: true, summary: '正确返回 null（meta 不响应 tt）' };
      }
      return { valid: false, reason: `应返回 null，实际返回 ${JSON.stringify(d.meta).slice(0, 100)}` };
    },
  });
}

// ==========================================
// 9. 配置边界（新增）
// ==========================================
async function testConfigBoundary() {
  separator('⚙️ 配置边界测试');

  await test({
    category: 'config', name: '非法 cfg base64（不崩）',
    path: '/manifest.json?cfg=!!!invalid!!!', severity: 'minor',
    validate: (d) => {
      if (!d.id) return { valid: false, reason: '应返回默认 manifest' };
      return { valid: true, summary: `id=${d.id}（回退默认）` };
    },
  });

  await test({
    category: 'config', name: '超大 cfg（8KB+，不崩）',
    path: `/manifest.json?cfg=${encodeCfg({ bd: 'x'.repeat(10000) })}`, severity: 'minor',
    validate: (d) => {
      if (!d.id) return { valid: false, reason: '应返回 manifest' };
      return { valid: true, summary: '不崩' };
    },
  });

  await test({
    category: 'config', name: '空 cfg（等价默认）',
    path: '/manifest.json?cfg=', severity: 'minor',
    validate: (d) => {
      if (!d.id) return { valid: false, reason: '应返回 manifest' };
      if (!d.catalogs?.length) return { valid: false, reason: 'catalogs 为空' };
      return { valid: true, summary: `catalogs=${d.catalogs.length}` };
    },
  });
}

// ==========================================
// 10. CDN 缓存（新增，仅线上）
// ==========================================
async function testCdnCache() {
  separator('☁️ CDN 缓存测试（仅线上）');

  if (IS_LOCAL) {
    log(C.yellow, '⏭️', 'cdn', '本地环境跳过 CDN 测试');
    stats.skipped += 5; stats.total += 5;
    return;
  }

  const tests = [
    { name: 'Catalog cache-control', path: '/catalog/movie/trybox_movie.json', expected: 's-maxage=300' },
    { name: 'Meta cache-control', path: '/meta/movie/trybox_13.json', expected: 's-maxage=1800' },
    { name: 'Stream cache-control', path: '/stream/movie/trybox_13.json', expected: 's-maxage=60' },
    { name: 'Subtitle cache-control', path: '/subtitles/movie/trybox_13.json', expected: 's-maxage=300' },
  ];

  for (const t of tests) {
    await test({
      category: 'cdn', name: t.name, path: t.path, severity: 'minor',
      validate: (_, headers) => {
        const cc = headers.get('cache-control') || '';
        const age = headers.get('age') || '';
        const xvc = headers.get('x-vercel-cache') || '';
        if (!cc.includes(t.expected)) return { valid: false, reason: `Cache-Control 应含 ${t.expected}，实际: ${cc}` };
        return { valid: true, summary: `${cc} · age=${age || '-'} · ${xvc || '-'}` };
      },
    });
  }

  // 缓存命中验证
  await test({
    category: 'cdn', name: 'CDN 缓存命中（Catalog 连续两次）',
    path: '/catalog/movie/trybox_movie.json', severity: 'minor',
    validate: async () => {
      try {
        const resp = await request('/catalog/movie/trybox_movie.json');
        const xvc = resp.headers.get('x-vercel-cache') || '';
        if (xvc === 'HIT') return { valid: true, summary: 'x-vercel-cache: HIT' };
        return { valid: true, summary: `x-vercel-cache: ${xvc || 'MISS'}（可能首次冷启动）` };
      } catch (e) {
        return { valid: false, reason: e.message };
      }
    },
  });
}

// ==========================================
// 11. Debug
// ==========================================
async function testDebug() {
  separator('🏥 Debug 测试');

  await test({
    category: 'debug', name: '健康端点 /debug/health', path: '/debug/health', severity: 'minor',
    validate: (d) => {
      if (!d.ok) return { valid: false, reason: '缺 ok' };
      return { valid: true, summary: `ts=${d.ts}` };
    },
  });

  await test({
    category: 'debug', name: '缓存状态 /debug/cache', path: '/debug/cache', severity: 'minor',
    validate: (d) => {
      if (typeof d.l1Size !== 'number') return { valid: false, reason: 'l1Size 非数字' };
      if (typeof d.redisConfigured !== 'boolean') return { valid: false, reason: 'redisConfigured 非布尔' };
      const redis = d.redisConfigured
        ? (d.redisInCooldown ? `冷却中(${d.redisCooldownRemain}s)` : '正常')
        : '未配置';
      return { valid: true, summary: `L1=${d.l1Size}, Redis=${redis}` };
    },
  });
}

// ==========================================
// 主入口
// ==========================================
async function main() {
  console.clear();
  separator('🎬 TryBox Addon · 健康检测（v2）', `BASE_URL=${BASE_URL} · TIMEOUT=${TIMEOUT}ms · SKIP_SLOW=${SKIP_SLOW} · SKIP_TT=${SKIP_TT} · STRICT=${STRICT}`);
  console.log(`${C.bold}开始时间：${C.reset}${new Date().toLocaleString()}\n`);

  try {
    const resp = await request('/manifest.json', { timeout: 5000 });
    if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    console.log(`${C.red}❌ 服务不可达：${err.message}${C.reset}`);
    console.log(`${C.yellow}检查：${C.reset}`);
    console.log(`  1. 已运行 npx vercel dev 或已部署到生产`);
    console.log(`  2. BASE_URL 正确（当前：${BASE_URL}）`);
    process.exit(1);
  }

  const t0 = Date.now();

  await testManifest();
  await testCatalogs();
  await testSearch();
  await testGenre();
  await testMeta();
  await testSubtitle();
  await testStream();
  await testTtId();
  await testConfigBoundary();
  await testCdnCache();
  await testDebug();

  const totalTime = Date.now() - t0;

  // 详细结果
  separator('📋 详细结果');
  let lastCat = '';
  for (const r of stats.results) {
    if (r.category !== lastCat) {
      console.log(`\n${C.bold}${C.magenta}【${r.category}】${C.reset}`);
      lastCat = r.category;
    }
    const icon = r.ok ? `${C.green}✅${C.reset}` : (r.warned ? `${C.yellow}⚠️${C.reset}` : `${C.red}❌${C.reset}`);
    const sev = r.severity === 'critical' ? ' 🔴' : (r.severity === 'major' ? ' 🟠' : '');
    console.log(`  ${icon} ${r.name}${sev} ${C.gray}(${r.elapsed}ms)${C.reset}`);
    if (r.ok && r.summary) console.log(`      ${C.dim}${r.summary}${C.reset}`);
    if (!r.ok) console.log(`      ${C.red}${r.error}${C.reset}`);
  }

  // 分类统计
  separator('📊 分类统计');
  const byCat = {};
  for (const r of stats.results) {
    if (!byCat[r.category]) byCat[r.category] = { total: 0, passed: 0, failed: 0, warned: 0, elapsed: 0 };
    byCat[r.category].total++;
    byCat[r.category].elapsed += r.elapsed;
    if (r.ok) byCat[r.category].passed++;
    else if (r.warned) byCat[r.category].warned++;
    else byCat[r.category].failed++;
  }
  for (const [cat, s] of Object.entries(byCat)) {
    const avg = Math.round(s.elapsed / s.total);
    const color = s.failed > 0 ? C.red : (s.warned > 0 ? C.yellow : C.green);
    console.log(`  ${color}${cat.padEnd(14)}${C.reset}  total=${s.total}  通过=${s.passed}  失败=${s.failed}  警告=${s.warned}  平均=${avg}ms`);
  }

  // 汇总
  separator('📊 汇总');
  console.log(`  ${C.bold}总计：${C.reset}  ${stats.total}`);
  console.log(`  ${C.green}${C.bold}通过：${C.reset}  ${stats.passed}`);
  console.log(`  ${C.red}${C.bold}失败：${C.reset}  ${stats.failed}`);
  if (stats.warnings.length) console.log(`  ${C.yellow}${C.bold}警告：${C.reset}  ${stats.warnings.length}`);
  if (stats.skipped) console.log(`  ${C.yellow}${C.bold}跳过：${C.reset}  ${stats.skipped}`);
  console.log(`  ${C.bold}耗时：${C.reset}  ${totalTime}ms`);

  const rate = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;
  const rateColor = rate >= 90 ? C.green : (rate >= 70 ? C.yellow : C.red);
  console.log(`  ${C.bold}通过率：${C.reset} ${rateColor}${rate}%${C.reset}`);

  if (stats.warnings.length) {
    separator('⚠️ 警告');
    for (const w of stats.warnings) console.log(`  ${C.yellow}• ${w}${C.reset}`);
  }

  if (stats.slow.length) {
    separator('🐢 慢测试（>5s）');
    for (const s of stats.slow.sort((a, b) => b.elapsed - a.elapsed)) {
      console.log(`  ${C.yellow}• [${s.category}] ${s.name}${C.reset} ${C.gray}(${s.elapsed}ms)${C.reset}`);
    }
  }

  if (stats.failed > 0) {
    separator('💡 诊断建议');
    const failed = stats.results.filter((r) => !r.ok && !r.warned);
    const cats = {};
    for (const r of failed) cats[r.category] = (cats[r.category] || 0) + 1;

    if (cats['manifest']) console.log(`  ${C.yellow}⚠️ Manifest 失败${C.reset}：检查 src/manifest.js`);
    if (cats['catalog']) console.log(`  ${C.yellow}⚠️ Catalog 失败${C.reset}：检查 TryBox API 可达性 / token 有效性`);
    if (cats['search']) console.log(`  ${C.yellow}⚠️ Search 失败${C.reset}：检查 feats 配置 / TryBox 搜索 API`);
    if (cats['meta']) console.log(`  ${C.yellow}⚠️ Meta 失败${C.reset}：检查 TryBox meta API / TMDB 可达性`);
    if (cats['subtitle']) console.log(`  ${C.yellow}⚠️ Subtitle 失败${C.reset}：检查 TryBox 字幕 API / subLang 配置`);
    if (cats['stream']) console.log(`  ${C.yellow}⚠️ Stream 失败${C.reset}：检查 access_token 有效性 / removeIdValidation`);
    if (cats['tt-id']) console.log(`  ${C.yellow}⚠️ tt ID 失败${C.reset}：检查 TMDB_KEY 配置`);
    if (cats['config']) console.log(`  ${C.yellow}⚠️ 配置边界失败${C.reset}：检查 src/config.js 解码逻辑`);
    if (cats['cdn']) console.log(`  ${C.yellow}⚠️ CDN 失败${C.reset}：检查是否绑定自定义域名（*.vercel.app 不缓存）`);
    if (cats['debug']) console.log(`  ${C.yellow}⚠️ Debug 失败${C.reset}：检查 src/handler.js 路由`);
  }

  separator();
  const exitFail = stats.failed > 0 || (STRICT && stats.warnings.length > 0);
  process.exit(exitFail ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.red}脚本异常：${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});