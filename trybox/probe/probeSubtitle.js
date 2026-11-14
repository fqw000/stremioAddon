// trybox-subtitle-probe.js
// 用法：
// 1. 浏览器：打开 https://trybox.app，F12 -> Console 粘贴运行
// 2. Node 18+：保存为 trybox-subtitle-probe.js 后 node trybox-subtitle-probe.js

const SUBTITLE_API_URL = 'https://trybox.app/api/public/subtitles';

const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// 构造 subtitle 请求参数（缺失的自动省略）
function buildSubtitleQuery({ imdbId, language, title, year, v = 8 } = {}) {
  const params = new URLSearchParams();
  if (imdbId) params.set('imdb_id', imdbId);
  if (language) params.set('language', language); // 空/不传 = 返回所有语言
  if (title) params.set('title', title);
  if (year) params.set('year', String(year));
  if (v != null) params.set('v', String(v));
  return params.toString();
}

// 数据量统计
function summarize(data, rawText, elapsed) {
  const rawSize = new TextEncoder().encode(rawText).length;
  const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];

  // 按语言分组
  const byLang = {};
  // 按来源分组
  const bySource = {};
  // 按格式分组
  const byFormat = {};

  for (const s of subs) {
    const lang = s?.language || '(未知)';
    const src = s?.source || '(未知)';
    const fmt = s?.format || '(未知)';
    byLang[lang] = (byLang[lang] || 0) + 1;
    bySource[src] = (bySource[src] || 0) + 1;
    byFormat[fmt] = (byFormat[fmt] || 0) + 1;
  }

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: +(rawSize / 1024).toFixed(2),
    原始大小Bytes: rawSize,
    顶层字段: Object.keys(data || {}),
    字幕总数: subs.length,
    语言分布: byLang,
    来源分布: bySource,
    格式分布: byFormat
  };
}

// 字段完整性统计（针对 subtitles 数组每一项）
function fieldStats(data) {
  const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];
  const fields = ['id', 'url', 'format', 'language', 'display', 'release',
                  'source', 'downloadCount', 'isHearingImpaired', 'matchScore'];
  const stats = {};
  fields.forEach(f => stats[f] = { present: 0, missing: 0 });

  for (const s of subs) {
    for (const f of fields) {
      const v = s?.[f];
      if (v === null || v === undefined || v === '') stats[f].missing++;
      else stats[f].present++;
    }
  }
  return { total: subs.length, stats };
}

// 主探针函数
async function fetchSubtitles(opts = {}, lang = 'zh-CN') {
  const query = buildSubtitleQuery(opts);
  const url = `${SUBTITLE_API_URL}?${query}`;
  console.log(`[subtitle] 请求参数: ${JSON.stringify(opts)}`);
  console.log(`[subtitle] URL: ${url}`);

  const t0 = now();
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const rawText = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const data = JSON.parse(rawText);

  console.log('\n=== 数据量统计 ===');
  console.log(summarize(data, rawText, elapsed));

  console.log('\n=== 字段完整性 ===');
  console.log(fieldStats(data));

  console.log('\n=== 内容摘要 ===');

  const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];
  if (!subs.length) {
    console.log('[subtitles] 无结果');
  } else {
    console.log(`[subtitles] 共 ${subs.length} 条`);

    // 语言分布（按数量降序）
    const byLang = {};
    for (const s of subs) {
      const l = s?.language || '(未知)';
      byLang[l] = (byLang[l] || 0) + 1;
    }
    const langSorted = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
    console.log(`[语言] ${langSorted.map(([k, n]) => `${k}(${n})`).join('، ')}`);

    // 展示前 10 条
    console.log('\n[前 10 条]');
    subs.slice(0, 10).forEach((s, idx) => {
      const flags = [];
      if (s.isHearingImpaired) flags.push('HI');
      if (s.matchScore) flags.push(`score=${s.matchScore}`);
      console.log(
        `  ${idx + 1}. [${s.source || '?'}] ${s.language || '?'}/${s.display || '?'} | ` +
        `${s.format || '?'} | dl=${s.downloadCount ?? '?'}` +
        (flags.length ? ` | ${flags.join('، ')}` : '')
      );
      if (s.release) {
        console.log(`       release: ${s.release.slice(0, 90)}${s.release.length > 90 ? '...' : ''}`);
      }
    });
    if (subs.length > 10) console.log(`  ... 还有 ${subs.length - 10} 条`);

    // 按来源统计
    console.log('\n[来源统计]');
    const bySource = {};
    for (const s of subs) {
      const src = s?.source || '(未知)';
      bySource[src] = (bySource[src] || 0) + 1;
    }
    for (const [src, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${src}: ${n}`);
    }
  }

  return data;
}

// ── 运行入口 ────────────────────────────────────────────

// 方式 A：完整参数（推荐）
// fetchSubtitles({
//   imdbId: 'tt35538033',
//   language: 'zh-CN',
//   title: '生化危机：爆发夜',
//   year: 2026,
//   v: 8
// }).catch(err => console.error('[subtitle] 出错:', err));

// 方式 B：只按 imdb_id 查
// fetchSubtitles({ imdbId: 'tt35538033' })

// 方式 C：不传 language，返回所有语言
// fetchSubtitles({
//   imdbId: 'tt35538033',
//   title: '生化危机：爆发夜',
//   year: 2026,
//   v: 8
// })

// 方式 D：批量探测不同参数组合，观察“逐步收紧”的效果
async function probeVariants(lang = 'zh-CN') {
  const base = { imdbId: 'tt35538033', title: '生化危机：爆发夜', year: 2026, v: 8 };
  const variants = [
    { name: '仅 imdb_id', opts: { imdbId: base.imdbId } },
    { name: 'imdb_id + language', opts: { imdbId: base.imdbId, language: 'zh-CN' } },
    { name: 'imdb_id + title + year', opts: { imdbId: base.imdbId, title: base.title, year: base.year } },
    { name: '完整参数', opts: { ...base, language: 'zh-CN' } }
  ];

  for (const { name, opts } of variants) {
    console.log(`\n────────────────────────────────────────`);
    console.log(`[subtitle] 变体: ${name}`);
    try {
      await fetchSubtitles(opts, lang);
    } catch (e) {
      console.error(`[subtitle] 变体 ${name} 出错:`, e.message);
    }
  }
}

// 默认跑方式 D
probeVariants('zh-CN')
  .then(() => console.log('\n[subtitle] 完成'))
  .catch(err => console.error('[subtitle] 出错:', err));