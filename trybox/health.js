#!/usr/bin/env node

/**
 * TryBox Addon 健康检测
 *
 * 覆盖维度：
 *   - Manifest：默认配置、功能开关、catalog 选择、格式校验
 *   - Catalog：所有启用的 catalog × 每个实际支持的 type
 *   - Search：关键词搜索
 *   - Genre：genre 筛选
 *   - Meta：movie / series（含 videos 校验）
 *   - Subtitle：仅中英文过滤
 *   - Stream：IP 校验剔除、debug stream 检测
 *   - tt ID 兼容性：stream/subtitle 的 tt 前缀支持
 *   - Debug：健康端点
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000' ;
const TIMEOUT = parseInt(process.env.TIMEOUT || '30000', 10);
const SKIP_SLOW = process.env.SKIP_SLOW === '1';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
  magenta: '\x1b[35m',
};

const stats = { total: 0, passed: 0, failed: 0, skipped: 0, results: [] };

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

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    return await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function test({ category, name, path, validate, skip = false, skipReason = '' }) {
  stats.total++;

  if (skip) {
    stats.skipped++;
    log(C.yellow, '⏭️', category, `${name} ${C.gray}(跳过: ${skipReason})${C.reset}`);
    return { ok: false, skipped: true };
  }

  const t0 = Date.now();
  const result = { category, name, ok: false, elapsed: 0, error: null, summary: null };

  try {
    const resp = await request(path);
    const elapsed = Date.now() - t0;
    result.elapsed = elapsed;

    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(`JSON 解析失败: ${e.message} | 前 200 字: ${text.slice(0, 200)}`); }

    const v = await validate(data);
    if (!v || !v.valid) throw new Error(v?.reason || '校验失败');

    result.ok = true;
    result.summary = v.summary || 'OK';
    log(C.green, '✅', category, `${name} ${C.gray}(${elapsed}ms)${C.reset} ${C.dim}${v.summary || ''}${C.reset}`);
    stats.passed++;
    stats.results.push(result);
    return result;
  } catch (err) {
    const elapsed = Date.now() - t0;
    result.elapsed = elapsed;
    result.error = err.name === 'AbortError' ? `超时(>${TIMEOUT}ms)` : err.message;
    log(C.red, '❌', category, `${name} ${C.gray}(${elapsed}ms)${C.reset}`);
    console.log(`         ${C.red}${result.error}${C.reset}`);
    stats.failed++;
    stats.results.push(result);
    return result;
  }
}

function encodeCfg(config) {
  return Buffer.from(JSON.stringify(config), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ============================================================
// 分组 1：Manifest
// ============================================================
async function testManifest() {
  separator('📋 Manifest 测试');

  await test({
    category: 'manifest', name: '默认配置', path: '/manifest.json',
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
    category: 'manifest', name: '资源类型完整', path: '/manifest.json',
    validate: (d) => {
      const names = d.resources.map((r) => typeof r === 'string' ? r : r.name);
      const required = ['catalog', 'meta', 'subtitles', 'stream'];
      const missing = required.filter((n) => !names.includes(n));
      if (missing.length) return { valid: false, reason: `缺少: ${missing.join(', ')}` };
      return { valid: true, summary: `[${names.join(', ')}]` };
    },
  });

  await test({
    category: 'manifest', name: '关闭 stream', path: `/manifest.json?cfg=${encodeCfg({ feats: ['catalog', 'meta', 'subtitle'] })}`,
    validate: (d) => {
      const names = d.resources.map((r) => typeof r === 'string' ? r : r.name);
      if (names.includes('stream')) return { valid: false, reason: '应不含 stream' };
      if (!names.includes('subtitles')) return { valid: false, reason: '应含 subtitles' };
      return { valid: true, summary: `[${names.join(', ')}]` };
    },
  });

  await test({
    category: 'manifest', name: '仅 topRated', path: `/manifest.json?cfg=${encodeCfg({ cats: ['topRated'] })}`,
    validate: (d) => {
      const ids = d.catalogs.map((c) => c.id);
      if (!ids.every((id) => id === 'trybox_topRated')) return { valid: false, reason: `实际: ${ids.join(', ')}` };
      return { valid: true, summary: `[${ids.join(', ')}]` };
    },
  });

  await test({
    category: 'manifest', name: 'movie + tv', path: `/manifest.json?cfg=${encodeCfg({ cats: ['movie', 'tv'] })}`,
    validate: (d) => {
      const ids = new Set(d.catalogs.map((c) => c.id));
      if (!ids.has('trybox_movie')) return { valid: false, reason: '缺 trybox_movie' };
      if (!ids.has('trybox_tv')) return { valid: false, reason: '缺 trybox_tv' };
      return { valid: true, summary: `[${[...ids].join(', ')}]` };
    },
  });
}

// ============================================================
// 分组 2：Catalog
// ============================================================
async function testCatalogs() {
  separator('🎬 Catalog 测试');

  const catalogDefs = [
    { key: 'home',      types: ['movie', 'series'] },
    { key: 'movie',     types: ['movie'] },
    { key: 'tv',        types: ['series'] },
    { key: 'trending',  types: ['movie', 'series'] },
    { key: 'popular',   types: ['movie'] },
    { key: 'topRated',  types: ['movie'] },
    { key: 'secondary', types: ['series'] },
    { key: 'tertiary',  types: ['series'] },
  ];

  for (const def of catalogDefs) {
    for (const type of def.types) {
      await test({
        category: 'catalog',
        name: `${def.key} · ${type}`,
        path: `/catalog/${type}/trybox_${def.key}.json`,
        validate: (d) => {
          if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
          if (!d.metas.length) return { valid: false, reason: 'metas 为空' };
          const first = d.metas[0];
          if (!first.id) return { valid: false, reason: '首条缺 id' };
          if (!first.type) return { valid: false, reason: '首条缺 type' };
          if (!first.name) return { valid: false, reason: '首条缺 name' };
          if (first.type !== type) return { valid: false, reason: `type 应 ${type}，实际 ${first.type}` };
          if (!first.id.startsWith('trybox_')) return { valid: false, reason: `id 前缀错误: ${first.id}` };
          return { valid: true, summary: `${d.metas.length} 条 · "${first.name}"` };
        },
      });
    }
  }
}

// ============================================================
// 分组 3：Search
// ============================================================
async function testSearch() {
  separator('🔍 Search 测试');

  for (const kw of ['阿甘正传', '生化危机', '继承之战']) {
    await test({
      category: 'search',
      name: `"${kw}"`,
      path: `/catalog/movie/trybox_movie.json?search=${encodeURIComponent(kw)}`,
      validate: (d) => {
        if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
        return { valid: true, summary: `${d.metas.length} 条` };
      },
    });
  }
}

// ============================================================
// 分组 4：Genre
// ============================================================
async function testGenre() {
  separator('🎭 Genre 测试');

  for (const g of [
    { type: 'movie', genre: '动作' },
    { type: 'movie', genre: '科幻' },
    { type: 'series', genre: '犯罪' },
    { type: 'series', genre: '科幻' },
  ]) {
    await test({
      category: 'genre',
      name: `${g.type} · ${g.genre}`,
      path: `/catalog/${g.type}/trybox_movie.json?genre=${encodeURIComponent(g.genre)}`,
      validate: (d) => {
        if (!Array.isArray(d.metas)) return { valid: false, reason: 'metas 非数组' };
        return { valid: true, summary: `${d.metas.length} 条` };
      },
    });
  }
}

// ============================================================
// 分组 5：Meta
// ============================================================
async function testMeta() {
  separator('📺 Meta 测试');

  await test({
    category: 'meta', name: 'movie · 阿甘正传',
    path: '/meta/movie/trybox_13.json',
    validate: (d) => {
      if (!d.meta) return { valid: false, reason: 'meta 为空' };
      if (d.meta.type !== 'movie') return { valid: false, reason: `type 应 movie，实际 ${d.meta.type}` };
      return { valid: true, summary: `"${d.meta.name}" (${d.meta.releaseInfo || 'N/A'})` };
    },
  });

  await test({
    category: 'meta', name: 'series · 继承之战',
    path: '/meta/series/trybox_76331.json',
    validate: (d) => {
      if (!d.meta) return { valid: false, reason: 'meta 为空' };
      if (d.meta.type !== 'series') return { valid: false, reason: `type 应 series` };
      if (!Array.isArray(d.meta.videos) || !d.meta.videos.length) return { valid: false, reason: 'videos 为空' };
      const first = d.meta.videos[0];
      if (!first.id.includes(':')) return { valid: false, reason: `videos[0].id 缺 :season:episode` };
      return { valid: true, summary: `"${d.meta.name}" · ${d.meta.videos.length} 集` };
    },
  });
}

// ============================================================
// 分组 6：Subtitle
// ============================================================
async function testSubtitle() {
  separator('💬 Subtitle 测试');

  if (SKIP_SLOW) {
    log(C.yellow, '⏭️', 'subtitle', 'SKIP_SLOW=1');
    stats.skipped += 2; stats.total += 2;
    return;
  }

  for (const t of [
    { name: 'movie · 阿甘正传', path: '/subtitles/movie/trybox_13.json' },
    { name: 'series · 继承之战 S1E1', path: '/subtitles/series/trybox_76331:1:1.json' },
  ]) {
    await test({
      category: 'subtitle', name: t.name, path: t.path,
      validate: (d) => {
        if (!Array.isArray(d.subtitles)) return { valid: false, reason: 'subtitles 非数组' };
        const langs = new Set(d.subtitles.map((s) => s.lang));
        const invalid = [...langs].filter((l) => l !== 'zh' && l !== 'en');
        if (invalid.length) return { valid: false, reason: `非中英文: ${invalid.join(', ')}` };
        return { valid: true, summary: `${d.subtitles.length} 条 · langs=[${[...langs].join(',')}]` };
      },
    });
  }
}

// ============================================================
// 分组 7：Stream
// ============================================================
async function testStream() {
  separator('🎥 Stream 测试');

  if (SKIP_SLOW) {
    log(C.yellow, '⏭️', 'stream', 'SKIP_SLOW=1');
    stats.skipped += 2; stats.total += 2;
    return;
  }

  for (const t of [
    { name: 'movie · 阿甘正传', path: '/stream/movie/trybox_13.json' },
    { name: 'series · 继承之战 S1E1', path: '/stream/series/trybox_76331:1:1.json' },
  ]) {
    await test({
      category: 'stream', name: t.name, path: t.path,
      validate: (d) => {
        if (!Array.isArray(d.streams)) return { valid: false, reason: 'streams 非数组' };
        if (!d.streams.length) return { valid: false, reason: 'streams 为空' };

        // 诊断 stream：区分类型
        const debugStreams = d.streams.filter((s) => s.url && s.url.startsWith('trybox|'));
        if (debugStreams.length === d.streams.length) {
          const url = debugStreams[0].url;
          // 上游无数据 → 不算失败（上游行为，非 addon bug）
          if (url.includes('no_valid_url') || url.includes('cached_no_url')) {
            return { valid: true, summary: `⚠️ 上游无有效链接` };
          }
          // token / http / decode 失败 → 真实失败
          return { valid: false, reason: `诊断失败: ${url.slice(0, 80)}` };
        }

        const realStreams = d.streams.filter((s) => s.url && s.url.startsWith('http'));
        if (!realStreams.length) return { valid: false, reason: '无有效 URL' };

        const hasIp = realStreams.filter((s) => {
          try { return new URL(s.url).searchParams.has('IP'); } catch { return false; }
        });
        if (hasIp.length) return { valid: false, reason: `仍有 ${hasIp.length} 条含 IP 校验` };

        return { valid: true, summary: `${realStreams.length} 条，最佳 ${realStreams[0].quality || '?'}` };
      },
    });
  }
}

// ============================================================
// 分组 8：tt ID 兼容性
// ============================================================
async function testTtId() {
  separator('🔗 tt ID 兼容性测试');

  // Manifest 校验：stream / subtitles 的 idPrefixes 应含 tt
  await test({
    category: 'tt-id',
    name: 'Manifest · stream/subtitles 含 tt 前缀',
    path: '/manifest.json',
    validate: (d) => {
      const streamRes = d.resources.find((r) => r.name === 'stream');
      const subRes = d.resources.find((r) => r.name === 'subtitles');
      if (!streamRes) return { valid: false, reason: '缺 stream 资源' };
      if (!subRes) return { valid: false, reason: '缺 subtitles 资源' };
      if (!streamRes.idPrefixes?.includes('tt')) {
        return { valid: false, reason: `stream idPrefixes 缺 tt: ${JSON.stringify(streamRes.idPrefixes)}` };
      }
      if (!subRes.idPrefixes?.includes('tt')) {
        return { valid: false, reason: `subtitles idPrefixes 缺 tt: ${JSON.stringify(subRes.idPrefixes)}` };
      }
      return {
        valid: true,
        summary: `stream=[${streamRes.idPrefixes}], subtitles=[${subRes.idPrefixes}]`,
      };
    },
  });

  // Stream (movie, tt)：tt0109830 = 阿甘正传 = tmdb 13
  await test({
    category: 'tt-id',
    name: 'Stream · movie · tt0109830',
    path: '/stream/movie/tt0109830.json',
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
      return {
        valid: true,
        summary: `${realStreams.length} 条（tt → tmdb 13）`,
      };
    },
  });

  // Subtitle (movie, tt)：应直接使用 imdbId，不经过 meta
  await test({
    category: 'tt-id',
    name: 'Subtitle · movie · tt0109830',
    path: '/subtitles/movie/tt0109830.json',
    validate: (d) => {
      if (!Array.isArray(d.subtitles)) return { valid: false, reason: 'subtitles 非数组' };
      const langs = new Set(d.subtitles.map((s) => s.lang));
      const invalid = [...langs].filter((l) => l !== 'zh' && l !== 'en');
      if (invalid.length) return { valid: false, reason: `非中英文: ${invalid.join(', ')}` };
      return {
        valid: true,
        summary: `${d.subtitles.length} 条 · langs=[${[...langs].join(',')}]`,
      };
    },
  });

  // Stream (series, tt)：tt7660850 = 继承之战 = tmdb 76331
  await test({
    category: 'tt-id',
    name: 'Stream · series · tt7660850:1:1',
    path: '/stream/series/tt7660850:1:1.json',
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
      return {
        valid: true,
        summary: `${realStreams.length} 条（tt → tmdb 76331）`,
      };
    },
  });

  // Subtitle (series, tt)
  await test({
    category: 'tt-id',
    name: 'Subtitle · series · tt7660850:1:1',
    path: '/subtitles/series/tt7660850:1:1.json',
    validate: (d) => {
      if (!Array.isArray(d.subtitles)) return { valid: false, reason: 'subtitles 非数组' };
      const langs = new Set(d.subtitles.map((s) => s.lang));
      const invalid = [...langs].filter((l) => l !== 'zh' && l !== 'en');
      if (invalid.length) return { valid: false, reason: `非中英文: ${invalid.join(', ')}` };
      return {
        valid: true,
        summary: `${d.subtitles.length} 条 · langs=[${[...langs].join(',')}]`,
      };
    },
  });
}

// ============================================================
// 分组 9：Debug
// ============================================================
async function testDebug() {
  separator('🏥 Debug 测试');
  await test({
    category: 'debug', name: '健康端点', path: '/debug/health',
    validate: (d) => {
      if (!d.ok) return { valid: false, reason: '缺 ok' };
      return { valid: true, summary: `ts=${d.ts}` };
    },
  });
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  console.clear();
  separator('🎬 TryBox Addon · 健康检测', `BASE_URL=${BASE_URL} · TIMEOUT=${TIMEOUT}ms · SKIP_SLOW=${SKIP_SLOW}`);
  console.log(`${C.bold}开始时间：${C.reset}${new Date().toLocaleString()}\n`);

  try {
    const resp = await request('/manifest.json', { timeout: 5000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    console.log(`${C.red}❌ 服务不可达：${err.message}${C.reset}`);
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
  await testDebug();
  const totalTime = Date.now() - t0;

  separator('📋 详细结果');
  let lastCat = '';
  for (const r of stats.results) {
    if (r.category !== lastCat) {
      console.log(`\n${C.bold}${C.magenta}【${r.category}】${C.reset}`);
      lastCat = r.category;
    }
    const icon = r.ok ? `${C.green}✅${C.reset}` : `${C.red}❌${C.reset}`;
    console.log(`  ${icon} ${r.name} ${C.gray}(${r.elapsed}ms)${C.reset}`);
    if (r.ok && r.summary) console.log(`      ${C.dim}${r.summary}${C.reset}`);
    if (!r.ok) console.log(`      ${C.red}${r.error}${C.reset}`);
  }

  separator('📊 汇总');
  console.log(`  ${C.bold}总计：${C.reset}  ${stats.total}`);
  console.log(`  ${C.green}${C.bold}通过：${C.reset}  ${stats.passed}`);
  console.log(`  ${C.red}${C.bold}失败：${C.reset}  ${stats.failed}`);
  if (stats.skipped) console.log(`  ${C.yellow}${C.bold}跳过：${C.reset}  ${stats.skipped}`);
  console.log(`  ${C.bold}耗时：${C.reset}  ${totalTime}ms`);

  const rate = stats.total - stats.skipped > 0
    ? Math.round((stats.passed / (stats.total - stats.skipped)) * 100)
    : 0;
  const rateColor = rate >= 90 ? C.green : rate >= 70 ? C.yellow : C.red;
  console.log(`  ${C.bold}通过率：${C.reset} ${rateColor}${rate}%${C.reset}`);

  if (stats.failed > 0) {
    separator('💡 诊断');
    const byCat = {};
    for (const r of stats.results) {
      if (!r.ok) { byCat[r.category] = byCat[r.category] || []; byCat[r.category].push(r); }
    }
    for (const [cat, items] of Object.entries(byCat)) {
      console.log(`\n${C.yellow}⚠️ ${cat} 失败 ${items.length} 项：${C.reset}`);
      for (const r of items) {
        console.log(`  ${C.red}• ${r.name}${C.reset}`);
        console.log(`    ${C.gray}${r.error}${C.reset}`);
      }
    }
  }

  separator();
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.red}脚本异常：${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
