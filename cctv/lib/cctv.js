'use strict';

const { httpGet, httpGetJson, httpGetPage, cacheGet, cacheSet, mapLimit } = require('./fetch');
const logger = require('./logger');

const JISHI_BASE = 'https://jishi.cctv.com';
const VIDEO_API = 'https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=';
const ALBUM_LIST_API = 'https://api.cntv.cn/list/getVideoAlbumList';

// ---------- 4K 专区 ----------
// 页面 https://tv.cctv.com/4K/index.shtml 使用此接口拉取片单
// 注意：接口给出的 id(VIDA...) 专辑页实测全部 404，唯一可播入口是 last_video.url (VIDE)
// 因此每条只代表"专区当前收录的一期"，但流质量真实可达 1080P（4000kbps）
const FOURK_LIST_API = 'https://api.cntv.cn/NewVideo/getLastVideoList4K';
const FOURK_CID = 'CHAL1558416868484111';
// 4K 单集页通过 JS 动态加载完整分集列表（非静态 HTML）：
//   api.cntv.cn/video/videoinfoByGuid?serviceId=cctv4k&guid=<guid> → album_id / vset_*
//   api.cntv.cn/NewVideo/getVideoListByAlbumIdNew?id=<album_id>&serviceId=cctv4k
//     &p=<page>&n=12&sort=asc&mode=0&pub=2 → 全部分集（每集含 image 缩略图）
const FOURK_INFO_API = 'https://api.cntv.cn/video/videoinfoByGuid';
const FOURK_EPISODES_API = 'https://api.cntv.cn/NewVideo/getVideoListByAlbumIdNew';
const FOURK_TYPES = [
  { id: 'tv', name: '电视剧4K', fc: '电视剧', catalogId: 'cctv_4k_tv' },
  { id: 'doc', name: '纪录片4K', fc: '纪录片', catalogId: 'cctv_4k_doc' },
  { id: 'science', name: '科教4K', fc: '科教', catalogId: 'cctv_4k_science' }
];

// 片库真实栏目页（来自 jishi.cctv.com 页面的分类链接）
const CATALOG_SOURCES = {
  rwdl: '/doc/cctv9/lm/rwdl/index.shtml',      // 人文历史
  military: '/doc/list/lx/military/index.shtml', // 军事
  explore: '/doc/list/lx/explore/index.shtml',   // 探索
  social: '/doc/list/lx/social/index.shtml',     // 社会
  nature: '/doc/list/lx/Nature/index.shtml',     // 自然
  other: '/doc/list/lx/other/index.shtml',       // 其他
  jj: '/doc/list/fl/jj/index.shtml',             // 经济
  yzam: '/doc/list/fl/yzam/index.shtml',         // 宇宙奥秘（科技）
  hkht: '/doc/list/fl/hkht/index.shtml',         // 航空航天（科技）
  kgfx: '/doc/list/fl/kgfx/index.shtml',         // 考古发现
  whys: '/doc/list/fl/whys/index.shtml',         // 文化艺术
  xzaj: '/doc/list/fl/xzaj/index.shtml',         // 刑侦案件
  zn: '/doc/list/fl/zn/index.shtml',             // 灾难
  dw: '/doc/list/fl/dw/index.shtml',             // 动物
  ty: '/doc/list/fl/ty/index.shtml',             // 体育
  yl: '/doc/list/fl/yl/index.shtml',             // 娱乐
  zw: '/doc/list/fl/zw/index.shtml',             // 植物
  ly: '/doc/list/fl/ly/index.shtml',             // 旅游
  dz: '/doc/list/fl/dz/index.shtml',             // 谍战
  nx: '/doc/list/fl/nx/index.shtml',             // 女性
  qs: '/doc/list/fl/qs/index.shtml'              // 青少
};

// Stremio 侧展示的分类（对应用户给出的导航），映射到真实栏目
const CATEGORIES = [
  { id: 'all', name: '全部', sources: null },
  { id: 'rwdl', name: '人文历史', sources: ['rwdl', 'whys', 'kgfx'] },
  { id: 'people', name: '人物', sources: ['rwdl'] },
  { id: 'military', name: '军事', sources: ['military', 'xzaj'] },
  { id: 'explore', name: '探索', sources: ['explore', 'yzam', 'hkht'] },
  { id: 'social', name: '社会', sources: ['social', 'xzaj', 'zn'] },
  { id: 'nature', name: '自然', sources: ['nature', 'dw', 'zw'] },
  { id: 'politics', name: '时政', sources: ['rwdl', 'jj'] },
  { id: 'economy', name: '经济', sources: ['jj'] },
  { id: 'tech', name: '科技', sources: ['yzam', 'hkht'] }
];

