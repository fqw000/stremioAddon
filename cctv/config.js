'use strict';

const { YXG_TYPES, FOURK_TYPES } = require('./cctv');

// 配置以 Stremio 标准形式写在 URL 路径里：
//   http://host:7120/<encodeURIComponent(JSON.stringify(cfg))>/manifest.json
// 同时兼容 hyperTV 风格的 ?cfg=<base64url(JSON)>，便于复用健康检查脚本。

const CATALOG_DEFS = [
  { id: 'cctv_doc', name: '央视纪录片', group: '纪录片' },
  { id: YXG_TYPES.tv.catalogId, name: '央视电视剧', group: '电视剧' },
  { id: YXG_TYPES.animation.catalogId, name: '央视动画片', group: '动画片' },
  { id: YXG_TYPES.special.catalogId, name: '央视特别节目', group: '特别节目' },
  ...FOURK_TYPES.map(t => ({ id: t.catalogId, name: t.name, group: '4K 专区' })),
  { id: 'cctv_search', name: '央视片库搜索', group: '搜索' }
];

// 画质分组按「真实分辨率」而不是央视标称码率划分。
// stable_270 包含 2000/1200/450，实测均为 480x270；不要被档位号误导。
const QUALITY_DEFS = [
  {
    id: 'stable_1080', source: 'stable', name: '稳定源 · 真 1080P [4000]',
    hint: '4K 专区常见；直连，兼容性最好'
  },
  {
    id: 'stable_360', source: 'stable', name: '稳定源 · 标清 640x360 [850]',
    hint: '直连，普通节目最稳的较高档'
  },
  {
    id: 'stable_270', source: 'stable', name: '稳定源 · 流畅 480x270 [2000/1200/450]',
    hint: '档位号是标称码率，实测分辨率相同'
  },
  {
    id: 'h5e_1080', source: 'h5e', name: '网页源 · 真 1080P（已解密）',
    hint: '经本地解密代理，画质最高'
  },
  {
    id: 'h5e_720', source: 'h5e', name: '网页源 · 真 720P（已解密）',
    hint: '经本地解密代理，推荐家庭电视'
  },
  {
    id: 'h5e_sd', source: 'h5e', name: '网页源 · 480P 及以下（已解密）',
    hint: '经本地解密代理；低码率备用'
  }
];

