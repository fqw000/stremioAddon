// trybox-meta-probe.js
// 用法：
// 1. 浏览器：打开 https://trybox.app，F12 -> Console 粘贴运行
// 2. Node 18+：保存为 trybox-meta-probe.js 后 node trybox-meta-probe.js

const META_API_URL = 'https://trybox.app/_serverFn/44b25540de850d9a6aa33c2f3333282561e7954b1805fa7e0ab1e5862f1123bc';
const EPISODES_API_URL = 'https://trybox.app/_serverFn/e554914846470475f9970c596196d2e827879f8fdf88f392107c1218acba9687';

const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// 构造 meta 请求 payload
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
                { t: 0, s: Number(id) }
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

// 构造剧集列表请求 payload
// 参数：TV id、季号
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
                { t: 0, s: Number(seasonNumber) }
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

  const topFields = Object.keys(result);

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: +(rawSize / 1024).toFixed(2),
    原始大小Bytes: rawSize,
    顶层字段: topFields,
    各数组条目数: sectionStats
  };
}

// 字段完整性统计（只统计顶层字段）
function fieldStats(result) {
  const stats = {};
  for (const [key, val] of Object.entries(result)) {
    stats[key] = {
      type: Array.isArray(val) ? `array(${val.length})` :
            val === null ? 'null' :
            typeof val === 'object' ? `object(${Object.keys(val).length})` :
            typeof val,
      present: val === null || val === undefined || val === '' ? 0 : 1,
      missing: val === null || val === undefined || val === '' ? 1 : 0
    };
  }
  return stats;
}

// 获取某季的剧集列表（不做打印，返回数组）
async function getEpisodes(tvId, seasonNumber, lang = 'zh-CN') {
  const payload = buildEpisodesPayload(tvId, seasonNumber);
  const url = `${EPISODES_API_URL}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const res = await fetch(url, { headers: { 'x-trybox-lang': lang } });
  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${rawText.slice(0, 500)}`);
  }

  const decoded = decodeNode(JSON.parse(rawText));
  return decoded.result;
}

// 打印某季剧集列表
function printEpisodes(seasonNumber, episodes) {
  if (!Array.isArray(episodes)) {
    console.warn(`[episodes] S${seasonNumber} result 不是数组，跳过`);
    return;
  }
  console.log(`\n=== 剧集列表 S${String(seasonNumber).padStart(2, '0')} ===`);
  console.log(`共 ${episodes.length} 集`);
  episodes.forEach((ep, idx) => {
    const num = String(ep.episode_number ?? idx + 1).padStart(2, '0');
    const name = ep.name || '(无名称)';
    const runtime = ep.runtime ? `${ep.runtime} 分钟` : '时长未知';
    const airDate = ep.air_date || '播出日期未知';
    const vote = ep.vote_average != null ? `评分 ${ep.vote_average}` : '';
    console.log(`  E${num} | ${name} | ${runtime} | ${airDate} ${vote}`);
  });
}

