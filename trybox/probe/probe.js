#!/usr/bin/env node
// trybox-probe-all.mjs
//
// 合并版探针：catalog / search / meta / subtitle / stream
//
// 运行：
//   node trybox-probe-all.mjs                     # 默认跑全部五个探针
//   node trybox-probe-all.mjs all                 # 同上
//   node trybox-probe-all.mjs catalog [page]      # 单个 page：home / tv / movies
//   node trybox-probe-all.mjs catalog-all         # 依次跑 home / tv / movies
//   node trybox-probe-all.mjs search "阿甘正传"    # 批量 multi/movie/tv
//   node trybox-probe-all.mjs meta tv 76331       # 指定 type 和 id
//   node trybox-probe-all.mjs subtitle            # 字幕变体探测
//   node trybox-probe-all.mjs stream              # 只跑 stream（需 seroval 依赖）
//
// 依赖（仅 stream 探针需要）：
//   npm install seroval @tanstack/router-core
//   缺失时 stream 会被自动跳过，其余探针照常运行。
//
// ────────────────────────────────────────────────────────────
// ID 体系说明（重要）
// ────────────────────────────────────────────────────────────
//
// 探针涉及两套完全独立的 ID，不能互相换算：
//
//   1) TMDB ID   —— 纯数字，TMDB 数据库主键
//                   例：继承之战 = 76331，阿甘正传 = 13
//                   出现在：catalog / search / meta / stream
//
//   2) IMDb ID   —— "tt" + 7~8 位数字，IMDb 数据库主键
//                   例：继承之战 = tt7660850，阿甘正传 = tt0109830
//                   出现在：meta 响应字段、subtitle 请求参数
//
// 各探针用哪套 ID：
//
//   catalog / search   → 只产出 TMDB ID（字段名 id）+ media_type
//                          ↓
//   meta（请求）        ← 吃 TMDB ID（字段名 type + id）
//   meta（响应）        → 吐 TMDB ID（id）+ IMDb ID（imdb_id）+ seasons 等
//                          ↓                          ↓
//   stream（请求）      ← 用 TMDB ID（字段名 tmdb_id）  subtitle（请求）← 用 IMDb ID（字段名 imdbId）
//
// 关键事实：
//
//   * catalog / search / meta / stream 走的是同一套 TMDB ID，
//     只是字段名在 stream 请求里变成了 tmdb_id，值不变。
//   * subtitle 走的是 IMDb ID，和 TMDB ID 没有任何数值对应关系。
//   * IMDb ID 的唯一来源是 meta 响应的 imdb_id 字段——这是整条链上
//     唯一一次「TMDB 世界」到「IMDb 世界」的转换点。
//   * 因此 subtitle 探针必须先经过一次 meta 请求拿到 imdb_id，
//     不能从 catalog / search 的 id 直接推出来。
//   * media_type 值固定是 'movie' / 'tv'，但字段名在 meta 请求里
//     叫 type、在 stream 请求里叫 kind。
//
// 
// ────────────────────────────────────────────────────────────
// 参数搭配速查
// ────────────────────────────────────────────────────────────
//
//   meta      : type + id            （缺一不可）
//   stream    : tmdb_id + kind       （movie 到此为止）
//               tmdb_id + kind + season + episode  （tv 必须补 season/episode）
//   subtitle  : imdbId               （只给这个时 SubtitleCat 不会被带出来）
//               imdbId + title + year + language  （推荐组合，覆盖面最广）
//
// ────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ============================================================
// 1. 通用工具
// ============================================================

const now = () =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

const utf8Size = (s) => new TextEncoder().encode(s).length;
const toKB = (bytes) => +(bytes / 1024).toFixed(2);

/**
 * 打印 payload 说明（单行紧凑模式）
 * @param {string} tag     探针标签
 * @param {object} payload 可读对象
 * @param {object} [opts]
 * @param {object} [opts.raw]  原始（未解码）payload，与 payload 不同时追加一行
 * @param {string} [opts.note] 附加说明
 */
function logPayload(tag, payload, opts = {}) {
  const { raw, note } = opts;
  let line = `[${tag}] [payload] ${note ?? '请求体如下'}`;
  try {
    line += ` ${JSON.stringify(payload)}`;
  } catch {
    line += ' <无法序列化>';
  }
  console.log(line);

  if (raw && raw !== payload) {
    console.log(`[${tag}] [payload:raw] ${JSON.stringify(raw)}`);
  }
}

/** 解码 trybox 的 t/p/k/v/a 结构 */
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
    case 11: // context 等特殊节点
      return null;
    default:
      return node.s !== undefined ? node.s : node;
  }
}

/** 把 result 里的所有数组拍平，返回 { 路径: 数组 } */
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

/** 字段完整性通用统计 */
function statFields(items, fields) {
  const stats = {};
  fields.forEach((f) => (stats[f] = { present: 0, missing: 0 }));
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const f of fields) {
      const v = item[f];
      if (v === null || v === undefined || v === '') stats[f].missing++;
      else stats[f].present++;
    }
  }
  return stats;
}

/** 简单的日志小节标题 */
const section = (title) => console.log(`\n=== ${title} ===`);

const itemLine = (item) => {
  const title = item.title || item.name || '(无标题)';
  const date = item.release_date || item.first_air_date || '';
  const score = item.vote_average ?? '';
  const media = item.media_type || '';
  const id = item.id ?? '';
  return `[${media}] ${title} | ${date} | 评分: ${score} | id: ${id}`;
};

// ============================================================
// 2. 配置
// ============================================================

