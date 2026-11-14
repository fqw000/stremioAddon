// trybox-probe.js
// 用法：
// 1. 浏览器：打开 https://trybox.app，F12 -> Console，粘贴运行
// 2. Node 18+：保存为 trybox-probe.js，执行 node trybox-probe.js

const API_URL = 'https://trybox.app/_serverFn/8071ddde1fc9ba14bf80594e08c4f8cfb030a79f7bcccfe292835b561fae77a4';

// 兼容浏览器和 Node 的计时
const now = () => {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
};

// 构造 payload
function buildPayload(page = 'home') {
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
              k: ['page'],
              v: [{ t: 1, s: page }]
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

// 解码 trybox 的 t/p/k/v/a 格式
function decodeNode(node) {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;

  switch (node.t) {
    case 0: // 数字
    case 1: // 字符串
      return node.s;
    case 2: // null
      return null;
    case 9: // 数组
      return (node.a || []).map(decodeNode);
    case 10: { // 对象
      const obj = {};
      const keys = node.p?.k || [];
      const values = node.p?.v || [];
      for (let i = 0; i < keys.length; i++) {
        obj[keys[i]] = decodeNode(values[i]);
      }
      return obj;
    }
    case 11: // context 等特殊节点，忽略
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
function summarize(decoded, rawText, elapsed) {
  const result = decoded.result || {};
  const rawSize = new TextEncoder().encode(rawText).length;
  const sections = flattenSections(result);
  const sectionStats = {};
  const allIds = new Set();
  const sectionIds = {};

  for (const [path, arr] of Object.entries(sections)) {
    sectionStats[path] = arr.length;
    const ids = new Set();
    for (const item of arr) {
      if (item && typeof item === 'object' && item.id != null) {
        ids.add(item.id);
        allIds.add(item.id);
      }
    }
    sectionIds[path] = ids.size;
  }

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: +(rawSize / 1024).toFixed(2),
    原始大小Bytes: rawSize,
    各板块条目数: sectionStats,
    各板块去重ID数: sectionIds,
    全局去重ID总数: allIds.size
  };
}

// 字段完整性统计
function fieldStats(decoded) {
  const fields = ['id', 'title', 'overview', 'poster_path', 'backdrop_path', 'vote_average', 'release_date'];
  const stats = {};
  fields.forEach(f => stats[f] = { present: 0, missing: 0 });
  let total = 0;

  const result = decoded.result || {};
  const sections = flattenSections(result);

  for (const arr of Object.values(sections)) {
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      total++;
      for (const f of fields) {
        const v = item[f];
        if (v === null || v === undefined || v === '') {
          stats[f].missing++;
        } else {
          stats[f].present++;
        }
      }
    }
  }

  return { total, stats };
}

// 主探针函数
async function probe(page = 'home', lang = 'zh-CN') {
  const payload = buildPayload(page);
  const url = `${API_URL}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  console.log(`[probe] 请求: ${url}`);

  const t0 = now();
  const res = await fetch(url, {
    headers: { 'x-trybox-lang': lang }
  });
  const rawText = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const raw = JSON.parse(rawText);
  const decoded = decodeNode(raw);

  console.log('\n=== 数据量统计 ===');
  console.log(summarize(decoded, rawText, elapsed));

  console.log('\n=== 字段完整性 ===');
  console.log(fieldStats(decoded));

  console.log('\n=== 板块摘要 ===');
  const result = decoded.result || {};
  for (const [key, val] of Object.entries(result)) {
    if (Array.isArray(val)) {
      console.log(`\n[${key}] ${val.length} 项`);
      val.slice(0, 5).forEach((item, idx) => {
        if (item && typeof item === 'object') {
          console.log(`  ${idx + 1}. ${item.title || '(无标题)'} | ${item.release_date || ''} | 评分: ${item.vote_average ?? ''} | 类型: ${item.media_type || ''}`);
        } else {
          console.log(`  ${idx + 1}.`, item);
        }
      });
      if (val.length > 5) console.log(`  ... 还有 ${val.length - 5} 项`);
    } else if (val && typeof val === 'object') {
      console.log(`\n[${key}] 对象，子板块: ${Object.keys(val).join(', ')}`);
      for (const [subKey, subVal] of Object.entries(val)) {
        if (Array.isArray(subVal)) {
          console.log(`  - ${subKey}: ${subVal.length} 项`);
          subVal.slice(0, 3).forEach((item, idx) => {
            if (item && typeof item === 'object') {
              console.log(`      ${idx + 1}. ${item.title || '(无标题)'} | ${item.release_date || ''} | 评分: ${item.vote_average ?? ''}`);
            }
          });
          if (subVal.length > 3) console.log(`      ... 还有 ${subVal.length - 3} 项`);
        }
      }
    } else {
      console.log(`\n[${key}]:`, val);
    }
  }

  return decoded;
}

// 运行一次
probe('home', 'zh-CN')
  .then(() => console.log('\n[probe] 完成'))
  .catch(err => console.error('[probe] 出错:', err));