// ---------- yxg 片库：电视剧 / 动画片 / 特别节目 ----------
// 数据源：api.cntv.cn/list/getVideoAlbumList（栏目页 AJAX 接口）
const YXG_TYPES = {
  tv: {
    id: 'tv',
    name: '电视剧',
    catalogId: 'cctv_tv',
    channelid: 'CHAL1460955853485115',
    fc: '电视剧',
    // 子分类维度：地区（area 参数）
    extraName: '地区',
    extraOptions: ['全部', '内地（大陆）', '港澳台', '欧美', '其他']
  },
  animation: {
    id: 'animation',
    name: '动画片',
    catalogId: 'cctv_animation',
    channelid: 'CHAL1460955899450127',
    fc: '动画片',
    extraName: '地区',
    extraOptions: ['全部', '内地（大陆）', '港澳台', '欧美']
  },
  special: {
    id: 'special',
    name: '特别节目',
    catalogId: 'cctv_special',
    channelid: 'CHAL1460955953877151',
    fc: '特别节目',
    // 子分类维度：节目类型（sc 参数）
    extraName: '类型',
    extraOptions: ['全部', '新闻', '经济', '综艺', '体育', '军事', '影视', '科教', '戏曲', '青少', '音乐', '社会', '文化', '公益', '其他']
  }
};

const QUALITIES = [
  { code: '2000', name: '超清 1080P' },
  { code: '1200', name: '高清 720P' },
  { code: '850', name: '标准 480P' },
  { code: '450', name: '流畅 360P' }
];

const CATALOG_TTL = 6 * 60 * 60 * 1000;
const VIDEO_TTL = 12 * 60 * 60 * 1000;
const STREAM_TTL = 30 * 60 * 1000;

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