const CONFIG = {
  DEFAULT_LANG: 'zh-CN',

  URLS: {
    catalog:
      'https://trybox.app/_serverFn/8071ddde1fc9ba14bf80594e08c4f8cfb030a79f7bcccfe292835b561fae77a4',
    search:
      'https://trybox.app/_serverFn/4554bac009cb7b0dd4f23b35e6381cde80f8891f6cd2c529ecb25d91e64f42ba',
    meta:
      'https://trybox.app/_serverFn/44b25540de850d9a6aa33c2f3333282561e7954b1805fa7e0ab1e5862f1123bc',
    episodes:
      'https://trybox.app/_serverFn/e554914846470475f9970c596196d2e827879f8fdf88f392107c1218acba9687',
    subtitle: 'https://trybox.app/api/public/subtitles',
    stream:
      'https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012',
  },

  SUPABASE_URL: 'https://saichcuwzbncuqnqhuul.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWNoY3V3emJuY3VxbnFodXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTg4MjUsImV4cCI6MjA5OTk3NDgyNX0.v0KsTzaaiHUTvtA_W-HuAOQul3E7cxnbw4Kiy9hFVus',   // 常量，目前有效期到2036年
  REFRESH_TOKEN: '5bznxq7u72de',    // 变量，需要自行配置, 一次性，使用一次以后要存储新的。
};

// ============================================================
// 3. Catalog 探针
// ============================================================
// catalog 支持的 page 类型
const CATALOG_PAGES = ['home', 'tv', 'movies'];

function buildCatalogPayload(page = 'home') {
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
            p: { k: ['page'], v: [{ t: 1, s: page }] },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

function catalogSummarize(decoded, rawText, elapsed) {
  const result = decoded.result || {};
  const rawSize = utf8Size(rawText);
  const sections = flattenSections(result);
  const sectionStats = {};
  const sectionIds = {};
  const allIds = new Set();

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
    原始大小KB: toKB(rawSize),
    原始大小Bytes: rawSize,
    各板块条目数: sectionStats,
    各板块去重ID数: sectionIds,
    全局去重ID总数: allIds.size,
  };
}

function catalogFieldStats(decoded) {
  const fields = [
    'id', 'title', 'overview', 'poster_path', 'backdrop_path',
    'vote_average', 'release_date',
  ];
  const result = decoded.result || {};
  const sections = flattenSections(result);
  let total = 0;
  const stats = {};
  fields.forEach((f) => (stats[f] = { present: 0, missing: 0 }));

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

async function probeCatalog(page = 'home', lang = CONFIG.DEFAULT_LANG) {
  if (!CATALOG_PAGES.includes(page)) {
    throw new Error(
      `[catalog] page 仅支持 ${CATALOG_PAGES.join(' / ')}，收到: "${page}"`
    );
  }

  const payload = buildCatalogPayload(page);

  const url = `${CONFIG.URLS.catalog}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

  console.log(`[catalog] 请求: page="${page}"`);
  logPayload('catalog', { page }, { note: `page="${page}"` });
  console.log(`[catalog] URL: ${url}`);

  const t0 = now();
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const rawText = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const raw = JSON.parse(rawText);
  const decoded = decodeNode(raw);

  section('数据量统计');
  console.log(catalogSummarize(decoded, rawText, elapsed));

  section('字段完整性');
  console.log(catalogFieldStats(decoded));

  section('板块摘要');
  const result = decoded.result || {};
  for (const [key, val] of Object.entries(result)) {
    if (Array.isArray(val)) {
      console.log(`\n[${key}] ${val.length} 项`);
      val.slice(0, 5).forEach((item, idx) => {
        if (item && typeof item === 'object') console.log(`  ${idx + 1}. ${itemLine(item)}`);
        else console.log(`  ${idx + 1}.`, item);
      });
      if (val.length > 5) console.log(`  ... 还有 ${val.length - 5} 项`);
    } else if (val && typeof val === 'object') {
      console.log(`\n[${key}] 对象，子板块: ${Object.keys(val).join(', ')}`);
      for (const [subKey, subVal] of Object.entries(val)) {
        if (Array.isArray(subVal)) {
          console.log(`  - ${subKey}: ${subVal.length} 项`);
          subVal.slice(0, 3).forEach((item, idx) => {
            if (item && typeof item === 'object') console.log(`      ${idx + 1}. ${itemLine(item)}`);
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

async function probeCatalogAll(lang = CONFIG.DEFAULT_LANG) {
  for (const page of CATALOG_PAGES) {
    console.log(`\n────────────────────────────────────────`);
    console.log(`[catalog] page="${page}"`);
    try {
      await probeCatalog(page, lang);
    } catch (e) {
      console.error(`[catalog] page=${page} 出错:`, e.message);
    }
  }
}


// ============================================================
// 4. Search 探针
// ============================================================

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
                { t: 1, s: type },
              ],
            },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

function searchSummarize(result, rawText, elapsed) {
  const rawSize = utf8Size(rawText);
  const sections = flattenSections(result);
  const sectionStats = {};
  for (const [path, arr] of Object.entries(sections)) sectionStats[path] = arr.length;

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: toKB(rawSize),
    原始大小Bytes: rawSize,
    顶层字段: Object.keys(result),
    各数组条目数: sectionStats,
  };
}

function searchFieldStats(result) {
  const fields = [
    'id', 'title', 'name', 'overview', 'poster_path', 'backdrop_path',
    'vote_average', 'release_date', 'first_air_date', 'media_type',
  ];
  const sections = flattenSections(result);
  let total = 0;
  const stats = {};
  fields.forEach((f) => (stats[f] = { present: 0, missing: 0 }));

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

async function probeSearch(query, type = 'multi', lang = CONFIG.DEFAULT_LANG) {
  const payload = buildSearchPayload(query, type);
  const url = `${CONFIG.URLS.search}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

  console.log(`[search] 请求: query="${query}", type="${type}"`);
  logPayload('search', { query, type }, { note: `query="${query}", type="${type}"` });
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

  section('数据量统计');
  console.log(searchSummarize(result, rawText, elapsed));

  section('字段完整性');
  console.log(searchFieldStats(result));

  section('内容摘要');

  const basics = ['query', 'type', 'total_results', 'page', 'total_pages'];
  const foundBasics = {};
  for (const k of basics) if (result[k] !== undefined) foundBasics[k] = result[k];
  if (Object.keys(foundBasics).length) console.log('[基础字段]', foundBasics);

  const sections = flattenSections(result);
  for (const [path, arr] of Object.entries(sections)) {
    const label = path === '' ? '(根数组)' : path;
    console.log(`\n[${label}] ${arr.length} 项`);
    arr.slice(0, 5).forEach((item, idx) => {
      if (item && typeof item === 'object') console.log(`  ${idx + 1}. ${itemLine(item)}`);
      else console.log(`  ${idx + 1}.`, item);
    });
    if (arr.length > 5) console.log(`  ... 还有 ${arr.length - 5} 项`);
  }

  return decoded;
}

async function probeSearchAllTypes(query, lang = CONFIG.DEFAULT_LANG) {
  for (const t of ['multi', 'movie', 'tv']) {
    console.log(`\n────────────────────────────────────────`);
    try {
      await probeSearch(query, t, lang);
    } catch (e) {
      console.error(`[search] type=${t} 出错:`, e.message);
    }
  }
}

// ============================================================
// 5. Meta 探针
// ============================================================

function buildMetaPayload(type, id) {
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
              k: ['type', 'id'],
              v: [
                { t: 1, s: type },
                { t: 0, s: Number(id) },
              ],
            },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

// ---------- Episodes（剧集列表） ----------

// 构造剧集列表请求 payload
//   tvId         : TMDB TV id（meta 响应的 result.id）
//   seasonNumber : 季号（meta 响应的 seasons[i].season_number）
function buildEpisodesPayload(tvId, seasonNumber) {
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
              k: ['id', 'season'],
              v: [
                { t: 0, s: Number(tvId) },
                { t: 0, s: Number(seasonNumber) },
              ],
            },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 127,
    m: [],
  };
}

