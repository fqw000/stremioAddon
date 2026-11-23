'use strict';

/**
 * m3u8 去广告核心（纯函数，Node / Surge 通用）
 * ---------------------------------------------------------------------------
 * 设计要点：
 *   1) 解析成"段节点"，每段持有归属自己的标签（KEY / DISCONTINUITY / CUE / PDT / BYTERANGE）
 *   2) 闸门先行：直播、master、隐式 IV、隐式 BYTERANGE 一律放行
 *   3) 检测器只产证据，分块打分后再整块删除
 *   4) 重建时做"结构守恒"：KEY 状态连续、接缝不连续守恒、CUE 配对、序号修正
 *   5) 重建后自校验，任一不变量不满足 → 回滚原文
 *
 * 对外只有一个函数：filterPlaylist(text, url, cfg) -> { changed, body, report }
 */

/* ======================= 默认配置 ======================= */
const DEFAULTS = {
  /* ---- 日志配置 ---- */
  verbose: false,          // 是否开启详细日志
  logSegments: false,      // 是否打印每一个ts分片详情
  logMaxSegments: 300,     // 打印分片日志最大条数上限
  logChunks: false,        // 是否打印分块打分日志
  logAllChunks: false,     // 是否打印全部块（false只打印命中广告块）
  logMaxChunksForAll: 60,  // 全量块打印上限
  logRuleMisses: false,    // 是否打印规则未命中记录

  /* ---- 行为控制 ---- */
  dryRun: false,           // 试运行模式：只打分、不实际删除分片

  /* ---- 闸门放行规则（命中直接放行不处理） ---- */
  skipLive: true,                // 跳过直播流（无#EXT-X-ENDLIST）
  skipImplicitIV: true,          // 跳过无IV的AES-128加密流（隐式IV风险）
  skipByteRangeImplicit: true,   // 跳过无偏移的BYTERANGE分片
  minSegments: 6,                // 分片少于该数量直接放行，防止误删

  /* ---- 广告块形状约束 ---- */
  minAdBlockSegments: 2,         // 广告块最少分片数量
  maxAdBlockSegments: 8,         // 广告块最多分片数量
  minAdBlockDurationSec: 4,      // 广告块最小总时长(秒)
  maxAdBlockDurationSec: 30,     // 广告块单段最大时长(秒)
  maxAdBlockTotalSec: 36,        // 广告块总时长上限(秒)
  uniformTolerance: 0.8,         // 分片时长均匀度容忍差值
  splitOnDurationJump: true,     // 时长跳变时自动切分检测块

  /* ---- 安全兜底阈值（防止误删正片） ---- */
  maxRemovedRatio: 0.15,         // 可删除分片占总片源比例上限
  maxRemovedDurationSec: 120,    // 单次最多删除总时长(秒)
  minRemainingSegments: 4,       // 删除后剩余分片最少数量

  /* ---- 检测器开关 ---- */
  useRules: true,                // 开启URL关键词/正则规则检测
  useScte: true,                 // 开启SCTE35/CUE广告标记检测
  useKeyNone: true,              // 开启加密状态突变检测（加密流中间clear段）
  keynoneBounded: 'both',        // keynone边界条件 both=前后都加密 / either=一侧加密
  useHostAnomaly: true,          // 开启异域名分片检测
  useNamingReuse: true,          // 开启路径命名循环复用检测
  useMirrorReuse: true,          // 开启完整URL镜像重复检测
  useChunkScoring: true,         // 开启分块加权打分
  useCommentMarker: true,        // 开启清单注释广告标记检测

  /* ---- 打分阈值 ---- */
  baseThreshold: 0.60,           // 基础判定阈值
  firstBonus: 0.20,              // 片头块加分
  lastBonus: 0.10,               // 片尾块加分
  requireStructural: true,       // 弱形状信号必须搭配结构证据才允许删除

  /* ---- 各项特征权重 ---- */
  w: {
    uniformShort: 0.40,
    shortOnly: 0.20,
    disc: 0.15,
    offHost: 0.15,
    urlDev: 0.10,
    shortBetweenLong: 0.20,
    namingReuse: 0.25,
    denseShort: 0.10,
    seqIsland: 0.08,
    ruleWeak: 0.50,
    singlePenalty: -0.30,
    longPenalty: -0.20,
    totalPenalty: -0.30,
  },
};