// 主探针函数
async function fetchMeta(type, id, lang = 'zh-CN') {
  const payload = buildMetaPayload(type, id);
  const url = `${META_API_URL}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
  console.log(`[meta] 请求: type=${type}, id=${id}`);
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

  console.log('\n=== 数据量统计 ===');
  console.log(summarize(result, rawText, elapsed));

  console.log('\n=== 字段完整性 ===');
  console.log(fieldStats(result));

  console.log('\n=== 内容摘要 ===');

  const isTV = result.media_type === 'tv';
  const basics = isTV
    ? ['id', 'title', 'name', 'media_type', 'release_date',
       'vote_average', 'vote_count', 'status', 'tagline',
       'number_of_seasons', 'number_of_episodes']
    : ['id', 'title', 'name', 'media_type', 'release_date',
       'vote_average', 'vote_count', 'runtime', 'status', 'tagline'];

  const found = {};
  for (const k of basics) {
    if (result[k] !== undefined) found[k] = result[k];
  }
  console.log('[基础字段]', found);

  if (isTV) {
    const totalSeasons = result.number_of_seasons;
    const totalEpisodes = result.number_of_episodes;
    const epRuntime = result.runtime;
    console.log(`[剧集信息] 共 ${totalSeasons ?? '?'} 季，${totalEpisodes ?? '?'} 集` +
      (epRuntime ? `，单集约 ${epRuntime} 分钟` : '，单集时长未知'));
  }

  if (result.overview) {
    console.log(`[overview] ${result.overview.slice(0, 120)}${result.overview.length > 120 ? '...' : ''}`);
  }

  if (Array.isArray(result.genres)) {
    console.log(`[genres] ${result.genres.map(g => g?.name || g).join('، ')}`);
  } else if (Array.isArray(result.genre_ids)) {
    console.log(`[genre_ids] ${result.genre_ids.join(', ')}`);
  }

  const cast = result.credits?.cast || result.cast;
  if (Array.isArray(cast) && cast.length) {
    const names = cast.slice(0, 5).map(c => c?.name).filter(Boolean);
    console.log(`[cast] ${names.join('، ')}${cast.length > 5 ? '، more' : ''} (共 ${cast.length} 位)`);
  }

  const videos = result.videos?.results || result.videos;
  if (Array.isArray(videos) && videos.length) {
    const trailers = videos.filter(v => v?.type === 'Trailer');
    console.log(`[videos] ${videos.length} 个视频, 其中 ${trailers.length} 个预告片`);
  }

  // ★ TV 专属：打印 seasons，并根据季数逐季获取剧集列表
  if (isTV && Array.isArray(result.seasons) && result.seasons.length) {
    console.log(`\n[seasons] ${result.seasons.length} 项 — 每项完整字段如下`);
    result.seasons.forEach((s, idx) => {
      console.log(`  ${idx + 1}.`, s);
    });

    console.log('\n[seasons 关键字段]');
    result.seasons.forEach((s) => {
      console.log(
        `  S${String(s?.season_number ?? '?').padStart(2, '0')} | ` +
        `${s?.name || '(无名称)'} | 集数: ${s?.episode_count ?? '?'} | ` +
        `首播: ${s?.air_date || '?'} | id: ${s?.id ?? '?'}`
      );
    });

    // ===== 关键：根据 meta 的季数，对每一季发起请求获取剧集列表 =====
    const tvId = result.id;
    console.log(`\n[episodes] 根据 meta 季数（${result.seasons.length} 季）逐季获取剧集列表，TV id = ${tvId}`);

    for (const s of result.seasons) {
      const seasonNumber = s?.season_number;
      if (seasonNumber == null) {
        console.warn('[episodes] 跳过没有 season_number 的季:', s);
        continue;
      }
      try {
        const t1 = now();
        const episodes = await getEpisodes(tvId, seasonNumber, lang);
        const dt = now() - t1;
        console.log(`\n[episodes] 请求: tvId=${tvId}, season=${seasonNumber}（耗时 ${dt.toFixed(1)}ms）`);
        printEpisodes(seasonNumber, episodes);
      } catch (err) {
        console.error(`[episodes] S${seasonNumber} 获取失败:`, err.message || err);
      }
    }
  }

  // 其他数组
  for (const [path, arr] of Object.entries(flattenSections(result))) {
    if (!path) continue;
    if (['credits.cast', 'videos.results', 'genres', 'cast', 'videos', 'seasons'].includes(path)) continue;
    console.log(`\n[${path}] ${arr.length} 项`);
    arr.slice(0, 3).forEach((item, idx) => {
      if (item && typeof item === 'object') {
        const label = item.name || item.title || item.iso_639_1 || item.iso_3166_1 || JSON.stringify(item).slice(0, 60);
        console.log(`  ${idx + 1}. ${label}`);
      } else {
        console.log(`  ${idx + 1}.`, item);
      }
    });
    if (arr.length > 3) console.log(`  ... 还有 ${arr.length - 3} 项`);
  }

  return decoded;
}

// ========== 运行入口 ==========

// 探测指定 tv，会自动根据 meta 的季数逐季获取剧集列表
fetchMeta('tv', 76331).catch(err => console.error('[meta] 出错:', err));

// 探测指定 movie
// fetchMeta('movie', 777443).catch(err => console.error('[meta] 出错:', err));

// 单独测试某一季（TV id + 季号）
// getEpisodes(80752, 1, 'zh-CN')
//   .then(eps => printEpisodes(1, eps))
//   .catch(err => console.error('[episodes] 出错:', err));