function episodesSummarize(episodes, rawText, elapsed) {
  const list = Array.isArray(episodes) ? episodes : [];
  const rawSize = utf8Size(rawText);

  const withOverview = list.filter((e) => e && e.overview).length;
  const withStill = list.filter((e) => e && e.still_path).length;
  const withRuntime = list.filter((e) => e && e.runtime != null).length;
  const withVote = list.filter((e) => e && e.vote_average != null).length;

  const runtimes = list.map((e) => e?.runtime).filter((r) => typeof r === 'number');
  const avgRuntime = runtimes.length
    ? +(runtimes.reduce((a, b) => a + b, 0) / runtimes.length).toFixed(1)
    : null;

  const votes = list.map((e) => e?.vote_average).filter((v) => typeof v === 'number');
  const avgVote = votes.length
    ? +(votes.reduce((a, b) => a + b, 0) / votes.length).toFixed(3)
    : null;

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: toKB(rawSize),
    原始大小Bytes: rawSize,
    剧集数: list.length,
    有简介: withOverview,
    有剧照: withStill,
    有时长: withRuntime,
    有评分: withVote,
    平均时长: avgRuntime,
    平均评分: avgVote,
    首播日期范围:
      list.length
        ? `${list[0]?.air_date || '?'} ~ ${list[list.length - 1]?.air_date || '?'}`
        : null,
  };
}

function episodesFieldStats(episodes) {
  const list = Array.isArray(episodes) ? episodes : [];
  const fields = [
    'id', 'episode_number', 'name', 'overview',
    'still_path', 'runtime', 'air_date', 'vote_average',
  ];
  return { total: list.length, stats: statFields(list, fields) };
}

/**
 * 探测某季的剧集列表
 *   tvId         : TMDB TV id
 *   seasonNumber : 季号
 *   opts.print   : 是否打印详细摘要（默认 true，集成调用时可关闭）
 *   opts.returnOnly : true 时只返回数组，不打印（默认 false）
 */