const DEFAULT_CATALOG_IDS = CATALOG_DEFS.map(c => c.id);
const DEFAULT_QUALITY_IDS = QUALITY_DEFS.map(q => q.id);

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  let s = String(value).trim();
  // Stremio 路径配置是 encodeURIComponent(JSON)
  if (s.charAt(0) === '%') {
    try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
  }
  // ?cfg= 可能传 base64url(JSON)
  if (!/^[\[{]/.test(s)) {
    try {
      let t = s.replace(/-/g, '+').replace(/_/g, '/');
      t += '='.repeat((4 - (t.length % 4)) % 4);
      s = Buffer.from(t, 'base64').toString('utf8');
    } catch (e) { /* ignore */ }
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function pickFlags(selected, defaults) {
  const out = {};
  const rawObject = selected && typeof selected === 'object' && !Array.isArray(selected) ? selected : null;
  const rawArray = Array.isArray(selected) ? selected : null;
  for (const id of defaults) {
    if (rawArray) out[id] = rawArray.includes(id);
    else if (rawObject && Object.prototype.hasOwnProperty.call(rawObject, id)) out[id] = rawObject[id] !== false;
    else out[id] = true;
  }
  return out;
}

function normalize(raw) {
  const cfg = parseMaybeJson(raw) || {};
  const catalogs = pickFlags(cfg.catalogs || cfg.catalogIds, DEFAULT_CATALOG_IDS);
  const qualities = pickFlags(cfg.qualities || cfg.qualityIds, DEFAULT_QUALITY_IDS);
  // stream 总开关：关闭后 addon 不再返回任何 stream，交给本地 provider 接管。
  // 解密代理开关：关闭后 h5e 源不改写为 /h5e/ 代理 URL，供本地 provider / 播放器处理。
  const streamEnabled = cfg.streamEnabled !== false && cfg.stream !== false;
  const decryptProxy = cfg.decryptProxy !== false && cfg.decryptProxyEnabled !== false;
  return {
    version: 3,
    catalogs,
    qualities,
    streamEnabled,
    decryptProxy,
    debug: cfg.debug === true
  };
}

function fromPath(pathname) {
  const m = String(pathname || '').match(/^\/([^/]+)\//);
  if (!m) return normalize(null);
  const cfg = parseMaybeJson(m[1]);
  return cfg ? normalize(cfg) : normalize(null);
}

function fromRequest(req) {
  if (req && req.__cfg) return req.__cfg;
  if (req && req.query && req.query.cfg) return normalize(req.query.cfg);
  return fromPath(req && req.path);
}

function encodePathConfig(cfg) {
  return encodeURIComponent(JSON.stringify(normalize(cfg)));
}

function enabledCatalogIds(cfg) {
  const c = normalize(cfg);
  return DEFAULT_CATALOG_IDS.filter(id => c.catalogs[id]);
}

function isCatalogEnabled(cfg, id) {
  const c = normalize(cfg);
  return c.catalogs[id] !== false;
}

function heightFromName(name) {
  const s = String(name || '');
  let m = s.match(/(\d{3,4})[pP]\b/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d{3,4})x(\d{3,4})/i);
  if (m) return parseInt(m[2], 10);
  return 0;
}

function streamQualityId(stream) {
  const code = String(
    stream && (stream._code || (String(stream.url || '').match(/\/hls\/(\d+)\//) || [])[1]) || ''
  );
  const url = String((stream && stream.url) || '');
  const isH5e = isH5eStream(stream);
  if (isH5e) {
    const h = stream && stream._height ? stream._height : heightFromName(stream && stream.name);
    if (h >= 1080) return 'h5e_1080';
    if (h >= 720) return 'h5e_720';
    return 'h5e_sd';
  }
  if (code === '4000') return 'stable_1080';
  if (code === '850') return 'stable_360';
  return 'stable_270';
}

function isStreamEnabled(cfg) {
  return normalize(cfg).streamEnabled !== false;
}

function isDecryptProxyEnabled(cfg) {
  return normalize(cfg).decryptProxy !== false;
}

function filterStreams(streams, cfg) {
  if (!cfg) return streams || [];
  const c = normalize(cfg);
  if (!c.streamEnabled) return [];
  return (streams || []).filter(s => c.qualities[streamQualityId(s)] !== false);
}

// 解密代理关闭时，h5e 源以原始 URL 形式返回（不经过 VPS 代理），
// 由本地 provider / 播放器原生解密层处理。
function rawDecryptStreams(streams, cfg) {
  if (isDecryptProxyEnabled(cfg)) return streams || [];
  return (streams || []).filter(s => !isH5eStream(s));
}

function isH5eStream(stream) {
  const url = String((stream && stream.url) || '');
  return !!(stream && (
    stream._needsDecrypt ||
    /\/asp\/(h5e|enc2?)\//.test(url) ||
    /\/h5e\/(m3u8|ts)\//.test(url) ||
    /网页源/.test(String(stream.name || ''))
  ));
}

function buildManifest(baseManifest, cfg) {
  const out = JSON.parse(JSON.stringify(baseManifest));
  const c = normalize(cfg);
  out.version = '3.5.0';
  out.catalogs = (out.catalogs || []).filter(cat => c.catalogs[cat.id] !== false);
  // stream 总开关关闭时，manifest 不再声明 stream 资源，Stremio 不会向 addon 请求 stream
  if (!c.streamEnabled) {
    out.resources = (out.resources || []).filter(r => r !== 'stream');
  }
  out.behaviorHints = {
    ...(out.behaviorHints || {}),
    configurable: true,
    configurationRequired: false
  };
  // 让 Stremio 显示 Configure 按钮；真正的配置界面由 /configure 提供
  out.config = [
    { key: 'configure', type: 'text', title: '详细配置请在配置页完成', default: '' }
  ];
  out.description = `${out.description}（已按用户配置过滤：${out.catalogs.length} 个 catalog）`;
  return out;
}

function summary(cfg) {
  const c = normalize(cfg);
  return {
    catalogs: enabledCatalogIds(c),
    qualities: DEFAULT_QUALITY_IDS.filter(id => c.qualities[id]),
    streamEnabled: c.streamEnabled,
    decryptProxy: c.decryptProxy,
    debug: c.debug
  };
}

module.exports = {
  CATALOG_DEFS,
  QUALITY_DEFS,
  DEFAULT_CATALOG_IDS,
  DEFAULT_QUALITY_IDS,
  normalize,
  parseMaybeJson,
  fromPath,
  fromRequest,
  encodePathConfig,
  enabledCatalogIds,
  isCatalogEnabled,
  streamQualityId,
  filterStreams,
  isStreamEnabled,
  isDecryptProxyEnabled,
  isH5eStream,
  rawDecryptStreams,
  buildManifest,
  summary
};