/* ======================= 默认配置 ======================= */
const DEFAULT_RULES = {
  // 路径层面正则特征，匹配URL路径广告关键词
  globalRegex: [
    /\/ad\//i,
    /\/ads\//i,
    /\/adv\//i,
    /_ad_/i,
    /_ads_/i,
    /\/adjump/i,
    /\/guanggao\//i,
    /\/adseg\//i,
    /\/advideo\//i,
    /\/adplay\//i,
    /\/pre_ad\//i,
    /\/mid_ad\//i,
    /\/post_ad\//i,
    /\/splash\//i,
    /\/openad\//i,
    /\/popad\//i,
    /\/adcard\//i,
    /\/adbridge\//i,
    /\/adskip\//i,
    /\/adout\//i,
    /\/adinsert\//i,
    /\/admarker\//i,
    /\/gg\//i,
    /\/sp\//i,
    /\/promo\//i,
    /\/preroll\//i,
    /\/midroll\//i,
    /\/rollad\//i,
    /\/advertise\//i,
    /\/adflow\//i,
    /\/adlog\//i,
    /\/adtrack\//i,
    /\/adstat\//i,
    /\/adreport\//i,
    /\/adimp\//i,
    /\/adclick\//i,
    /\/adcdn\//i,
    /\/adres\//i,
    /\/adres\//i,
    /\/adfile\//i,
    /\/admedia\//i,
    /\/advod\//i,
    /\/adclip\//i,
    /\/adshort\//i,
    /\/adfeed\//i,
    /\/adnative\//i,
    /\/adinterstitial\//i,
  ],
  // 全局关键词，URL包含即命中广告特征
  // 全局关键词：中文、拼音、国内点播平台广告标识，m3u8分片URL内常见
  globalKeywords: [
    "sponsor", "promo", "splash", "vip_ad", "advert", "advertisement",
    "interstitial", "redtraffic", "preroll", "midroll", "rollad",
    "guanggao", "adseg", "advideo", "adplay", "pre_ad", "mid_ad",
    "开屏", "片头广告", "插播广告", "广告分片", "广告段", "贴片广告",
    "前贴片", "中插", "后贴片", "广告跳转", "广告源", "广告cdn",
    "激励广告", "推广", "招商", "商业", "adinject", "admarker",
    "adinsert", "adout", "adbridge", "popad", "openad", "adcard",
  ],
  // 按片源host单独追加规则：{ host: 'foo.com', keywords: [], regex: [] }
  hostRules: [
    {
      host: "ad.qq.com",
      keywords: ["ad", "advert", "preroll", "midroll"],
      regex: [/adseg/, /advideo/, /pre_ad/]
    },
    {
      host: "ads.qq.com",
      keywords: ["ad", "advert"],
      regex: [/adtrack/, /adstat/]
    },
    {
      host: "ad.youku.com",
      keywords: ["ad", "preroll", "midroll"],
      regex: [/adseg/, /adclip/]
    },
    {
      host: "ad.iqiyi.com",
      keywords: ["ad", "advert", "rollad"],
      regex: [/advideo/, /adcdn/]
    },
    {
      host: "ad.mgtv.com",
      keywords: ["ad", "preroll"],
      regex: [/adseg/]
    },
    {
      host: "ad.bilibili.com",
      keywords: ["ad", "advert"],
      regex: [/advideo/]
    },
    {
      host: "ad.zyvod.com",
      keywords: ["guanggao", "ad", "广告"],
      regex: [/adseg/, /adplay/]
    },
    {
      host: "ad.zyplay.com",
      keywords: ["guanggao", "ad"],
      regex: [/advideo/]
    },
    {
      host: "ad.kkyst.com",
      keywords: ["ad", "guanggao"],
      regex: [/adclip/]
    },
    {
      host: "ad.vodjx.com",
      keywords: ["ad", "guanggao"],
      regex: [/adseg/]
    },
    {
      host: "ad.catvod.org",
      keywords: ["ad", "advert"],
      regex: [/advideo/]
    },
    {
      host: "shturl.cc/27LjB",
      keywords: ["ad", "guanggao"],
      regex: [/adseg/, /adclip/]
    },
    {
      host: "ad.m3u8.tv",
      keywords: ["ad"],
      regex: [/advideo/]
    },
  ],
};

function mergeCfg(user) {
  const cfg = Object.assign({}, DEFAULTS, user || {});
  cfg.w = Object.assign({}, DEFAULTS.w, (user && user.w) || {});
  cfg.rules = Object.assign({}, DEFAULT_RULES, (user && user.rules) || {});
  return cfg;
}

/* ======================= 基础工具 ======================= */