async function probeEpisodes(tvId, seasonNumber, lang = CONFIG.DEFAULT_LANG, opts = {}) {
  const { print = true, returnOnly = false } = opts;
  const payload = buildEpisodesPayload(tvId, seasonNumber);
  const url = `${CONFIG.URLS.episodes}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

  if (print) {
    console.log(`[episodes] 请求: tvId=${tvId}, season=${seasonNumber}`);
    logPayload('episodes', { id: Number(tvId), season: Number(seasonNumber) }, {
      note: `tvId=${tvId}, season=${seasonNumber}`,
    });
    console.log(`[episodes] URL: ${url}`);
  }

  const t0 = now();
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const rawText = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const raw = JSON.parse(rawText);
  const decoded = decodeNode(raw);
  const episodes = Array.isArray(decoded.result) ? decoded.result : [];

  if (returnOnly) return episodes;

  section(`剧集列表 S${String(seasonNumber).padStart(2, '0')}`);

  if (!print) {
    return episodes;
  }

  console.log(`共 ${episodes.length} 集，耗时 ${elapsed.toFixed(1)}ms`);

  console.log('\n=== 数据量统计 ===');
  console.log(episodesSummarize(episodes, rawText, elapsed));

  console.log('\n=== 字段完整性 ===');
  console.log(episodesFieldStats(episodes));

  console.log('\n=== 内容摘要 ===');
  episodes.forEach((ep, idx) => {
    const num = String(ep?.episode_number ?? idx + 1).padStart(2, '0');
    const name = ep?.name || '(无名称)';
    const runtime = ep?.runtime ? `${ep.runtime} 分钟` : '时长未知';
    const airDate = ep?.air_date || '播出日期未知';
    const vote = ep?.vote_average != null ? `评分 ${ep.vote_average}` : '';
    console.log(`  E${num} | ${name} | ${runtime} | ${airDate}${vote ? ' ' + vote : ''}`);
  });

  return episodes;
}

/**
 * 根据 meta 响应逐季获取剧集列表
 *   metaResult : meta 响应的 result
 */
async function probeAllSeasons(metaResult, lang = CONFIG.DEFAULT_LANG) {
  const tvId = metaResult?.id;
  const seasons = Array.isArray(metaResult?.seasons) ? metaResult.seasons : [];

  if (!tvId) {
    console.warn('[episodes] metaResult 缺少 id，跳过');
    return [];
  }
  if (!seasons.length) {
    console.warn('[episodes] metaResult.seasons 为空，跳过');
    return [];
  }

  console.log(`\n[episodes] 根据 meta 季数（${seasons.length} 季）逐季获取剧集列表，TV id = ${tvId}`);

  const results = [];
  for (const s of seasons) {
    const seasonNumber = s?.season_number;
    if (seasonNumber == null) {
      console.warn('[episodes] 跳过没有 season_number 的季:', s);
      continue;
    }
    try {
      const t1 = now();
      const episodes = await probeEpisodes(tvId, seasonNumber, lang, { print: true });
      const dt = now() - t1;
      console.log(`\n[episodes] tvId=${tvId}, season=${seasonNumber} 完成，共 ${episodes.length} 集（耗时 ${dt.toFixed(1)}ms）`);
      results.push({ seasonNumber, episodes });
    } catch (err) {
      console.error(`[episodes] S${seasonNumber} 获取失败:`, err.message || err);
    }
  }
  return results;
}

function metaSummarize(result, rawText, elapsed) {
  const rawSize = utf8Size(rawText);
  const sections = flattenSections(result);
  const sectionStats = {};
  for (const [path, arr] of Object.entries(sections)) sectionStats[path] = arr.length;

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: toKB(rawSize),
    原始大小Bytes: rawSize,
    顶层字段: Object.keys(result),
    各数组条目数: sectionStats,
  };
}

function metaFieldStats(result) {
  const stats = {};
  for (const [key, val] of Object.entries(result)) {
    stats[key] = {
      type: Array.isArray(val)
        ? `array(${val.length})`
        : val === null
          ? 'null'
          : typeof val === 'object'
            ? `object(${Object.keys(val).length})`
            : typeof val,
      present: val === null || val === undefined || val === '' ? 0 : 1,
      missing: val === null || val === undefined || val === '' ? 1 : 0,
    };
  }
  return stats;
}

async function probeMeta(type, id, lang = CONFIG.DEFAULT_LANG) {
  const payload = buildMetaPayload(type, id);
  const url = `${CONFIG.URLS.meta}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

  console.log(`[meta] 请求: type=${type}, id=${id}`);
  logPayload('meta', { type, id: Number(id) }, { note: `type=${type}, id=${id}` });
  console.log(`[meta] URL: ${url}`);

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

  section('数据量统计');
  console.log(metaSummarize(result, rawText, elapsed));

  section('字段完整性');
  console.log(metaFieldStats(result));

  section('内容摘要');

  const isTV = result.media_type === 'tv';
  const basics = isTV
    ? [
      'id', 'title', 'name', 'media_type', 'release_date',
      'vote_average', 'vote_count', 'status', 'tagline',
      'number_of_seasons', 'number_of_episodes',
    ]
    : [
      'id', 'title', 'name', 'media_type', 'release_date',
      'vote_average', 'vote_count', 'runtime', 'status', 'tagline',
    ];

  const found = {};
  for (const k of basics) if (result[k] !== undefined) found[k] = result[k];
  console.log('[基础字段]', found);

  if (isTV) {
    const totalSeasons = result.number_of_seasons;
    const totalEpisodes = result.number_of_episodes;
    const epRuntime = result.runtime;
    console.log(
      `[剧集信息] 共 ${totalSeasons ?? '?'} 季，${totalEpisodes ?? '?'} 集` +
      (epRuntime ? `，单集约 ${epRuntime} 分钟` : '，单集时长未知')
    );
  }

  if (result.overview) {
    console.log(
      `[overview] ${result.overview.slice(0, 120)}${result.overview.length > 120 ? '...' : ''}`
    );
  }

  if (Array.isArray(result.genres)) {
    console.log(`[genres] ${result.genres.map((g) => g?.name || g).join('، ')}`);
  } else if (Array.isArray(result.genre_ids)) {
    console.log(`[genre_ids] ${result.genre_ids.join(', ')}`);
  }

  const cast = result.credits?.cast || result.cast;
  if (Array.isArray(cast) && cast.length) {
    const names = cast.slice(0, 5).map((c) => c?.name).filter(Boolean);
    console.log(
      `[cast] ${names.join('، ')}${cast.length > 5 ? '، more' : ''} (共 ${cast.length} 位)`
    );
  }

  const videos = result.videos?.results || result.videos;
  if (Array.isArray(videos) && videos.length) {
    const trailers = videos.filter((v) => v?.type === 'Trailer');
    console.log(`[videos] ${videos.length} 个视频, 其中 ${trailers.length} 个预告片`);
  }

  if (isTV && Array.isArray(result.seasons) && result.seasons.length) {
    console.log(`\n[seasons] ${result.seasons.length} 项 — 每项完整字段如下`);
    result.seasons.forEach((s, idx) => console.log(`  ${idx + 1}.`, s));

    console.log('\n[seasons 关键字段]');
    result.seasons.forEach((s) => {
      console.log(
        `  S${String(s?.season_number ?? '?').padStart(2, '0')} | ` +
        `${s?.name || '(无名称)'} | 集数: ${s?.episode_count ?? '?'} | ` +
        `首播: ${s?.air_date || '?'} | id: ${s?.id ?? '?'}`
      );
    });

    // ★ 根据 meta 的季数，对每一季发起请求获取剧集列表
    await probeAllSeasons(result, lang);
  }

  const skip = new Set(['credits.cast', 'videos.results', 'genres', 'cast', 'videos', 'seasons']);
  for (const [path, arr] of Object.entries(flattenSections(result))) {
    if (!path || skip.has(path)) continue;
    console.log(`\n[${path}] ${arr.length} 项`);
    arr.slice(0, 3).forEach((item, idx) => {
      if (item && typeof item === 'object') {
        const label =
          item.name ||
          item.title ||
          item.iso_639_1 ||
          item.iso_3166_1 ||
          JSON.stringify(item).slice(0, 60);
        console.log(`  ${idx + 1}. ${label}`);
      } else {
        console.log(`  ${idx + 1}.`, item);
      }
    });
    if (arr.length > 3) console.log(`  ... 还有 ${arr.length - 3} 项`);
  }

  return decoded;
}

