// trybox-search-probe.js
// 用法：
// 1. 浏览器：打开 https://trybox.app，F12 -> Console 粘贴运行
// 2. Node 18+：保存为 trybox-search-probe.js 后 node trybox-search-probe.js

const SEARCH_API_URL = 'https://trybox.app/_serverFn/4554bac009cb7b0dd4f23b35e6381cde80f8891f6cd2c529ecb25d91e64f42ba';

const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// 构造 search 请求 payload
function buildSearchPayload(query, type = 'multi') {
  return {
    t: {
      t: 10,
      i: 0,
      p: {
        k: ['data'],
        v: [
          {
            t: 10,
            i: 1,
            p: {
              k: ['query', 'type'],
              v: [
                { t: 1, s: query },
                { t: 1, s: type }
              ]
            },
            o: 0
          }
        ]
      },
      o: 0
    },
    f: 127,
    m: []
  };
}

// 解码 trybox 的 t/p/k/v/a 结构
function decodeNode(node) {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;

  switch (node.t) {
    case 0:
    case 1:
      return node.s;
    case 2:
      return null;
    case 9:
      return (node.a || []).map(decodeNode);
    case 10: {
      const obj = {};
      const keys = node.p?.k || [];
      const values = node.p?.v || [];
      for (let i = 0; i < keys.length; i++) {
        obj[keys[i]] = decodeNode(values[i]);
      }
      return obj;
    }
    case 11:
      return null;
    default:
      return node.s !== undefined ? node.s : node;
  }
}

// 把 result 里的所有数组拍平，返回 { 路径: 数组 }
function flattenSections(result) {
  const sections = {};
  function walk(obj, path) {
    if (Array.isArray(obj)) {
      sections[path] = obj;
      return;
    }
    if (obj && typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        walk(val, path ? `${path}.${key}` : key);
      }
    }
  }
  walk(result, '');
  return sections;
}

// 数据量统计
function summarize(result, rawText, elapsed) {
  const rawSize = new TextEncoder().encode(rawText).length;
  const sections = flattenSections(result);
  const sectionStats = {};

  for (const [path, arr] of Object.entries(sections)) {
    sectionStats[path] = arr.length;
  }

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: +(rawSize / 1024).toFixed(2),
    原始大小Bytes: rawSize,
    顶层字段: Object.keys(result),
    各数组条目数: sectionStats
  };
}

// 字段完整性统计（针对所有结果项）
function fieldStats(result) {
  const sections = flattenSections(result);
  const fields = ['id', 'title', 'name', 'overview', 'poster_path', 'backdrop_path',
                  'vote_average', 'release_date', 'first_air_date', 'media_type'];
  const stats = {};
  fields.forEach(f => stats[f] = { present: 0, missing: 0 });
  let total = 0;

  for (const arr of Object.values(sections)) {
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      total++;
      for (const f of fields) {
        const v = item[f];
        if (v === null || v === undefined || v === '') stats[f].missing++;
        else stats[f].present++;
      }
    }
  }

  return { total, stats };
}

// 主探针函数
async function search(query, type = 'multi', lang = 'zh-CN') {
  const payload = buildSearchPayload(query, type);
  const url = `${SEARCH_API_URL}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  console.log(`[search] 请求参数: query="${query}", type="${type}"`);
  console.log(`[search] URL: ${url}`);

  const t0 = now();
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const rawText = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const raw = JSON.parse(rawText);
  const decoded = decodeNode(raw);
  const result = decoded.result || {};

  console.log('\n=== 数据量统计 ===');
  console.log(summarize(result, rawText, elapsed));

  console.log('\n=== 字段完整性 ===');
  console.log(fieldStats(result));

  console.log('\n=== 内容摘要 ===');

  // 基础信息
  const basics = ['query', 'type', 'total_results', 'page', 'total_pages'];
  const foundBasics = {};
  for (const k of basics) {
    if (result[k] !== undefined) foundBasics[k] = result[k];
  }
  if (Object.keys(foundBasics).length) console.log('[基础字段]', foundBasics);

  // 逐数组展示
// 逐数组展示（兼容 result 本身是数组的情况）
  const sections = flattenSections(result);
  for (const [path, arr] of Object.entries(sections)) {
    const label = path === '' ? '(根数组)' : path;
    console.log(`\n[${label}] ${arr.length} 项`);
    arr.slice(0, 5).forEach((item, idx) => {
      if (item && typeof item === 'object') {
        const title = item.title || item.name || '(无标题)';
        const date = item.release_date || item.first_air_date || '';
        const score = item.vote_average ?? '';
        const media = item.media_type || '';
        const id = item.id ?? '';
        console.log(`  ${idx + 1}. [${media}] ${title} | ${date} | 评分: ${score} | id: ${id}`);
      } else {
        console.log(`  ${idx + 1}.`, item);
      }
    });
    if (arr.length > 5) console.log(`  ... 还有 ${arr.length - 5} 项`);
  }

  return decoded;
}

// 批量探测不同类型
async function probeTypes(query, lang = 'zh-CN') {
  const types = ['multi', 'movie', 'tv'];
  for (const t of types) {
    console.log(`\n────────────────────────────────────────`);
    try {
      await search(query, t, lang);
    } catch (e) {
      console.error(`[search] type=${t} 出错:`, e.message);
    }
  }
}

// 运行入口：
// 方式 A：单次搜索，默认 multi
// search('阿甘正传').catch(err => console.error('[search] 出错:', err));

// 方式 B：指定 type
// search('阿甘正传', 'movie').catch(err => console.error('[search] 出错:', err));

// 方式 C：批量探测 multi / movie / tv
probeTypes('阿甘正传', 'zh-CN')
  .then(() => console.log('\n[search] 完成'))
  .catch(err => console.error('[search] 出错:', err));