function hostOf(uri) {
  if (!uri) return null;
  const m = String(uri).match(/^[a-z][a-z0-9+.\-]*:\/\/([^/?#:]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** 命名特征：去掉协议/HOST/查询串，数字归一化成 #，便于识别"同一广告位循环" */
function namingKey(uri) {
  if (!uri) return '';
  let p = String(uri);
  p = p.replace(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+/i, '');
  p = p.split(/[?#]/)[0];
  return p.replace(/\d+/g, '#').toLowerCase();
}

function mode(arr) {
  const c = {};
  for (const v of arr) if (v) c[v] = (c[v] || 0) + 1;
  let best = null;
  let n = 0;
  for (const k in c) if (c[k] > n) { best = k; n = c[k]; }
  return best;
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…(' + s.length + ')' : s;
}

function parseDuration(inf) {
  const rest = inf.slice('#EXTINF:'.length).trim();
  const comma = rest.indexOf(',');
  const num = (comma >= 0 ? rest.slice(0, comma) : rest).trim();
  const d = parseFloat(num);
  return Number.isFinite(d) ? d : 0;
}

const GLOBAL_HEAD = [
  '#EXTM3U', '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-PLAYLIST-TYPE', '#EXT-X-I-FRAMES-ONLY',
  '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-START', '#EXT-X-MAP', '#EXT-X-ALLOW-CACHE',
  '#EXT-X-SERVER-CONTROL', '#EXT-X-PART-INF',
];

function isGlobalHead(t) {
  return GLOBAL_HEAD.some((p) => t.indexOf(p) === 0);
}

function isCueStart(t) {
  if (t.indexOf('#EXT-X-CUE-OUT') === 0) return true;
  if (t.indexOf('#EXT-X-SCTE35') === 0) return true;
  if (t.indexOf('#EXT-OATCLS-SCTE35') === 0) return true;
  if (t.indexOf('#EXT-X-DATERANGE') === 0 && t.toUpperCase().indexOf('SCTE35') >= 0) return true;
  return false;
}

function isCueIn(t) {
  return t.indexOf('#EXT-X-CUE-IN') === 0;
}

function isCueAny(t) {
  return isCueStart(t) || isCueIn(t);
}

/* ======================= 解析 ======================= */

function parseNodes(text) {
  const raw = String(text).split(/\r?\n/);
  const head = [];
  const nodes = [];
  const tail = [];
  let pending = [];
  let inf = null;
  let seenSeg = false;

  for (const line of raw) {
    const t = line.trim();
    if (!t) continue;

    if (t.indexOf('#EXTINF:') === 0) { inf = t; continue; }

    if (t[0] !== '#') {
      if (inf) {
        nodes.push({
          i: nodes.length,
          inf,
          uri: t,
          dur: parseDuration(inf),
          tags: pending.slice(),
          reasons: [],
        });
        inf = null;
        pending = [];
        seenSeg = true;
      } else {
        head.push(...pending, t); // master 的 STREAM-INF + URI
        pending = [];
      }
      continue;
    }

    if (!seenSeg && !inf && isGlobalHead(t)) { head.push(t); continue; }
    pending.push(t);
  }
  tail.push(...pending);

  return { head, nodes, tail };
}

/** 前向推导：有效 KEY、SCTE 区间、隐式 IV、隐式 BYTERANGE */
function deriveState(parsed) {
  let key = { method: 'clear', iv: null, raw: null };
  let inAd = false;
  let implicitIV = false;
  let implicitByteRange = false;
  const keyMethods = [];

  for (const n of parsed.nodes) {
    for (const tag of n.tags) {
      if (tag.indexOf('#EXT-X-KEY:') === 0) {
        const m = (tag.match(/METHOD=([^,\s]+)/) || [])[1] || '';
        const iv = (tag.match(/,IV=([^,\s]+)/) || [])[1] || null;
        const method = m.toUpperCase();
        key = { method, iv, raw: tag };
        if (keyMethods.indexOf(method) < 0) keyMethods.push(method);
        if (/^(AES-128|SAMPLE-AES)/.test(method) && !iv) implicitIV = true;
      }
      if (isCueStart(tag)) inAd = true;
      else if (isCueIn(tag)) inAd = false;

      if (tag.indexOf('#EXT-X-BYTERANGE:') === 0 && tag.indexOf('@') < 0) implicitByteRange = true;
    }
    n.key = key;
    n.scte = inAd;
    n.hasDisc = n.tags.some((t) => t.indexOf('#EXT-X-DISCONTINUITY') === 0);
    n.cueTags = n.tags.filter(isCueAny);
  }

  return {
    nodes: parsed.nodes,
    keyMethods,
    encrypted: parsed.nodes.some((n) => n.key.method && n.key.method !== 'clear' && n.key.method !== 'NONE'),
    implicitIV,
    implicitByteRange,
  };
}

/* ======================= 规则检测 ======================= */

function describeRules(playlistHost, RULES) {
  const list = [];
  for (const kw of RULES.globalKeywords) {
    list.push({ label: 'keyword:' + kw, kind: 'kw', pattern: kw, display: kw, hostMatch: true });
  }
  for (const re of RULES.globalRegex) {
    list.push({ label: 'regex:' + re.source, kind: 're', pattern: re, display: '/' + re.source + '/', hostMatch: true });
  }
  if (RULES.hostRules && RULES.hostRules.length && playlistHost) {
    const h = playlistHost.toLowerCase();
    for (const hr of RULES.hostRules) {
      const hostMatch = h === hr.host || h.endsWith('.' + hr.host);
      for (const kw of hr.keywords || []) {
        list.push({ label: 'hostkw:' + kw, kind: 'kw', pattern: kw, display: hr.host + ' *' + kw + '*', host: hr.host, hostMatch });
      }
      for (const re of hr.regex || []) {
        list.push({ label: 'hostre:' + re.source, kind: 're', pattern: re, display: hr.host + ' /' + re.source + '/', host: hr.host, hostMatch });
      }
    }
  }
  return list;
}

function testRule(rule, uri) {
  if (rule.hostMatch === false) return 'skip';
  if (rule.kind === 'kw') return uri.indexOf(rule.pattern) >= 0;
  if (rule.kind === 're') {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(uri);
  }
  return false;
}

function detectRules(nodes, playlistHost, cfg) {
  const rules = describeRules(playlistHost, cfg.rules);
  const stats = {};
  for (const r of rules) {
    stats[r.label] = { label: r.label, display: r.display, kind: r.kind, host: r.host, hostMatch: r.hostMatch, hits: 0, miss: 0, skip: 0, segs: [] };
  }

  for (const n of nodes) {
    n.ruleHits = [];
    n.ruleMiss = [];
    for (const r of rules) {
      const res = testRule(r, n.uri);
      if (res === 'skip') { stats[r.label].skip++; continue; }
      if (res) {
        n.ruleHits.push(r.label);
        stats[r.label].hits++;
        stats[r.label].segs.push(n.i);
      } else {
        n.ruleMiss.push(r.label);
        stats[r.label].miss++;
      }
    }
    if (n.ruleHits.length) n.reasons.push('rule:' + n.ruleHits[0]);
  }

  return { rules, stats };
}

/* ======================= 各启发式 ======================= */

function detectKeyNone(nodes, cfg) {
  const isClear = (n) => n.key.method === 'clear' || n.key.method === 'NONE';
  let i = 0;
  while (i < nodes.length) {
    if (!isClear(nodes[i])) { i++; continue; }
    let j = i;
    while (j < nodes.length && isClear(nodes[j])) j++;
    const n = j - i;
    const leftEnc = i > 0 && !isClear(nodes[i - 1]);
    const rightEnc = j < nodes.length && !isClear(nodes[j]);
    const bounded = cfg.keynoneBounded === 'both' ? (leftEnc && rightEnc) : (leftEnc || rightEnc);
    if (bounded && n >= cfg.minAdBlockSegments && n <= cfg.maxAdBlockSegments) {
      for (let k = i; k < j; k++) nodes[k].reasons.push('keynone');
    }
    i = j;
  }
}

function detectReuse(nodes, cfg) {
  const uriCount = {};
  const keyCount = {};
  for (const n of nodes) {
    uriCount[n.uri] = (uriCount[n.uri] || 0) + 1;
    const k = namingKey(n.uri);
    keyCount[k] = (keyCount[k] || 0) + 1;
  }
  const distinctUri = Object.keys(uriCount).length;
  const distinctKey = Object.keys(keyCount).length;

  for (const n of nodes) {
    if (cfg.useMirrorReuse && distinctUri >= 4 && uriCount[n.uri] >= 3 && n.dur <= cfg.maxAdBlockDurationSec) {
      n.reasons.push('mirror-reuse');
    }
    if (cfg.useNamingReuse && distinctKey >= 3 && keyCount[namingKey(n.uri)] >= 3 && n.dur <= cfg.maxAdBlockDurationSec) {
      n.reasons.push('naming-reuse');
    }
  }
}

/* ======================= 私有注释标记 ======================= */

// PPVOD 等在清单里写「# ppvod-ad-injected v1」作为广告块起点（xlsx AD-02）。
// 这类非标准注释行是强证据：命中即把所属块整体判为广告。
const AD_COMMENT_RE = /ad[-_]?(inject|insert|mark|marker)|ppvod|guanggao|adseg|插播|广告/i;

function detectCommentMarkers(nodes, cfg) {
  if (!cfg.useCommentMarker) return;
  for (const n of nodes) {
    for (const tag of n.tags) {
      const t = tag.trim();
      if (t[0] !== '#' || t.indexOf('#EXT') === 0) continue; // 只看非标准注释行
      if (AD_COMMENT_RE.test(t)) {
        n.reasons.push('ad-comment');
        break;
      }
    }
  }
}

/* ======================= 分块与打分 ======================= */

function buildChunks(nodes, cfg) {
  const chunks = [];
  let cur = [];
  let prev = null;

  for (const n of nodes) {
    let boundary = false;
    if (cur.length && prev) {
      if (n.hasDisc) boundary = true;
      else if (n.key.raw !== prev.key.raw) boundary = true;
      else if (n.scte !== prev.scte) boundary = true;
      else if (cfg.splitOnDurationJump &&
        Math.abs(n.dur - prev.dur) >= Math.max(3, 0.35 * Math.max(n.dur, prev.dur))) boundary = true;
    }
    if (boundary) { chunks.push(cur); cur = []; }
    cur.push(n);
    prev = n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function ratioWith(chunk, reasonPrefix) {
  const hit = chunk.filter((s) => s.reasons.some((r) => r.indexOf(reasonPrefix) === 0)).length;
  return hit / chunk.length;
}

function scoreChunk(chunk, idx, chunks, ctx, cfg) {
  const n = chunk.length;
  const durs = chunk.map((s) => s.dur);
  const total = durs.reduce((a, b) => a + b, 0);
  const min = Math.min.apply(null, durs);
  const max = Math.max.apply(null, durs);
  const uniform = n >= 2 && (max - min) <= cfg.uniformTolerance;
  const shortShape = min >= cfg.minAdBlockDurationSec && total <= cfg.maxAdBlockTotalSec;

  const notes = [];
  let score = 0;
  let strong = null;

  const scteRatio = chunk.filter((s) => s.scte).length / n;
  const keynoneRatio = ratioWith(chunk, 'keynone');
  const ruleRatio = chunk.filter((s) => s.ruleHits && s.ruleHits.length).length / n;
  const commentHit = cfg.useCommentMarker && chunk.some((s) => s.reasons.indexOf('ad-comment') >= 0);

  if (cfg.useCommentMarker && commentHit) strong = 'ad-comment';
  else if (cfg.useScte && scteRatio >= 0.5) strong = 'scte';
  else if (cfg.useKeyNone && keynoneRatio >= 0.5) strong = 'keynone';
  else if (cfg.useRules && ruleRatio >= 0.5 && shortShape && n <= cfg.maxAdBlockSegments) strong = 'rule';

  if (!strong) {
    if (shortShape && uniform) { score += cfg.w.uniformShort; notes.push('uniform-short'); }
    else if (shortShape) { score += cfg.w.shortOnly; notes.push('short'); }

    if (n < cfg.minAdBlockSegments) { score += cfg.w.singlePenalty; notes.push('single'); }
    if (n > cfg.maxAdBlockSegments) { score += cfg.w.longPenalty; notes.push('long' + n); }
    if (total > 90) { score += cfg.w.totalPenalty; notes.push('total>90s'); }

    if (chunk[0].hasDisc) { score += cfg.w.disc; notes.push('disc'); }

    if (cfg.useHostAnomaly && ctx.dominantHost &&
      chunk.some((s) => hostOf(s.uri) && hostOf(s.uri) !== ctx.dominantHost)) {
      score += cfg.w.offHost; notes.push('offhost');
    }

    if (ctx.dominantKey && chunk.some((s) => namingKey(s.uri) !== ctx.dominantKey)) {
      score += cfg.w.urlDev; notes.push('url-dev');
    }

    if (cfg.useNamingReuse && ratioWith(chunk, 'naming-reuse') >= 0.5) {
      score += cfg.w.namingReuse; notes.push('naming-reuse');
    }
    if (cfg.useMirrorReuse && ratioWith(chunk, 'mirror-reuse') >= 0.5) {
      score += cfg.w.namingReuse; notes.push('mirror-reuse');
    }

    // 短块夹在长块之间
    const prevChunk = idx > 0 ? chunks[idx - 1] : null;
    const nextChunk = idx < chunks.length - 1 ? chunks[idx + 1] : null;
    if (prevChunk && nextChunk) {
      const prevDur = prevChunk[prevChunk.length - 1].dur;
      const nextDur = nextChunk[0].dur;
      if (prevDur >= 1.5 * max && nextDur >= 1.5 * max) {
        score += cfg.w.shortBetweenLong; notes.push('short-between-long');
      }
    }

    // 密集流里的极短块
    if (ctx.medianDur > 0 && ctx.medianDur <= 5 && uniform && n >= 2 * Math.max(1, ctx.avgChunkSize)) {
      score += cfg.w.denseShort; notes.push('dense-short');
    }

    // 序号孤岛：命名特征与前后块都不连续
    if (prevChunk && nextChunk) {
      const curKey = mode(chunk.map((s) => namingKey(s.uri)));
      const pk = mode(prevChunk.map((s) => namingKey(s.uri)));
      const nk = mode(nextChunk.map((s) => namingKey(s.uri)));
      if (curKey && pk && nk && curKey !== pk && curKey !== nk) {
        score += cfg.w.seqIsland; notes.push('seq-island');
      }
    }

    if (cfg.useRules && ruleRatio >= 0.5 && !strong) {
      score += cfg.w.ruleWeak; notes.push('rule-weak');
    }
  }

  const threshold = cfg.baseThreshold + (idx === 0 ? cfg.firstBonus : 0) + (idx === chunks.length - 1 ? cfg.lastBonus : 0);

  // 弱形状信号（uniform-short / short / short-between-long / dense-short）必须叠加
  // 至少一个结构信号（discontinuity / 命名跳变 / 异域名 / 注释 / URL 关键词）才允许删除；
  // 否则压制成片内的字幕、慢镜头等短块会被误删。
  const structuralNotes = ['disc', 'offhost', 'url-dev', 'naming-reuse', 'mirror-reuse', 'seq-island', 'rule-weak'];
  const hasStructural = notes.some((x) => structuralNotes.indexOf(x) >= 0);
  let hit = strong ? true : score >= threshold;
  if (!strong && hit && cfg.requireStructural && !hasStructural) {
    hit = false;
    notes.push('shape-only');
  }

  return {
    idx, n, total: +total.toFixed(1), min: +min.toFixed(1), max: +max.toFixed(1),
    uniform, shortShape, scteRatio: +scteRatio.toFixed(2), keynoneRatio: +keynoneRatio.toFixed(2),
    ruleRatio: +ruleRatio.toFixed(2),
    score: strong ? 1 : +score.toFixed(2), threshold: +threshold.toFixed(2),
    strong, notes: notes.join('+'), hit,
  };
}

/* ======================= 重建 ======================= */

function rangeHasDisc(nodes, from, to) {
  for (let i = from; i <= to; i++) if (nodes[i] && nodes[i].hasDisc) return true;
  return false;
}

function hasDroppedIn(dropped, from, to) {
  for (let i = from; i <= to; i++) if (dropped.has(i)) return true;
  return false;
}

/** CUE 配对：删掉孤立的 CUE-IN / 悬空的 CUE-OUT */
function balanceCues(lines) {
  const out = [];
  let open = null;
  let removed = 0;
  for (const l of lines) {
    if (isCueStart(l)) {
      if (open !== null) { out.splice(open, 1); removed++; open = null; }
      open = out.length;
      out.push(l);
    } else if (isCueIn(l)) {
      if (open === null) { removed++; continue; }
      open = null;
      out.push(l);
    } else {
      out.push(l);
    }
  }
  if (open !== null) { out.splice(open, 1); removed++; }
  return { lines: out, removed };
}

function rebuild(parsed, dropped, cfg) {
  const nodes = parsed.nodes;
  const head = parsed.head.slice();

  // 开头被删掉的段数 / 不连续标记数
  let droppedAtStart = 0;
  let discAtStart = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (!dropped.has(i)) break;
    droppedAtStart++;
    if (nodes[i].hasDisc) discAtStart++;
  }

  for (let i = 0; i < head.length; i++) {
    if (head[i].indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
      const v = parseInt(head[i].slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
      if (Number.isFinite(v)) head[i] = '#EXT-X-MEDIA-SEQUENCE:' + (v + droppedAtStart);
    }
    if (head[i].indexOf('#EXT-X-DISCONTINUITY-SEQUENCE:') === 0 && discAtStart > 0) {
      const v = parseInt(head[i].slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 10);
      if (Number.isFinite(v)) head[i] = '#EXT-X-DISCONTINUITY-SEQUENCE:' + (v + discAtStart);
    }
  }

  const out = head.slice();
  let emittedKey = head.some((l) => l.indexOf('#EXT-X-KEY:') === 0) ? '__headkey__' : null;
  let prevKept = -1;
  let discEmitted = false;

  for (let i = 0; i < nodes.length; i++) {
    if (dropped.has(i)) continue;
    const n = nodes[i];

    // KEY 状态连续性：有效 KEY 变化了就补一行
    if (n.key.raw && n.key.raw !== emittedKey) {
      out.push(n.key.raw);
      emittedKey = n.key.raw;
    }

    // 接缝不连续守恒
    const gapDropped = hasDroppedIn(dropped, prevKept + 1, i - 1);
    const wantDisc = n.hasDisc || (gapDropped && rangeHasDisc(nodes, prevKept + 1, i - 1));
    if (wantDisc && !discEmitted) out.push('#EXT-X-DISCONTINUITY');
    discEmitted = wantDisc;

    for (const tag of n.tags) {
      if (tag.indexOf('#EXT-X-KEY:') === 0) continue;         // 由上面的状态机统一补
      if (tag.indexOf('#EXT-X-DISCONTINUITY') === 0) continue; // 由接缝规则统一处理
      out.push(tag);
    }
    out.push(n.inf, n.uri);
    prevKept = i;
  }

  out.push(...parsed.tail);
  return { lines: out, droppedAtStart, discAtStart };
}

/* ======================= 校验 ======================= */

function verify(body, expectCount, cfg) {
  const issues = [];
  const parsed = parseNodes(body);
  const st = deriveState(parsed);

  if (body.trim().indexOf('#EXTM3U') !== 0) issues.push('not-start-with-EXTM3U');
  if (parsed.nodes.length !== expectCount) issues.push('segment-count ' + parsed.nodes.length + '!=' + expectCount);

  const extinf = (body.match(/#EXTINF:/g) || []).length;
  if (extinf !== expectCount) issues.push('extinf ' + extinf + '!=' + expectCount);

  const discCount = (body.match(/^#EXT-X-DISCONTINUITY\s*$/gm) || []).length;
  if (/#EXT-X-DISCONTINUITY\r?\n#EXT-X-DISCONTINUITY/.test(body)) issues.push('double-discontinuity');

  const cueOut = (body.match(/#EXT-X-CUE-OUT|#EXT-X-SCTE35|#EXT-OATCLS-SCTE35/g) || []).length;
  const cueIn = (body.match(/#EXT-X-CUE-IN/g) || []).length;
  if (cueOut !== cueIn) issues.push('cue-unbalanced ' + cueOut + '/' + cueIn);

  if (parsed.nodes.length < cfg.minRemainingSegments) issues.push('too-few-remaining ' + parsed.nodes.length);
  if (st.implicitIV !== undefined && (body.match(/#EXT-X-KEY:[^\n]*METHOD=(AES-128|SAMPLE)/i) && !body.match(/,IV=/))) {
    issues.push('implicit-iv-after-rebuild');
  }

  return { ok: issues.length === 0, issues, segments: parsed.nodes.length, discCount, cueOut, cueIn };
}

/* ======================= 主入口 ======================= */

function filterPlaylist(text, url, userCfg) {
  const cfg = mergeCfg(userCfg);
  const lines = [];
  const log = (m) => lines.push('[AdFilter] ' + m);
  const logKV = (k, v) => lines.push('[AdFilter]   ' + k + ': ' + v);
  const section = (t) => lines.push('[AdFilter] ===== ' + t + ' =====');

  const report = { url: url || '', verdict: 'CLEAN', gate: null, parse: {}, env: {}, rules: null, chunks: [], summary: {}, removed: [], rebuild: {}, verify: {} };

  /* ---------- 解析 ---------- */
  const parsed = parseNodes(text);
  const st = deriveState(parsed);
  const nodes = parsed.nodes;

  const playlistHost = hostOf(url || '');
  const totalDur = nodes.reduce((a, b) => a + b.dur, 0);
  const isMaster = parsed.head.some((l) => l.indexOf('#EXT-X-STREAM-INF') === 0);
  const hasEndList = parsed.tail.some((l) => l.indexOf('#EXT-X-ENDLIST') === 0) ||
    String(text).indexOf('#EXT-X-ENDLIST') >= 0;

  report.parse = { segments: nodes.length, duration: +totalDur.toFixed(1), lines: String(text).split(/\r?\n/).length, master: isMaster };
  report.env = { host: playlistHost || '-', encrypted: st.encrypted, implicitIV: st.implicitIV, implicitByteRange: st.implicitByteRange, keys: st.keyMethods };

  /* ---------- 闸门 ---------- */
  let gate = null;
  if (String(text).trim().indexOf('#EXTM3U') !== 0) gate = 'not-m3u8';
  else if (isMaster) gate = 'master-playlist';
  else if (cfg.skipLive && !hasEndList) gate = 'live-or-event(no-ENDLIST)';
  else if (cfg.skipByteRangeImplicit && st.implicitByteRange) gate = 'byterange-without-offset';
  else if (cfg.skipImplicitIV && st.implicitIV) gate = 'aes128-implicit-iv';
  else if (nodes.length < cfg.minSegments) gate = 'too-few-segments(' + nodes.length + ')';

  report.gate = gate;

  section('ENTRY');
  logKV('url', truncate(url || '(local)', 120));
  logKV('bytes', String(text).length);
  section('PARSE');
  logKV('segments', nodes.length);
  logKV('duration', totalDur.toFixed(1) + 's');
  logKV('master', isMaster);
  logKV('endlist', hasEndList);
  section('ENV');
  logKV('playlist host', playlistHost || '-');
  logKV('encrypted', st.encrypted ? 'yes(' + st.keyMethods.join(',') + ')' : 'no');
  logKV('implicit IV', st.implicitIV ? 'YES(风险)' : 'no');
  logKV('implicit byterange', st.implicitByteRange ? 'YES(风险)' : 'no');

  if (gate) {
    report.verdict = 'SKIP';
    log('RESULT: SKIP (' + gate + ')');
    log('DECISION: PASSTHROUGH');
    report.lines = lines;
    return { changed: false, body: text, report };
  }

  /* ---------- 规则 ---------- */
  const ruleInfo = cfg.useRules ? detectRules(nodes, playlistHost, cfg) : { rules: [], stats: {} };
  report.rules = {
    total: ruleInfo.rules.length,
    effective: 0,
    dead: 0,
    list: [],
  };
  if (cfg.useRules) {
    section('RULE STATS');
    logKV('rule count', ruleInfo.rules.length);
    for (const r of ruleInfo.rules) {
      const s = ruleInfo.stats[r.label];
      let status;
      if (s.skip === nodes.length) status = 'SKIP';
      else if (s.hits === 0) status = 'DEAD';
      else if (s.hits === nodes.length) status = 'ALL';
      else status = 'HIT';
      if (status === 'HIT' || status === 'ALL') report.rules.effective++;
      if (status === 'DEAD') report.rules.dead++;
      report.rules.list.push({ label: s.label, display: s.display, hits: s.hits, miss: s.miss, status, segs: s.segs.slice(0, 8) });
      log('  [' + status + '] ' + s.label + '  hits=' + s.hits + ' miss=' + s.miss + '  ' + s.display +
        (s.hits ? ' segs=[' + s.segs.slice(0, 8).join(',') + (s.segs.length > 8 ? ',…' : '') + ']' : ''));
    }
    logKV('summary', 'effective=' + report.rules.effective + ' dead=' + report.rules.dead + ' total=' + ruleInfo.rules.length);
  }

  /* ---------- 启发式 ---------- */
  if (cfg.useCommentMarker) detectCommentMarkers(nodes, cfg);
  if (st.encrypted) {
    if (cfg.useKeyNone) detectKeyNone(nodes, cfg);
  } else {
    if (cfg.useNamingReuse || cfg.useMirrorReuse) detectReuse(nodes, cfg);
  }

  /* ---------- 分块 ---------- */
  const chunks = buildChunks(nodes, cfg);
  // 相对 URI（无 host）在真实清单里很常见：只有当带 host 的段占多数时才认定主流主机
  const hostsWithValue = nodes.map((n) => hostOf(n.uri)).filter(Boolean);
  const ctx = {
    dominantHost: hostsWithValue.length >= nodes.length * 0.5 ? mode(hostsWithValue) : null,
    dominantKey: mode(nodes.map((n) => namingKey(n.uri))),
    medianDur: median(nodes.map((n) => n.dur).filter((d) => d > 0)),
    avgChunkSize: chunks.length ? nodes.length / chunks.length : nodes.length,
  };

  section('CHUNKS');
  logKV('chunk count', chunks.length);
  logKV('context', 'dominantHost=' + (ctx.dominantHost || '-') + ' medianDur=' + ctx.medianDur.toFixed(2) + 's');

  const scores = [];
  let removedCount = 0;
  let removedDur = 0;
  const dropped = new Set();

  chunks.forEach((chunk, idx) => {
    const r = scoreChunk(chunk, idx, chunks, ctx, cfg);
    scores.push(r);
    if (r.hit) {
      for (const s of chunk) dropped.add(s.i);
      removedCount += chunk.length;
      removedDur += chunk.reduce((a, s) => a + s.dur, 0);
    }
    if (cfg.logChunks && (cfg.logAllChunks || r.hit)) {
      log('  chunk#' + idx + (idx === 0 ? '(first)' : idx === chunks.length - 1 ? '(last)' : '') +
        ' n=' + r.n + ' total=' + r.total + 's [' + r.min + '~' + r.max + ']' +
        ' score=' + r.score + '/thr=' + r.threshold +
        ' => ' + (r.hit ? (r.strong ? 'AD(' + r.strong + ')' : 'AD') : 'keep') +
        (r.notes ? ' {' + r.notes + '}' : ''));
    }
  });
  report.chunks = scores;

  /* ---------- 逐段日志 ---------- */
  if (cfg.logSegments && nodes.length <= cfg.logMaxSegments) {
    section('SEGMENTS');
    for (const n of nodes) {
      const ruleStr = n.ruleHits ? ' r=' + n.ruleHits.length + '/' + (n.ruleHits.length + n.ruleMiss.length) +
        (n.ruleHits.length ? '[' + n.ruleHits.join('|') + ']' : '') : ' r=n/a';
      const reasonStr = n.reasons.length ? ' ev=[' + n.reasons.join('|') + ']' : '';
      log('  [' + n.i + '] ' + n.dur + 's key=' + (n.key.method || '-') +
        ' disc=' + (n.hasDisc ? 1 : 0) + ' scte=' + (n.scte ? 1 : 0) +
        ruleStr + reasonStr + ' uri=' + truncate(n.uri, 96));
    }
  }

  /* ---------- 汇总 ---------- */
  const reasonCounts = {};
  for (const i of dropped) {
    for (const r of nodes[i].reasons) reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }
  const reasonSummary = Object.keys(reasonCounts).map((k) => k + 'x' + reasonCounts[k]).join(', ') || 'none';

  section('SUMMARY');
  logKV('segments to remove', removedCount + '/' + nodes.length);
  logKV('duration to remove', removedDur.toFixed(1) + 's / ' + totalDur.toFixed(1) + 's');
  logKV('reasons', reasonSummary);

  report.summary = { removedCount, removedDur: +removedDur.toFixed(1), totalDur: +totalDur.toFixed(1), reasons: reasonCounts };

  /* ---------- 兜底 ---------- */
  const ratio = nodes.length ? removedCount / nodes.length : 0;
  if (nodes.length - removedCount < cfg.minRemainingSegments) {
    report.verdict = 'REVERT';
    log('RESULT: REVERT (remaining< ' + cfg.minRemainingSegments + ')');
    log('DECISION: PASSTHROUGH');
    report.lines = lines;
    return { changed: false, body: text, report };
  }
  if (removedCount > cfg.maxAdBlockSegments && (ratio > cfg.maxRemovedRatio || removedDur > cfg.maxRemovedDurationSec)) {
    report.verdict = 'REVERT';
    log('RESULT: REVERT (over safety cap) ratio=' + (ratio * 100).toFixed(1) + '% dur=' + removedDur.toFixed(1) + 's');
    log('DECISION: PASSTHROUGH');
    report.lines = lines;
    return { changed: false, body: text, report };
  }
  if (!removedCount) {
    log('RESULT: CLEAN (no ad candidate)');
    log('DECISION: PASSTHROUGH');
    report.verdict = 'CLEAN';
    report.lines = lines;
    return { changed: false, body: text, report };
  }

  /* ---------- 删除明细 ---------- */
  section('REMOVED');
  for (const i of Array.from(dropped).sort((a, b) => a - b)) {
    const n = nodes[i];
    report.removed.push({ i, dur: n.dur, reasons: n.reasons.slice(), uri: n.uri });
    log('  [' + i + '] ' + n.dur + 's [' + n.reasons.join('|') + '] ' + truncate(n.uri, 120));
  }

  /* ---------- 重建 ---------- */
  section('REBUILD');
  const built = rebuild(parsed, dropped, cfg);
  const balanced = balanceCues(built.lines);
  if (balanced.removed) log('  cue-cleanup: removed ' + balanced.removed + ' unpaired cue tag(s)');
  const newBody = balanced.lines.join('\n');

  const v = verify(newBody, nodes.length - removedCount, cfg);
  report.verify = v;

  logKV('MEDIA-SEQUENCE', (built.droppedAtStart ? '+ ' + built.droppedAtStart : 'untouched'));
  logKV('lines', parsed.head.length + '/' + String(text).split(/\r?\n/).length + ' -> ' + balanced.lines.length);
  logKV('body bytes', String(text).length + ' -> ' + newBody.length);
  logKV('verify', v.ok ? 'ok (segments=' + v.segments + ', disc=' + v.discCount + ')' : 'FAILED: ' + v.issues.join('; '));

  if (!v.ok) {
    report.verdict = 'REVERT';
    log('RESULT: REVERT (invariant failed)');
    log('DECISION: PASSTHROUGH');
    report.lines = lines;
    return { changed: false, body: text, report };
  }

  if (cfg.dryRun) {
    report.verdict = 'DRYRUN';
    log('RESULT: DRYRUN (candidates=' + removedCount + ', would remove ' + removedDur.toFixed(1) + 's)');
    log('DECISION: PASSTHROUGH (dryRun)');
    report.lines = lines;
    return { changed: false, body: text, report };
  }

  report.verdict = 'CHANGED';
  log('RESULT: CHANGED (removed ' + removedCount + ' segs / ' + removedDur.toFixed(1) + 's)');
  log('DECISION: CHANGED');
  report.lines = lines;
  return { changed: true, body: newBody, report };
}

/* ======================= 导出 ======================= */
export { filterPlaylist, parseNodes, deriveState, buildChunks, mergeCfg, DEFAULT_RULES, DEFAULTS, namingKey, hostOf };
export default { filterPlaylist, parseNodes, deriveState, buildChunks, mergeCfg, DEFAULT_RULES, DEFAULTS, namingKey, hostOf };