function htmlDecode(s) {
  if (!s) return '';
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

// 通用 meta 标签解析，兼容 content 带引号和不带引号两种写法
function parseMetaTag(html, names) {
  for (const name of names) {
    const re1 = new RegExp(`<meta[^>]*name=["']?${name}["']?[^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']?${name}["']?`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return htmlDecode(m[1]);
  }
  return '';
}

// ---------- ID 编解码 ----------
// 剧集 ID: cctv.s.<base64url(专辑URL)>
// 4K 剧集 ID: cctv.4k.<base64url(单集URL)>  —— 用独立前缀触发完整分集 API 解析
// 分集 ID: cctv.e.<base64url(分集URL)>.<序号>
function encodeSeriesId(url) {
  return 'cctv.s.' + Buffer.from(url).toString('base64url');
}
function encode4KSeriesId(url) {
  return 'cctv.4k.' + Buffer.from(url).toString('base64url');
}
function decode4KSeriesId(id) {
  if (!id || !id.startsWith('cctv.4k.')) return null;
  try { return Buffer.from(id.slice(8), 'base64url').toString('utf8'); }
  catch (e) { return null; }
}
function encodeVideoId(url, index) {
  return 'cctv.e.' + Buffer.from(url).toString('base64url') + '.' + index;
}
function decodeSeriesId(id) {
  if (!id.startsWith('cctv.s.')) return null;
  try { return Buffer.from(id.slice(7), 'base64url').toString('utf8'); }
  catch (e) { return null; }
}
function decodeVideoId(id) {
  if (!id.startsWith('cctv.e.')) return null;
  const dot = id.lastIndexOf('.');
  try {
    return {
      url: Buffer.from(id.slice(7, dot), 'base64url').toString('utf8'),
      index: parseInt(id.slice(dot + 1), 10) || 0
    };
  } catch (e) { return null; }
}

// ---------- catalog ----------
function parseAlbumList(html) {
  const items = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    const block = m[1];
    const linkMatch = block.match(/href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDA\w+\.shtml)"/);
    if (!linkMatch) continue;
    const url = normalizeUrl(linkMatch[1]);

    let title = '';
    const titleMatch = block.match(/<h3[^>]*>\s*<a[^>]*title="([^"]*)"/i) ||
      block.match(/<a[^>]*title="([^"]*)"[^>]*href="[^"]*VIDA\w+"/i) ||
      block.match(/class="text"[^>]*>[\s\S]*?<a[^>]*>([^<]+)</i) ||
      block.match(/<a[^>]*href="[^"]*VIDA\w+"[^>]*>([^<]+)</i);
    if (titleMatch) title = htmlDecode(titleMatch[1]);
    if (/^VIDA\w+$/.test(title)) title = '';

    let poster = '';
    const imgMatch = block.match(/<img[^>]*(?:data|src)="(\/\/[^"]+\.(?:jpg|png|jpeg))"/i);
    if (imgMatch) poster = normalizeUrl(imgMatch[1]);

    items.push({ url, title, poster });
  }
  const seen = new Set();
  return items.filter(it => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

async function getCatalog(category = 'all') {
  const cacheKey = 'catalog:v2:' + category;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const cat = CATEGORIES.find(c => c.id === category) || CATEGORIES[0];
  let sourceKeys;
  if (category === 'all') sourceKeys = Object.keys(CATALOG_SOURCES);
  else sourceKeys = cat.sources || [];

  const urls = sourceKeys.map(k => JISHI_BASE + CATALOG_SOURCES[k]).filter(Boolean);
  const pages = await mapLimit(urls, 6, async url => {
    try {
      return parseAlbumList(await httpGet(url, { timeout: 15000 }));
    } catch (e) {
      console.error(`[catalog] 抓取失败 ${url}: ${e.message}`);
      return [];
    }
  });

  const merged = new Map();
  for (const list of pages) {
    if (!Array.isArray(list)) continue;
    for (const it of list) merged.set(it.url, it);
  }
  const albums = Array.from(merged.values());
  cacheSet(cacheKey, albums, CATALOG_TTL);
  return albums;
}

// ---------- yxg 片库 catalog ----------
// 通过 api.cntv.cn/list/getVideoAlbumList 抓取电视剧/动画片/特别节目
// filterValue: 子分类选项（"全部" 或具体地区/类型）
// pages: 抓取页数，每页 24 条
async function getYxgCatalog(typeId, filterValue = '全部', pages = 4) {
  const cfg = YXG_TYPES[typeId];
  if (!cfg) return [];

  const key = filterValue && filterValue !== '全部' ? filterValue : '';
  const cacheKey = `yxg:v1:${typeId}:${key}:${pages}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 地区类栏目用 area 参数，特别节目用 sc 参数。
  // 重要：源站把「全部」当作空字符串；传 area=全部 会返回 0 条。
  const isArea = cfg.extraName === '地区';
  const allKey = !key || key === '全部' || key === '全部地区';
  const buildUrl = p => {
    const q = new URLSearchParams({
      channelid: cfg.channelid,
      area: isArea && !allKey ? key : '',
      sc: !isArea && !allKey ? key : '',
      fc: cfg.fc,
      year: '',
      letter: '',
      p: String(p),
      n: '24',
      serviceId: 'tvcctv',
      topv: '1',
      t: 'json'
    });
    return `${ALBUM_LIST_API}?${q.toString()}`;
  };

  const pageNums = Array.from({ length: pages }, (_, i) => i + 1);
  const lists = await mapLimit(pageNums, 4, async p => {
    try {
      const data = await httpGetJson(buildUrl(p), { timeout: 15000 });
      return (data && data.data && Array.isArray(data.data.list)) ? data.data.list : [];
    } catch (e) {
      console.error(`[yxg] 抓取失败 ${typeId} p=${p}: ${e.message}`);
      return [];
    }
  });

  const merged = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const url = normalizeUrl(it.url);
      if (!url || !/\/VID[A-Z]\w+\.shtml/.test(url)) continue;

      // 单集内容（特别节目等）：VIDA 页往往无分集，API 的 video.url 才是真正可播放的 VIDE 页。
      // 用 VIDE 作为条目 URL，meta/stream 链路可直接解析 guid 播放。
      const video = it.video || {};
      const count = parseInt(it.count || '0', 10) || 0;
      const singleVideoUrl = normalizeUrl(video.url || '');
      const entryUrl = (count === 1 && singleVideoUrl && /\/VIDE\w+\.shtml/.test(singleVideoUrl))
        ? singleVideoUrl
        : (/\/VIDE\w+\.shtml/.test(url) ? url : url);

      merged.set(entryUrl, {
        url: entryUrl,
        title: htmlDecode(it.title || ''),
        poster: normalizeUrl(it.image2 || it.image || video.image || '') || undefined,
        description: htmlDecode(it.brief || ''),
        area: it.area || '',
        year: it.year || '',
        actors: it.actors || '',
        count: it.count || '',
        channel: it.channel || ''
      });
    }
  }
  const albums = Array.from(merged.values());
  cacheSet(cacheKey, albums, CATALOG_TTL);
  return albums;
}

// ---------- 4K 专区 catalog ----------
// 只暴露"电视剧"与"科教"两类（category: all | tv | science | 电视剧 | 科教）
// 4K 区栏目页自身混排了新闻/纪录片/综艺等，入口很乱；这里按 fc 严格过滤。
async function get4KCatalog(category = 'all') {
  const cacheKey = '4k:v1:' + category;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 无论全部还是单一分类，都严格限定在「电视剧 / 科教」两类内
  const selected = (category === 'all' || category === '全部')
    ? FOURK_TYPES
    : FOURK_TYPES.filter(t => t.id === category || t.name === category || t.fc === category);
  const wanted = new Set(selected.map(t => t.fc));
  // API 单页上限 100，共 211 条，拉 3 页
  const lists = await mapLimit([1, 2, 3], 3, async p => {
    try {
      const q = new URLSearchParams({
        serviceId: 'cctv4k', cid: FOURK_CID, p: String(p), n: '100', t: 'json'
      });
      const data = await httpGetJson(`${FOURK_LIST_API}?${q.toString()}`, { timeout: 15000 });
      return (data && data.data && Array.isArray(data.data.list)) ? data.data.list : [];
    } catch (e) {
      console.error(`[4k] 抓取失败 p=${p}: ${e.message}`);
      return [];
    }
  });

  const merged = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const fc = it.fc || '';
      if (wanted.size && !wanted.has(fc)) continue;
      const v = it.last_video || {};
      const url = normalizeUrl(v.url || '');
      if (!url || !/\/VIDE\w+\.shtml/.test(url)) continue;

      const albumTitle = htmlDecode(it.title || '');
      const bits = [`4K专区 · ${fc || '未分类'}`];
      if (it.sc) bits.push(`题材：${it.sc}`);
      if (it.ep_count) bits.push(`共 ${it.ep_count} 集`);
      bits.push(albumTitle);
      bits.push('完整分集，最高 1080P');

      merged.set(url, {
        url,
        title: htmlDecode(v.title || '') || albumTitle,
        poster: normalizeUrl(it.image2 || it.image || v.image || '') || undefined,
        description: bits.join(' · '),
        fc,
        sc: it.sc || '',
        epCount: it.ep_count || '',
        albumTitle,
        keywords: v.keywords || ''
      });
    }
  }
  const albums = Array.from(merged.values());
  cacheSet(cacheKey, albums, CATALOG_TTL);
  return albums;
}

// ---------- 搜索：跨全部类型按关键词过滤 ----------
// 聚合纪录片 + 电视剧 + 动画片 + 特别节目，按标题/简介/主演匹配
async function searchCatalog(keyword, limit = 300) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];

  const tasks = [
    { type: 'series', loader: () => getCatalog('all') },
    ...Object.keys(YXG_TYPES).map(t => ({
      type: 'series',
      loader: () => getYxgCatalog(t, '全部', 8)
    })),
    { type: 'series', loader: () => get4KCatalog('all') }
  ];

  const results = await mapLimit(tasks, 4, async task => {
    try {
      const albums = await task.loader();
      return albums.filter(al => {
        const hay = [al.title, al.description, al.actors, al.area, al.year]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(kw);
      }).map(al => ({ ...al, sourceType: task.type }));
    } catch (e) {
      console.error(`[search] 抓取失败: ${e.message}`);
      return [];
    }
  });

  const merged = new Map();
  for (const list of results) {
    for (const al of list) {
      if (!merged.has(al.url)) merged.set(al.url, al);
    }
  }
  return Array.from(merged.values()).slice(0, limit);
}

// ---------- meta ----------
function parseEpisodes(html) {
  const episodes = [];
  const seen = new Set();
  const patterns = [
    /href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/(VIDE\w+)\.shtml)"[^>]*title="([^"]*)"/gi,
    /title="([^"]*)"[^>]*href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/(VIDE\w+)\.shtml)"/gi
  ];
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(html)) !== null) {
      let idMatch, urlMatch, title;
      if (m[2] && m[2].startsWith('VIDE')) {
        idMatch = m[2]; urlMatch = m[1]; title = m[3] || '';
      } else if (m[3] && m[3].startsWith('VIDE')) {
        idMatch = m[3]; urlMatch = m[2]; title = m[1] || '';
      }
      if (!idMatch || seen.has(idMatch)) continue;
      seen.add(idMatch);
      episodes.push({ id: idMatch, url: normalizeUrl(urlMatch), title: htmlDecode(title) });
    }
  }

  // 新版专辑页：分集放在 JS 数组里，形如
  // { 'title':'《朵拉和朋友们》 第1集', 'img':'//...', 'url':'https://tv.cctv.com/.../VIDE...shtml' }
  // 需用 JS 对象正则提取（单引号键名 + 单引号值）
  const jsObjRe = /\{\s*['"]title['"]\s*:\s*['"]([^'"]*)['"][\s\S]{0,400}?['"]url['"]\s*:\s*['"]([^'"]*?VIDE\w+\.shtml)['"]\s*\}/gi;
  let jm;
  while ((jm = jsObjRe.exec(html)) !== null) {
    const title = jm[1] || '';
    const url = normalizeUrl(jm[2]);
    const idMatch = (jm[2].match(/(VIDE\w+)\.shtml/) || [])[1];
    if (!idMatch || seen.has(idMatch)) continue;
    seen.add(idMatch);
    episodes.push({ id: idMatch, url, title: htmlDecode(title) });
  }
  // 补充：url 在 title 之前的 JS 对象顺序
  const jsObjRe2 = /\{\s*['"]url['"]\s*:\s*['"]([^'"]*?VIDE\w+\.shtml)['"][\s\S]{0,400}?['"]title['"]\s*:\s*['"]([^'"]*)['"]\s*\}/gi;
  while ((jm = jsObjRe2.exec(html)) !== null) {
    const url = normalizeUrl(jm[1]);
    const idMatch = (jm[1].match(/(VIDE\w+)\.shtml/) || [])[1];
    if (!idMatch || seen.has(idMatch)) continue;
    seen.add(idMatch);
    episodes.push({ id: idMatch, url, title: htmlDecode(jm[2] || '') });
  }
  // 兜底：散落的 VIDE URL（无任何标题上下文）
  // 注意：只匹配含完整域名与日期路径的绝对 URL，避免把页面中裸文件名
  // （如 'VIDEXXX.shtml'）误补成 https://VIDEXXX.shtml 这种无效地址
  if (episodes.length === 0) {
    const fallbackRe = /(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDE\w+\.shtml)/gi;
    while ((jm = fallbackRe.exec(html)) !== null) {
      const url = normalizeUrl(jm[1]);
      const idMatch = (jm[1].match(/(VIDE\w+)\.shtml/) || [])[1];
      if (!idMatch || seen.has(idMatch)) continue;
      seen.add(idMatch);
      episodes.push({ id: idMatch, url, title: '' });
    }
  }
  return episodes;
}

// ---------- 通用：由单集 guid 经 API 展开完整分集 ----------
// 央视单集页（VIDE）本身不列出其它集，但 videoinfoByGuid 可按 guid 取到 album_id，
// 再由 getVideoListByAlbumIdNew 分页拉全部分集（每集带缩略图）。
// 此能力对纪录片/电视剧/4K 等全部内容通用，是"搜索进入只有 1 集"问题的根治手段。
async function expandAlbumFromApi(guid, serviceId) {
  if (!guid) return null;
  let info;
  try {
    const q = new URLSearchParams({ serviceId: serviceId || 'cctv4k', guid, t: 'json' });
    info = await httpGetJson(`${FOURK_INFO_API}?${q.toString()}`, { timeout: 15000 });
  } catch (e) {
    return null;
  }
  const albumId = info && info.album_id;
  if (!albumId) return null;

  const buildUrl = p => {
    const q = new URLSearchParams({
      id: albumId, serviceId: serviceId || 'cctv4k', p: String(p), n: '12',
      sort: 'asc', mode: '0', pub: '2', t: 'json'
    });
    return `${FOURK_EPISODES_API}?${q.toString()}`;
  };

  let first;
  try { first = await httpGetJson(buildUrl(1), { timeout: 15000 }); }
  catch (e) { return null; }

  const total = parseInt((first && first.data && first.data.total) || '0', 10) || 0;
  if (total <= 1) return null; // 单集内容无需展开，交给调用方回退
  const pageCount = Math.min(10, Math.max(1, Math.ceil(total / 12)));
  const lists = [first && first.data && first.data.list || []];
  if (pageCount > 1) {
    const rest = await mapLimit(
      Array.from({ length: pageCount - 1 }, (_, i) => i + 2), 4, async p => {
        try {
          const d = await httpGetJson(buildUrl(p), { timeout: 15000 });
          return (d && d.data && Array.isArray(d.data.list)) ? d.data.list : [];
        } catch (e) { return []; }
      }
    );
    lists.push(...rest);
  }

  const episodes = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const ep of list) {
      const epUrl = normalizeUrl(ep.url || '');
      const id = (ep.id || (epUrl.match(/(VIDE\w+)\.shtml/) || [])[1] || '');
      if (!epUrl || !/\/VIDE\w+\.shtml/.test(epUrl) || seen.has(id)) continue;
      seen.add(id);
      episodes.push({
        id,
        url: epUrl,
        title: htmlDecode(ep.title || ''),
        image: normalizeUrl(ep.image || '') || undefined,
        guid: ep.guid || '',
        brief: htmlDecode(ep.brief || ''),
        length: ep.length || ''
      });
    }
  }
  if (episodes.length <= 1) return null;
  return { episodes, info, total, albumId };
}

async function getAlbumMeta(url) {
  const cacheKey = 'album:v3:' + url;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { html, finalUrl } = await httpGetPage(url, { timeout: 15000, ttl: VIDEO_TTL });
  let title = '';
  const tm = html.match(/<title>([^<]+)<\/title>/i);
  if (tm) title = htmlDecode(tm[1]).replace(/_CCTV节目官网.*$/, '').replace(/_央视网.*$/, '').trim();

  let poster = '';
  const pm = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (pm) poster = normalizeUrl(pm[1]);

  const description = parseMetaTag(html, ['description']);
  let episodes = parseEpisodes(html);
  let expanded = null;
  let albumTitle = '';

  // 单集页（VIDE）作为条目：优先用 API 按 guid 展开完整分集。
  // 这样从搜索/普通目录进入的多集内容也能显示完整剧集，而非只有 1 集。
  // 展开失败或无多集时，回退为"传入 URL 作为唯一分集"。
  if (/\/VIDE\w+\.shtml/.test(finalUrl)) {
    const singleId = (finalUrl.match(/(VIDE\w+)\.shtml/) || [])[1];
    try {
      const guid = await getGuidFromEpisode(finalUrl);
      expanded = await expandAlbumFromApi(guid, 'cctv4k');
    } catch (e) { expanded = null; }
    if (expanded && expanded.episodes.length > 1) {
      episodes = expanded.episodes;
      albumTitle = htmlDecode(expanded.info && (expanded.info.vset_title || expanded.info.title) || '');
    } else if (singleId) {
      // 页面里的裸 VIDE 文件名没有域名，不可用作播放地址；必须用 JS 跳转后的最终 URL。
      episodes = [{ id: singleId, url: finalUrl, title: title || '正片' }];
    }
  }

  const result = {
    title: albumTitle || title,
    poster, description, episodes, url: finalUrl,
    episodeTotal: expanded ? expanded.total : episodes.length,
    albumId: expanded ? expanded.albumId : ''
  };
  cacheSet(cacheKey, result, VIDEO_TTL);
  return result;
}

// ---------- 4K 完整分集 meta ----------
// 4K 单集页本身没有静态分集列表，需先由 guid 换 album_id，再分页拉取完整分集。
// 返回与 getAlbumMeta 相同结构，episodes 额外带 image（每集缩略图）与 guid。
async function get4KAlbumMeta(url) {
  const cacheKey = 'album4k:v1:' + url;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const page = await resolveEpisodePage(url);
  const guid = page.guid;
  if (!guid) return null;

  // 复用通用展开函数（4K 内容强制要求 API 展开，含完整分集与缩略图）
  const expanded = await expandAlbumFromApi(guid, 'cctv4k');
  if (!expanded) return null;
  const { episodes, info, total, albumId } = expanded;

  // 详情用专辑信息优先（vset_title/vset_brief 比单集页的 <title> 更适合做剧集名）
  const html = page.html;
  let poster = '';
  const pm = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (pm) poster = normalizeUrl(pm[1]);
  const result = {
    title: htmlDecode(info.vset_title || '') || htmlDecode(info.title || ''),
    poster: normalizeUrl(info.img || '') || poster,
    description: htmlDecode(info.vset_brief || info.brief || '') || parseMetaTag(html, ['description']),
    episodes,
    url: page.finalUrl,
    episodeTotal: total,
    albumId,
    fc: info.fc || '',
    sc: info.vset_sc || info.sc || ''
  };
  cacheSet(cacheKey, result, VIDEO_TTL);
  return result;
}

// ---------- stream ----------
// 返回 guid + 最终页面 URL。老旧分集 URL 可能是 JS 跳转桩页，
// httpGetPage 会跟随到真实页面后再解析 guid。
async function resolveEpisodePage(url) {
  const { html, finalUrl, redirects } = await httpGetPage(url, { timeout: 15000, ttl: VIDEO_TTL });
  const m = html.match(/var\s+guid\s*=\s*"([0-9a-f]{32})"/i) ||
    html.match(/\bguid\s*=\s*"([0-9a-f]{32})"/i);
  return {
    guid: m ? m[1] : null,
    finalUrl,
    redirects,
    html,
    htmlLength: html.length
  };
}

async function getGuidFromEpisode(url) {
  return (await resolveEpisodePage(url)).guid;
}

// 从 master m3u8 的 EXT-X-STREAM-INF 解析真实码率档位与分辨率
function parseMasterPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const qualities = [];
  let pending = null;
  for (const line of lines) {
    const info = line.match(/#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)(?:[^\n]*RESOLUTION=(\d+)x(\d+))?/i);
    if (info) {
      pending = { bandwidth: parseInt(info[1], 10), width: info[2] ? parseInt(info[2], 10) : 0, height: info[3] ? parseInt(info[3], 10) : 0 };
      continue;
    }
    if (pending && line.trim() && !line.startsWith('#')) {
      qualities.push({ ...pending, url: new URL(line.trim(), baseUrl).href });
      pending = null;
    }
  }
  return qualities;
}

// 根据【实测真实分辨率】生成清晰度名称，不再虚标。
// 稳定路径多档可能同为 480x270，此时用【档位号】区分（档位号是央视标称码率，
// 虽然实际分辨率相同，但高标称档通常码率/编码质量略好，保留供用户选择）。
function qualityName(q) {
  const h = q.height;
  const w = q.width;
  let base;
  if (h >= 1080) base = '超清 1080P';
  else if (h >= 720) base = '高清 720P';
  else if (h >= 480) base = '标清 ' + w + 'x' + h;
  else if (h > 0) base = '流畅 ' + w + 'x' + h;
  else if (q.bandwidth >= 2000000) base = '标清';
  else if (q.bandwidth >= 1000000) base = '流畅';
  else base = '流畅';
  // 多个档位真实分辨率相同时，附加档位号区分（如 2000/1200/450 都是 480x270）
  if (q.code && h < 720) base += ' [' + q.code + ']';
  return base;
}

// 稳定路径 hls.cntv.lxdns.com/asp/hls/{code}/ 各档的【实测真实分辨率】。
// 重要修正（2026-11-28）：档位号是"标称码率"，不代表真实分辨率。
// 用 ffprobe 对普通内容逐档实测发现：
//   2000 → 480x270（虚标！此前误标为 720P）
//   1200 → 480x270（虚标！此前误标为 720P）
//   850  → 640x360（真实）
//   450  → 480x270（真实）
//   4000 → 1920x1080（4K 内容真实 1080P）
// 真 720P/1080P 只在 enc/h5e 加密路径，但该路径码流在 VLC/ffmpeg 下花屏，
// 故普通内容只能用稳定路径，标签按真实分辨率标注，不再虚标 720P。
const TIER_RESOLUTION = {
  '450':  { width: 480,  height: 270, bandwidth: 460800 },
  '850':  { width: 640,  height: 360, bandwidth: 870400 },
  '1200': { width: 480,  height: 270, bandwidth: 460800 },
  '2000': { width: 480,  height: 270, bandwidth: 460800 },
  '4000': { width: 1920, height: 1080, bandwidth: 4096000 }
};

// 稳定路径构造：hls.cntv.lxdns.com 的 /asp/hls/{code}/... 分片解码正常。
// 关键发现（2026-11-28）：manifest.hls_enc_url 的 /asp/enc/hls/... 分片虽 HTTP 200，
// 但 H264 码流实际损坏（ffprobe 大量 "top block unavailable/error while decoding MB"），
// 播放表现为花屏。因此改为从 master 读取档位信息，但用稳定域名 + /asp/hls/ 路径重建 URL。
const STABLE_HLS_HOST = 'https://hls.cntv.lxdns.com';

function buildStableTierUrl(guid, code) {
  return `${STABLE_HLS_HOST}/asp/hls/${code}/0303000a/3/default/${guid}/${code}.m3u8`;
}

// 快速探测某个档位在稳定路径上是否真实可用（读 m3u8 头部，不下载分片）
async function tierAvailable(guid, code) {
  try {
    const body = await httpGet(buildStableTierUrl(guid, code), { timeout: 10000, ttl: STREAM_TTL });
    return /^#EXTM3U/.test(body) && /\.ts/.test(body);
  } catch (e) { return false; }
}

// 从 master 中提取 guid（路径末段）和可用档位；master 可能来自 enc 或 hls_url，
// 只用它读取「有哪些档位」，实际 URL 一律用稳定路径重建。
async function buildQualityStreams(data) {
  const guidMatch = (data.hls_url || (data.manifest && data.manifest.hls_enc_url) || '')
    .match(/\/([0-9a-f]{32})\//);
  const guid = guidMatch && guidMatch[1];
  if (!guid) return [];

  // 优先从 enc master 读档位（它列得最全，含 4000/1080P），其次 hls_url master
  const masters = [
    data.manifest && data.manifest.hls_enc_url,
    data.hls_url
  ].filter(Boolean);

  let codes = [];
  for (const masterUrl of masters) {
    try {
      const body = await httpGet(masterUrl, { timeout: 12000, ttl: STREAM_TTL });
      const qualities = parseMasterPlaylist(body, masterUrl);
      for (const q of qualities) {
        const m = q.url.match(/\/hls\/(\d+)\//);
        if (m && !codes.includes(m[1])) codes.push(m[1]);
      }
      if (codes.length) break;
    } catch (e) { /* 尝试下一个 master */ }
  }
  // 兜底：常规四档
  if (!codes.length) codes = ['2000', '1200', '850', '450'];

  // 逐个探测稳定路径上真实存在的档位（并发）
  const checks = await mapLimit(codes, 5, async code => ({
    code, ok: await tierAvailable(guid, code)
  }));
  const usable = checks.filter(c => c.ok).map(c => c.code);
  if (!usable.length) return [];

  // 按码率降序，用稳定路径生成流；清晰度名称按该档真实分辨率标注
  return usable
    .map(code => ({ code, ...(TIER_RESOLUTION[code] || { bandwidth: parseInt(code, 10) * 1000 }) }))
    .sort((a, b) => b.bandwidth - a.bandwidth)
    .map(t => ({
      url: buildStableTierUrl(guid, t.code),
      name: qualityName(t),
      _real: t.width ? `${t.width}x${t.height}` : '',
      _bandwidth: t.bandwidth,
      _source: 'stable',
      _code: t.code,
      _width: t.width || 0,
      _height: t.height || 0
    }));
}

// 从 h5e/enc master 解析【真画质】档位（网页端在用，实测为真 720P/1080P）。
// 注意：该加密码流在 VLC/ffmpeg 严格解码下花屏，但网页播放器可容错解码，
// 电视端 Stremio 播放器实现不同，可能可以正常播放——因此并列返回供实测。
// 标签明确标注"网页源·可能花屏"，且排在稳定路径之后，避免误选为默认。
async function buildHdStreams(data) {
  const manifest = data.manifest || {};
  const masters = [manifest.hls_h5e_url, manifest.hls_enc_url, manifest.hls_enc2_url].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const masterUrl of masters) {
    let qualities = [];
    try {
      const body = await httpGet(masterUrl, { timeout: 12000, ttl: STREAM_TTL });
      qualities = parseMasterPlaylist(body, masterUrl);
    } catch (e) { continue; }
    if (!qualities.length) continue;
    // 每个 master 的档位探测后收集
    const checks = await mapLimit(qualities, 5, async q => {
      const code = (q.url.match(/\/hls\/(\d+)\//) || [])[1] || '';
      if (!code || seen.has(code)) return null;
      seen.add(code);
      let ok = false;
      try {
        const b = await httpGet(q.url, { timeout: 10000, ttl: STREAM_TTL });
        ok = /^#EXTM3U/.test(b) && /\.ts/.test(b);
      } catch (e) { ok = false; }
      if (!ok) return null;
      let label;
      if (q.height >= 1080) label = '原画 1080P';
      else if (q.height >= 720) label = '原画 720P';
      else if (q.height > 0) label = '原画 ' + q.width + 'x' + q.height;
      else label = '原画 [' + code + ']';
      return {
        url: q.url,
        name: label + ' [' + code + '] 网页源·已解密',
        behaviorHints: { notWebReady: false },
        _needsDecrypt: true,
        _source: 'h5e',
        _code: code,
        _width: q.width || 0,
        _height: q.height || 0,
        width: q.width, height: q.height, bandwidth: q.bandwidth
      };
    });
    for (const s of checks) if (s) out.push(s);
    if (out.length) break; // 一个 master 成功即可，避免 h5e/enc 重复
  }
  // 高画质优先排序（1080P > 720P > 其它）
  return out.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
}

// 画质从高到低排序：真实分辨率 → 宽度 → 带宽；同画质时稳定直连源优先。
// 之前的版本把全部稳定源放在解密源前面，导致 480x270 排在真 720P/1080P 之前。
function compareStreamQuality(a, b) {
  const ah = Number(a._height) || 0, bh = Number(b._height) || 0;
  if (ah !== bh) return bh - ah;
  const aw = Number(a._width) || 0, bw = Number(b._width) || 0;
  if (aw !== bw) return bw - aw;
  const ab = Number(a._bandwidth || a.bandwidth) || 0;
  const bb = Number(b._bandwidth || b.bandwidth) || 0;
  if (ab !== bb) return bb - ab;
  if (a._source !== b._source) return a._source === 'stable' ? -1 : 1;
  return 0;
}

async function getStreamsForEpisode(episodeUrl) {
  // v7：排序按真实画质降序；日志精确记录失败步骤
  const cacheKey = 'streams:v7:withHD:' + episodeUrl;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 步骤 A：解析 guid（可能要先跟随 JS 跳转桩页）
  const page = await resolveEpisodePage(episodeUrl);
  if (page.redirects.length) {
    logger.info('STREAM', '步骤 2a 老旧 URL 已跟随 JS 跳转到真实页面', {
      episodeUrl, finalUrl: page.finalUrl, hops: page.redirects.length
    });
  }
  const guid = page.guid;
  if (!guid) {
    logger.warn('STREAM', '步骤 2a 失败：页面无 guid，停止后续解析', {
      episodeUrl, finalUrl: page.finalUrl, htmlLength: page.htmlLength,
      reason: '未找到 var guid = "<32位hex>"，源站页面结构变化或内容已下线'
    });
    return [];
  }

  // 步骤 B：调用央视播放 API
  const apiUrl = VIDEO_API + guid;
  let data;
  try {
    data = await httpGetJson(apiUrl, { timeout: 15000 });
  } catch (e) {
    logger.error('STREAM', '步骤 2b 失败：播放 API 请求/解析异常', {
      apiUrl, episodeUrl, guid, error: e.message
    });
    return [];
  }
  const dataKeys = data ? Object.keys(data) : [];
  if (!data || (!data.hls_url && !data.manifest && !data.video)) {
    logger.warn('STREAM', '步骤 2b 播放 API 返回体无播放字段', {
      apiUrl, guid, keys: dataKeys, status: data && data.status,
      tip: data && data.tip_msg
    });
  }

  // 步骤 C：生成稳定源 + 网页解密源
  const stable = await buildQualityStreams(data || {});
  const hd = await buildHdStreams(data || {});
  let streams = [...stable, ...hd];

  // 最终降级：从 chapters 取可用直链
  if (!streams.length && data && data.video) {
    for (const key of ['chapters4', 'chapters3', 'chapters2', 'chapters']) {
      const ch = data.video[key];
      if (Array.isArray(ch) && ch.length && ch[0].url) {
        streams = [{ url: ch[0].url, name: '标准', _source: 'fallback' }];
        break;
      }
    }
  }
  if (!streams.length) {
    const masters = ((data && data.manifest) || {});
    logger.warn('STREAM', '步骤 2c 失败：所有档位均不可用（无 stream 输出）', {
      apiUrl, guid,
      hls_url: data && data.hls_url,
      masters: [masters.hls_h5e_url, masters.hls_enc_url, masters.hls_enc2_url].filter(Boolean),
      chapterKeys: data && data.video ? Object.keys(data.video) : [],
      reason: 'master 无可用档位，或稳定路径档位探测全部失败，且 chapters 无直链'
    });
  }

  // 按真实画质从高到低排序（1080P → 720P → 640x480 → 480x270）
  streams.sort(compareStreamQuality);

  if (streams.length) {
    streams = streams.map(s => ({
      url: s.url,
      name: s.name,
      behaviorHints: { notWebReady: false },
      ...(s._needsDecrypt ? { _needsDecrypt: true } : {}),
      ...(s._source ? { _source: s._source } : {}),
      ...(s._code ? { _code: String(s._code) } : {}),
      ...(s._width ? { _width: s._width } : {}),
      ...(s._height ? { _height: s._height } : {})
    }));
    cacheSet(cacheKey, streams, STREAM_TTL);
  }
  return streams;
}

module.exports = {
  getCatalog,
  getYxgCatalog,
  get4KCatalog,
  get4KAlbumMeta,
  searchCatalog,
  getAlbumMeta,
  getStreamsForEpisode,
  encodeSeriesId,
  encode4KSeriesId,
  encodeVideoId,
  decodeSeriesId,
  decode4KSeriesId,
  decodeVideoId,
  CATEGORIES,
  YXG_TYPES,
  FOURK_TYPES,
  JISHI_BASE
};