async function probeMetaFromList(lang = CONFIG.DEFAULT_LANG) {
  const listPayload = buildCatalogPayload('home');
  const url = `${CONFIG.URLS.catalog}?payload=${encodeURIComponent(JSON.stringify(listPayload))}`;
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const decoded = decodeNode(await res.json());
  const trending = decoded.result?.trending || [];

  if (!trending.length) {
    console.warn('[meta] trending 为空，无法取样本');
    return;
  }

  console.log(`\n[meta] 从 trending 取前 3 条进行 meta 探测...`);
  for (const item of trending.slice(0, 3)) {
    try {
      await probeMeta(item.media_type, item.id, lang);
    } catch (e) {
      console.error(`[meta] id=${item.id} 出错:`, e.message);
    }
  }
}

// ============================================================
// 6. Subtitle 探针
// ============================================================

function buildSubtitleQuery({ imdbId, language, title, year, v = 8 } = {}) {
  const params = new URLSearchParams();
  if (imdbId) params.set('imdb_id', imdbId);
  if (language) params.set('language', language);
  if (title) params.set('title', title);
  if (year) params.set('year', String(year));
  if (v != null) params.set('v', String(v));
  return params.toString();
}

function subtitleSummarize(data, rawText, elapsed) {
  const rawSize = utf8Size(rawText);
  const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];

  const byLang = {};
  const bySource = {};
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
    原始大小KB: toKB(rawSize),
    原始大小Bytes: rawSize,
    顶层字段: Object.keys(data || {}),
    字幕总数: subs.length,
    语言分布: byLang,
    来源分布: bySource,
    格式分布: byFormat,
  };
}

function subtitleFieldStats(data) {
  const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];
  const fields = [
    'id', 'url', 'format', 'language', 'display', 'release',
    'source', 'downloadCount', 'isHearingImpaired', 'matchScore',
  ];
  return { total: subs.length, stats: statFields(subs, fields) };
}

async function probeSubtitle(opts = {}, lang = CONFIG.DEFAULT_LANG) {
  const query = buildSubtitleQuery(opts);
  const url = `${CONFIG.URLS.subtitle}?${query}`;

  console.log(`[subtitle] 请求参数: ${JSON.stringify(opts)}`);
  logPayload('subtitle', opts, { note: '查询参数（空值会被省略）' });
  console.log(`[subtitle] URL: ${url}`);

  const t0 = now();
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const rawText = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const data = JSON.parse(rawText);

  section('数据量统计');
  console.log(subtitleSummarize(data, rawText, elapsed));

  section('字段完整性');
  console.log(subtitleFieldStats(data));

  section('内容摘要');

  const subs = Array.isArray(data?.subtitles) ? data.subtitles : [];
  if (!subs.length) {
    console.log('[subtitles] 无结果');
  } else {
    console.log(`[subtitles] 共 ${subs.length} 条`);

    const byLang = {};
    for (const s of subs) {
      const l = s?.language || '(未知)';
      byLang[l] = (byLang[l] || 0) + 1;
    }
    const langSorted = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
    console.log(`[语言] ${langSorted.map(([k, n]) => `${k}(${n})`).join('، ')}`);

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
        console.log(
          `       release: ${s.release.slice(0, 90)}${s.release.length > 90 ? '...' : ''}`
        );
      }
    });
    if (subs.length > 10) console.log(`  ... 还有 ${subs.length - 10} 条`);

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

async function probeSubtitleVariants(lang = CONFIG.DEFAULT_LANG) {
  const base = { imdbId: 'tt35538033', title: '生化危机：爆发夜', year: 2026, v: 8 };
  const variants = [
    { name: '仅 imdb_id', opts: { imdbId: base.imdbId } },
    { name: 'imdb_id + language', opts: { imdbId: base.imdbId, language: 'zh-CN' } },
    {
      name: 'imdb_id + title + year',
      opts: { imdbId: base.imdbId, title: base.title, year: base.year },
    },
    { name: '完整参数', opts: { ...base, language: 'zh-CN' } },
  ];

  for (const { name, opts } of variants) {
    console.log(`\n────────────────────────────────────────`);
    console.log(`[subtitle] 变体: ${name}`);
    try {
      await probeSubtitle(opts, lang);
    } catch (e) {
      console.error(`[subtitle] 变体 ${name} 出错:`, e.message);
    }
  }
}

// ============================================================
// 7. Stream 探针
// ============================================================

// seroval 相关依赖按需加载（避免其它探针因为缺少依赖而失败）
let _serovalCache = null;
async function loadSeroval() {
  if (_serovalCache) return _serovalCache;
  const seroval = await import('seroval');
  const require = createRequire(import.meta.url);
  const routerCore = require('@tanstack/router-core');
  _serovalCache = {
    fromJSON: seroval.fromJSON,
    fromCrossJSON: seroval.fromCrossJSON,
    defaultSerovalPlugins: routerCore.defaultSerovalPlugins,
  };
  return _serovalCache;
}

// 滚动式 refresh token 持久化
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = join(__dirname, '.trybox-session.json');

function loadRefreshToken() {
  if (existsSync(SESSION_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (data.refresh_token) return data.refresh_token;
    } catch (e) {
      console.warn(`[stream] session 文件解析失败，回退到 CONFIG.REFRESH_TOKEN`);
    }
  }
  return CONFIG.REFRESH_TOKEN;
}

function saveRefreshToken(token) {
  try {
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({ refresh_token: token, updated_at: new Date().toISOString() }, null, 2)
    );
  } catch (e) {
    console.warn(`[stream] session 文件写入失败: ${e.message}`);
  }
}

let _cachedToken = null;
let _currentRefresh = null;

// async function getAccessToken(force = false) {
//   if (_cachedToken && !force) return _cachedToken;

//   if (!_currentRefresh) _currentRefresh = loadRefreshToken();
//   console.log('refresh(旧): ' + _currentRefresh);

//   const res = await fetch(
//     `${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
//     {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         apikey: CONFIG.SUPABASE_ANON_KEY,
//       },
//       body: JSON.stringify({ refresh_token: _currentRefresh }),
//     }
//   );
//   const data = await res.json();
//   if (!res.ok) throw new Error(`刷新失败: ${JSON.stringify(data)}`);

//   _cachedToken = data.access_token;
//   if (data.refresh_token) {
//     _currentRefresh = data.refresh_token;
//     saveRefreshToken(_currentRefresh);
//     console.log('refresh(新): ' + _currentRefresh);
//   }

//   return _cachedToken;
// }


//  当refresh失效时，临时测试应用accesstonke硬编码
// 临时使用accesstoken本地测试
  // JWT 解析 + refresh token过期预警
  function decodeJwtExpiry(token) {
    try {
      const [, payload] = token.split('.');
      const json = JSON.parse(
        Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      );
      return json.exp ? json.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  async function getAccessToken() {
    const token = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImYzMzBhOTk4LTE2NGQtNGRmOC04NDNjLTFjODJlZWMxZDQ5YSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL3NhaWNoY3V3emJuY3VxbnFodXVsLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJmMWZjYWM1YS1hNDk0LTQ4MTItODIyYy02MzhlNTE3MGUzMDMiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzkyOTQ0MTc3LCJpYXQiOjE3OTI5NDA1NzcsImVtYWlsIjoiN3dhbmd6aW1vQGdtYWlsLmNvbSIsInBob25lIjoiIiwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiZ29vZ2xlIiwicHJvdmlkZXJzIjpbImdvb2dsZSJdfSwidXNlcl9tZXRhZGF0YSI6eyJhdmF0YXJfdXJsIjoiaHR0cHM6Ly9saDMuZ29vZ2xldXNlcmNvbnRlbnQuY29tL2EvQUNnOG9jTFpDUXBZdzJmWnZQSmNLbFlpVlRCZl9aQWhmdXVkZXE0YURNWnRZbnM1bGlwcjg0Uk89czk2LWMiLCJlbWFpbCI6Ijd3YW5nemltb0BnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwiZnVsbF9uYW1lIjoiS2llZmVyIiwiaXNzIjoiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tIiwibmFtZSI6IktpZWZlciIsInBob25lX3ZlcmlmaWVkIjpmYWxzZSwicGljdHVyZSI6Imh0dHBzOi8vbGgzLmdvb2dsZXVzZXJjb250ZW50LmNvbS9hL0FDZzhvY0xaQ1FwWXcyZlp2UEpjS2xZaVZUQmZfWkFoZnV1ZGVxNGFETVp0WW5zNWxpcHI4NFJPPXM5Ni1jIiwicHJvdmlkZXJfaWQiOiIxMDU0NzI4NTE2NTk0MzY2OTc1ODEiLCJzdWIiOiIxMDU0NzI4NTE2NTk0MzY2OTc1ODEifSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJvYXV0aCIsInRpbWVzdGFtcCI6MTc5MjQyMzAxN31dLCJzZXNzaW9uX2lkIjoiNzNkMjk1MzItNDY5Ni00MzZmLWI0ZTAtZDU4ZjNmNzI0NDM1IiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.hR34fjZcKleM5oGunpeEsmr2p4wi5sdpT-zQEwY6tcS1Fc0iraX727dHM-FIZ81hd9ZIWEEex9tw-7vDx2jNBA';    // refresh 失效时，本地测试临时临时使用
    const exp = decodeJwtExpiry(token);
    if (exp) {
      const remainMin = Math.round((exp - Date.now()) / 60000);
      if (remainMin <= 0) {
        throw new Error(
          `硬编码的 access_token 已过期 ${-remainMin} 分钟。\n` +
          `  请到浏览器 localStorage 重新复制一份新鲜的。`
        );
      }

      console.log(`[stream] access_token 剩余有效期: ${remainMin} 分钟`);
    }
    return token;
  }


  function buildStreamRequestBody({ tmdbId, kind, season, episode }) {
    const dataObj =
      kind === 'tv'
        ? {
          t: 10,
          i: 1,
          p: {
            k: ['tmdb_id', 'kind', 'season', 'episode'],
            v: [
              { t: 0, s: tmdbId },
              { t: 1, s: 'tv' },
              { t: 0, s: season },
              { t: 0, s: episode },
            ],
          },
          o: 0,
        }
        : {
          t: 10,
          i: 1,
          p: {
            k: ['tmdb_id', 'kind'],
            v: [
              { t: 0, s: tmdbId },
              { t: 1, s: 'movie' },
            ],
          },
          o: 0,
        };

    return {
      t: { t: 10, i: 0, p: { k: ['data'], v: [dataObj] }, o: 0 },
      f: 127,
      m: [],
    };
  }

  function streamSummarize(result, parsed, rawText, elapsed) {
    const rawSize = utf8Size(rawText);
    const meta = parsed?.result?.meta ?? {};
    const links = [
      ...(result?.mbp_links ?? []),
      ...(result?.links ?? []),
      ...(result?.beta_links ?? []),
    ];
    const withUrl = links.filter((l) => l && l.url);
    const hls = withUrl.filter((l) => l.url.includes('.m3u8'));
    const vipLocked = withUrl.filter((l) => l.vip_locked);

    const byQuality = {};
    for (const l of withUrl) {
      const q = (l.quality || 'Unknown').toUpperCase();
      byQuality[q] = (byQuality[q] || 0) + 1;
    }

    const byGroup = {};
    for (const l of withUrl) {
      const g = l.group || 'Unknown';
      byGroup[g] = (byGroup[g] || 0) + 1;
    }

    return {
      耗时ms: +elapsed.toFixed(1),
      原始大小KB: toKB(rawSize),
      原始大小Bytes: rawSize,
      顶层字段: Object.keys(result || {}),
      链接总数: links.length,
      有效链接数: withUrl.length,
      HLS链接数: hls.length,
      VIP锁定数: vipLocked.length,
      质量分布: byQuality,
      分组分布: byGroup,
      媒体字段: Object.keys(meta),
    };
  }

  function streamFieldStats(result) {
    const fields = ['url', 'quality', 'size', 'group', 'file_id', 'file_name', 'vip_locked'];
    const links = [
      ...(result?.mbp_links ?? []),
      ...(result?.links ?? []),
      ...(result?.beta_links ?? []),
    ];
    return { total: links.length, stats: statFields(links, fields) };
  }

  function parseStreamLinks(json) {
    const result = json?.result ?? {};
    const meta = result.meta ?? {};
    const links = [
      ...(result.mbp_links ?? []),
      ...(result.links ?? []),
      ...(result.beta_links ?? []),
    ];

    const streams = links
      .filter((l) => l && l.url)
      .map((l) => ({
        quality: l.quality || 'Unknown',
        url: l.url,
        size: l.size || 'Unknown',
        group: l.group || 'Unknown',
        fileId: l.file_id || '',
        fileName: l.file_name || '',
        vipLocked: l.vip_locked ?? false,
        isHls: l.url.includes('.m3u8'),
      }));

    const order = {
      '4K': 0, '2160P': 0, '2160p': 0,
      '1080P': 1, '1080p': 1,
      '720P': 2, '720p': 2,
      '360P': 3, '360p': 3,
      AUTO: 4, ORG: 5,
    };
    streams.sort((a, b) => (order[a.quality] ?? 99) - (order[b.quality] ?? 99));

    return { meta, streams, result };
  }

  async function probeStream(accessToken, target, lang = CONFIG.DEFAULT_LANG) {
    const { fromJSON, fromCrossJSON, defaultSerovalPlugins } = await loadSeroval();

    const body = buildStreamRequestBody(target);
    const label =
      target.kind === 'tv'
        ? `tv tmdbId=${target.tmdbId} S${target.season}E${target.episode}`
        : `movie tmdbId=${target.tmdbId}`;

    console.log(`\n[stream] 请求: ${label}`);

    // 解码出可读对象（供日志展示；解码失败不影响实际请求）
    let decoded = null;
    try {
      decoded = fromJSON(body, { plugins: defaultSerovalPlugins });
    } catch (e) {
      console.log(`[stream] payload 解码失败: ${e.message}`);
    }

    logPayload('stream', decoded ?? target, {
      raw: body,
      note: decoded
        ? '解码后的请求体（同时给出原始 seroval 结构）'
        : '原始 seroval 结构（解码失败，仅显示原文）',
    });

    console.log(`[stream] URL: ${CONFIG.URLS.stream}`);

    const t0 = now();
    const res = await fetch(CONFIG.URLS.stream, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'x-trybox-lang': lang,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
        Origin: 'https://trybox.app',
        Referer: 'https://trybox.app/',
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    const elapsed = now() - t0;

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
    }

    let parsed;
    try {
      const json = JSON.parse(raw);
      console.log('[stream] 响应顶层键:', Object.keys(json));
      console.log('[stream] 原始响应前 1500 字符:');
      console.log(raw.slice(0, 1500));
      parsed = fromCrossJSON(json, { plugins: defaultSerovalPlugins });
    } catch (e) {
      console.error('[stream] 解析失败的原始响应:');
      console.error(raw.slice(0, 3000));
      throw new Error(`解析响应失败: ${e.message}`);
    }

    if (parsed.error) throw new Error(`服务端错误: ${JSON.stringify(parsed.error)}`);

    const { meta, streams, result } = parseStreamLinks(parsed);

    section('数据量统计');
    console.log(streamSummarize(result, parsed, raw, elapsed));

    section('字段完整性');
    console.log(streamFieldStats(result));

    section('内容摘要');

    console.log('[媒体信息]', {
      title: meta.title || '未知',
      year: meta.year || '未知',
      imdbId: meta.imdb_id || '未知',
      type: target.kind,
      ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : {}),
    });

    if (!streams.length) {
      console.log('[streams] 未找到可播放链接');
    } else {
      console.log(`[streams] 共 ${streams.length} 条`);
      console.log('\n[播放链接]');
      streams.slice(0, 10).forEach((s, i) => {
        console.log(
          `  ${i + 1}. ${s.quality} | ${s.isHls ? 'HLS' : 'RAW'} | ${s.group} | ` +
          `大小: ${s.size} | VIP: ${s.vipLocked ? '锁定' : '可用'}`
        );
        console.log(`     URL: ${s.url}`);
      });
      if (streams.length > 10) console.log(`  ... 还有 ${streams.length - 10} 条`);

      const best = streams.find((s) => s.isHls) || streams[0];
      console.log(`\n[主播放地址] ${best.url}`);
    }

    return { meta, streams, result, elapsed };
  }

  async function probeStreamAll(lang = CONFIG.DEFAULT_LANG) {
    // 先探一遍 seroval 依赖，缺了就直接跳过，不拖累 runAll 的其它探针
    try {
      await loadSeroval();
    } catch (e) {
      console.warn(
        '[stream] 缺少 seroval 依赖，跳过 stream 探针。' +
        '如需启用：npm install seroval @tanstack/router-core'
      );
      return;
    }

    console.log('[stream] 获取 access_token...');
    const accessToken = await getAccessToken();
    console.log('[stream] access_token 获取成功');

    const MOVIE = { tmdbId: 687163, kind: 'movie' };
    const TV = { tmdbId: 2316, kind: 'tv', season: 1, episode: 5 };

    try {
      await probeStream(accessToken, MOVIE, lang);
    } catch (e) {
      console.error('\n[stream] 电影失败:', e.message);
    }

    try {
      await probeStream(accessToken, TV, lang);
    } catch (e) {
      console.error('\n[stream] 电视剧失败:', e.message);
    }
  }


  // ============================================================
  // 8. 命令行入口
  // ============================================================

  async function runAll(lang = CONFIG.DEFAULT_LANG) {
    console.log('\n=========== catalog ===========');
    try {
      await probeCatalog('home', lang);
    } catch (e) {
      console.error('[catalog] 出错:', e.message);
    }

    console.log('\n=========== search ===========');
    try {
      await probeSearchAllTypes('阿甘正传', lang);
    } catch (e) {
      console.error('[search] 出错:', e.message);
    }

    console.log('\n=========== meta ===========');
    try {
      await probeMeta('tv', 76331, lang);
    } catch (e) {
      console.error('[meta] 出错:', e.message);
    }

    console.log('\n=========== episodes ===========');
    try {
      await probeEpisodes(76331, 1, lang);
    } catch (e) {
      console.error('[episodes] 出错:', e.message);
    }

    console.log('\n=========== subtitle ===========');
    try {
      await probeSubtitleVariants(lang);
    } catch (e) {
      console.error('[subtitle] 出错:', e.message);
    }

    console.log('\n=========== stream ===========');
    try {
      await probeStreamAll(lang);
    } catch (e) {
      console.error('[stream] 出错:', e.message);
    }
  }

  async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    const lang = CONFIG.DEFAULT_LANG;

    switch (cmd) {
      case undefined:
      case 'all':
        await runAll(lang);
        break;

      case 'catalog':
        await probeCatalog(args[0] || 'home', lang);
        break;

      case 'catalog-all':
        await probeCatalogAll(lang);
        break;

      case 'search':
        await probeSearchAllTypes(args[0] || '阿甘正传', lang);
        break;

      case 'meta': {
        const type = args[0] || 'tv';
        const id = args[1] || '76331';
        await probeMeta(type, id, lang);
        break;
      }

      // ★ 新增：单独探测某季剧集列表
      //   node trybox-probe-all.mjs episodes 76331 1
      case 'episodes': {
        const tvId = args[0] || '76331';
        const season = args[1] || '1';
        await probeEpisodes(tvId, season, lang);
        break;
      }


      case 'subtitle':
        await probeSubtitleVariants(lang);
        break;

      case 'stream':
        await probeStreamAll(lang);
        break;

      default:
        console.log(`未知命令: ${cmd}`);
        console.log('可用命令: all | catalog | catalog-all | search | meta | episodes | subtitle | stream');
        process.exit(1);
    }

    console.log('\n[probe] 完成');
  }

  // 仅在作为脚本直接运行时执行 main
  const isMain =
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

  if (isMain) {
    main().catch((err) => {
      console.error('[probe] 致命错误:', err);
      process.exit(1);
    });
  }

  // ============================================================
  // 9. 导出（供其它模块按需 import）
  // ============================================================

  export {
    CONFIG,
    decodeNode,
    flattenSections,
    // 各探针
    probeCatalog,
    CATALOG_PAGES,
    probeCatalogAll,
    probeSearch,
    probeSearchAllTypes,
    probeMeta,
    probeMetaFromList,
    probeEpisodes,
    probeAllSeasons,
    buildEpisodesPayload,
    probeSubtitle,
    probeSubtitleVariants,
    probeStream,
    probeStreamAll,
    getAccessToken,
    // 工具
    now,
    utf8Size,
    toKB,
  };