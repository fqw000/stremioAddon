'use strict';

const express = require('express');
const path = require('path');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const logger = require('./lib/logger');
const configLib = require('./lib/config');
const logPage = require('./lib/log-page');
const h5e = require('./lib/h5e-decryptor');
const os = require('os');

// 最近一次客户端请求的 host（用于构造 stream 里的解密代理绝对 URL）。
let lastSeenHost = '';

function withScheme(host) {
  const h = String(host || '').replace(/\/+$/, '');
  if (!h) return '';
  return /^https?:\/\//i.test(h) ? h : `http://${h}`;
}

function getProxyBase() {
  if (process.env.ADDON_HOST) return `${withScheme(process.env.ADDON_HOST)}/h5e`;
  if (lastSeenHost) return `${withScheme(lastSeenHost)}/h5e`;
  let ip = '127.0.0.1';
  for (const addrs of Object.values(os.networkInterfaces())) {
    const found = (addrs || []).find(a => a.family === 'IPv4' && !a.internal);
    if (found) { ip = found.address; break; }
  }
  const port = parseInt(process.env.PORT || '7120', 10);
  return `http://${ip}:${port}/h5e`;
}

const {
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
  FOURK_TYPES
} = require('./lib/cctv');

const skipExtra = { name: 'skip', isRequired: false };

function makeCatalog(id, name, extraOptions) {
  const extra = [];
  if (extraOptions) {
    extra.push({
      name: extraOptions.name,
      isRequired: false,
      options: extraOptions.options,
      optionsLimit: 1
    });
  }
  extra.push(skipExtra);
  return { type: 'series', id, name, extra };
}

const manifest = {
  id: 'org.workbuddy.cctvdoc',
  version: '3.3.0',
  name: '央视片库',
  description: '央视网纪录片、电视剧、动画片、特别节目，以及 4K 专区（电视剧4K/纪录片4K/科教4K，真实 1080P），按剧集分类，提供多档播放源，支持全库搜索。',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  idPrefixes: ['cctv.s.', 'cctv.4k.', 'cctv.e.'],
  behaviorHints: { configurable: true, configurationRequired: false },
  // 非空 config 让 SDK 接受 /<config>/catalog|meta|stream 路径；界面由 /configure 提供
  config: [{ key: 'configure', type: 'text', title: '详细配置请在配置页完成', default: '' }],
  catalogs: [
    makeCatalog('cctv_doc', '央视纪录片', { name: 'genre', options: CATEGORIES.map(c => c.name) }),
    makeCatalog(YXG_TYPES.tv.catalogId, '央视电视剧', { name: YXG_TYPES.tv.extraName, options: YXG_TYPES.tv.extraOptions }),
    makeCatalog(YXG_TYPES.animation.catalogId, '央视动画片', { name: YXG_TYPES.animation.extraName, options: YXG_TYPES.animation.extraOptions }),
    makeCatalog(YXG_TYPES.special.catalogId, '央视特别节目', { name: YXG_TYPES.special.extraName, options: YXG_TYPES.special.extraOptions }),
    ...FOURK_TYPES.map(t => makeCatalog(t.catalogId, t.name)),
    {
      type: 'series',
      id: 'cctv_search',
      name: '央视片库搜索',
      extra: [{ name: 'search', isRequired: true }, skipExtra]
    }
  ]
};

const builder = new addonBuilder(manifest);

// ---------- catalog ----------
async function loadAlbumsForCatalog(catalogId, extra, logId) {
  if (catalogId === 'cctv_search') {
    const kw = extra.search || '';
    if (!kw) return { albums: [], label: 'search(空)' };
    const albums = await searchCatalog(kw);
    logger.info('CATALOG', '步骤 1/3 搜索完成', { logId, keyword: kw, count: albums.length });
    return { albums, label: `search:${kw}` };
  }

  if (catalogId === 'cctv_doc') {
    let category = 'all';
    if (extra.genre) {
      const g = extra.genre;
      const found = CATEGORIES.find(c => c.id === g || c.name === g);
      if (found) category = found.id;
      else logger.warn('CATALOG', '未知 genre，回退 all', { logId, genre: g });
    }
    const albums = await getCatalog(category);
    logger.info('CATALOG', '步骤 1/3 纪录片栏目读取完成', { logId, category, count: albums.length });
    return { albums, label: `纪录片/${category}` };
  }

  const fourKEntry = FOURK_TYPES.find(cfg => cfg.catalogId === catalogId);
  if (fourKEntry) {
    const albums = await get4KCatalog(fourKEntry.id);
    logger.info('CATALOG', '步骤 1/3 4K 专区读取完成', { logId, type: fourKEntry.id, count: albums.length });
    return { albums, label: `4K/${fourKEntry.name}` };
  }

  const yxgEntry = Object.values(YXG_TYPES).find(cfg => cfg.catalogId === catalogId);
  if (yxgEntry) {
    const filter = extra[yxgEntry.extraName] || '全部';
    const albums = await getYxgCatalog(yxgEntry.id, filter, 6);
    logger.info('CATALOG', '步骤 1/3 yxg 栏目读取完成', { logId, type: yxgEntry.id, filter, count: albums.length });
    return { albums, label: `${yxgEntry.name}/${filter}` };
  }

  logger.warn('CATALOG', '未知 catalog id', { logId, catalogId });
  return { albums: [], label: `unknown:${catalogId}` };
}

builder.defineCatalogHandler(async args => {
  const logId = logger.nextId();
  const cfg = configLib.normalize(args.config || null);
  logger.section('CATALOG', `catalog ${args.id}`, {
    logId, catalogId: args.id, extra: args.extra || {}, config: configLib.summary(cfg)
  });

  if (!configLib.isCatalogEnabled(cfg, args.id)) {
    logger.info('CATALOG', '步骤 0/3 该 catalog 已被用户配置关闭，返回空列表', { logId, catalogId: args.id });
    return { metas: [] };
  }

  const extra = args.extra || {};
  const started = Date.now();
  try {
    const { albums, label } = await loadAlbumsForCatalog(args.id, extra, logId);
    const metas = albums.map(al => {
      const match = al.url.match(/(VIDA\w+)\.shtml/);
      const is4K = FOURK_TYPES.some(t => t.catalogId === args.id);
      return {
        id: is4K ? encode4KSeriesId(al.url) : encodeSeriesId(al.url),
        type: 'series',
        name: al.title || (match ? match[1] : '央视节目'),
        poster: al.poster || undefined,
        posterShape: al.poster ? 'poster' : undefined,
        description: al.description || '央视网节目'
      };
    });
    logger.info('CATALOG', '步骤 2/3 生成 Stremio meta 列表', {
      logId, total: metas.length,
      idPrefixes: [...new Set(metas.map(m => m.id.slice(0, 6)))],
      nameSamples: metas.slice(0, 3).map(m => m.name),
      noPoster: metas.filter(m => !m.poster).length
    });

    const ids = metas.map(m => m.id);
    const dupCount = ids.length - new Set(ids).size;
    const PAGE_SIZE = parseInt(process.env.CATALOG_PAGE_SIZE || '100', 10);
    const skip = Math.max(0, parseInt((extra.skip) || '0', 10) || 0);
    const sentMetas = metas.slice(skip, skip + PAGE_SIZE);
    const hasMore = skip + sentMetas.length < metas.length;

    logger.info('CATALOG', '步骤 3/3 分页输出', {
      logId, label, totalCount: metas.length, skip, sentCount: sentMetas.length,
      pageSize: PAGE_SIZE, hasMore, duplicateIds: dupCount,
      durationMs: Date.now() - started
    });
    return { metas: sentMetas };
  } catch (e) {
    logger.error('CATALOG', `catalog ${args.id} 异常`, { logId, message: e.message, stack: e.stack });
    return { metas: [] };
  }
});

// ---------- meta ----------
builder.defineMetaHandler(async args => {
  const logId = logger.nextId();
  const cfg = configLib.normalize(args.config || null);
  logger.section('META', `meta ${args.id}`, { logId, type: args.type, config: configLib.summary(cfg) });

  const is4K = !!decode4KSeriesId(args.id);
  const url = is4K ? decode4KSeriesId(args.id) : decodeSeriesId(args.id);
  if (!url) {
    logger.warn('META', '步骤 1/3 ID 解码失败', { logId, id: args.id });
    return { meta: null };
  }

  const started = Date.now();
  try {
    logger.info('META', '步骤 1/3 ID 解码完成', { logId, is4K, seriesUrl: url });
    const info = is4K
      ? (await get4KAlbumMeta(url)) || { episodes: [] }
      : await getAlbumMeta(url);
    logger.info('META', '步骤 2/3 专辑详情与分集解析完成', {
      logId, title: info.title, episodes: info.episodes.length,
      descLen: (info.description || '').length,
      withThumbnails: info.episodes.filter(e => e.image).length
    });
    const videos = info.episodes.map((ep, i) => ({
      id: encodeVideoId(ep.url, i + 1),
      title: ep.title || `第 ${i + 1} 集`,
      season: 1,
      episode: i + 1,
      released: '',
      ...(ep.image ? { thumbnail: ep.image } : {})
    }));
    const meta = {
      id: args.id,
      type: 'series',
      name: info.title || (is4K ? '央视4K节目' : '央视纪录片'),
      poster: info.poster || undefined,
      posterShape: info.poster ? 'poster' : undefined,
      description: info.description || `共 ${videos.length} 集`,
      releaseInfo: videos.length ? `${videos.length} 集` : '',
      videos,
      links: []
    };
    logger.info('META', '步骤 3/3 输出 meta', {
      logId, name: meta.name, videos: videos.length,
      durationMs: Date.now() - started,
      videoIdSamples: videos.slice(0, 2).map(v => v.id)
    });
    return { meta };
  } catch (e) {
    logger.error('META', 'meta 异常', { logId, message: e.message, stack: e.stack });
    return { meta: null };
  }
});

// ---------- stream ----------
builder.defineStreamHandler(async args => {
  const logId = logger.nextId();
  const cfg = configLib.normalize(args.config || null);
  logger.section('STREAM', `stream ${args.id}`, {
    logId, id: args.id, config: configLib.summary(cfg)
  });

  const started = Date.now();

  // 总开关关闭：addon 不提供 stream，交给本地 provider 接管。
  if (!configLib.isStreamEnabled(cfg)) {
    logger.info('STREAM', 'stream 总开关已关闭，交由本地 provider', { logId, id: args.id });
    return { streams: [] };
  }

  try {
    let episodeUrl, index = null, fallback = false;
    const ep = decodeVideoId(args.id);
    if (ep) {
      episodeUrl = ep.url;
      index = ep.index;
    } else {
      const seriesUrl = decodeSeriesId(args.id);
      if (seriesUrl) {
        logger.warn('STREAM', '步骤 1/4 系列 ID 回退（meta videos=0）', { logId, seriesUrl });
        const meta = await getAlbumMeta(seriesUrl);
        if (meta && meta.episodes && meta.episodes.length) {
          episodeUrl = meta.episodes[0].url;
          index = 1;
          fallback = true;
        } else {
          episodeUrl = seriesUrl;
          index = 0;
          fallback = true;
          logger.warn('STREAM', '步骤 1/4 无分集，作为单集视频处理', { logId, seriesUrl });
        }
      }
    }

    if (!episodeUrl) {
      logger.warn('STREAM', '步骤 1/4 ID 解码失败', { logId, id: args.id });
      return { streams: [] };
    }
    logger.info('STREAM', '步骤 1/4 分集 URL 确定', { logId, episodeUrl, index, fallback });

    let streams = await getStreamsForEpisode(episodeUrl);
    logger.info('STREAM', '步骤 2/4 央视播放接口解析完成', {
      logId, count: streams.length,
      qualities: streams.map(s => s.name),
      sourceCodes: streams.map(s => `${s._source || '?'}:${s._code || '?'}`)
    });

    // 步骤 3/4：画质过滤 + 加密 URL 总开关。
    // encryptedUrl 关闭时 h5e 源整个移除；此时代理开关无意义。
    const rawStreams = streams;
    const beforeFilter = rawStreams.length;
    const cfgSummary = configLib.summary(cfg);
    streams = configLib.filterStreams(rawStreams, cfg);

    // 降级兜底：若勾选的画质档位在源中一个都不存在（例如只勾了 1080P，
    // 但央视该集只有 720P/360P/270P），过滤后为 0 会导致"无法播放"。
    // 此时取源中最高画质的那一档返回，保证有得播。用户若确实想禁用加密源，
    // 应关闭 encryptedUrl 开关，而不是靠不勾 h5e 画质。
    if (beforeFilter > 0 && streams.length === 0 && cfgSummary.encryptedUrl && cfgSummary.qualities.length > 0) {
      const allowed = rawStreams.filter(s => !configLib.isH5eStream(s) || cfgSummary.encryptedUrl);
      if (allowed.length) {
        const topId = configLib.streamQualityId(allowed[0]);
        streams = allowed.filter(s => configLib.streamQualityId(s) === topId);
        logger.warn('STREAM', '步骤 3/4 勾选画质在源中均不存在，已降级到最高可用档位', {
          logId, selectedQualities: cfgSummary.qualities, fallbackQuality: topId,
          fallbackNames: streams.map(s => s.name), count: streams.length,
          reason: '源站该集无勾选档位；返回画质最高的一档避免无法播放'
        });
      }
    }

    logger.info('STREAM', '步骤 3/4 按配置过滤（画质 + 加密 URL 开关）', {
      logId, before: beforeFilter, after: streams.length,
      qualities: cfgSummary.qualities,
      encryptedUrl: cfgSummary.encryptedUrl,
      removedH5e: !cfgSummary.encryptedUrl
    });

    // 步骤 4/4：加密源的 URL 形态。
    // - decryptProxy 开：改写为 addon 的 /h5e/m3u8/ 代理地址（视频字节过 VPS）；
    // - decryptProxy 关：保留原始 asp/h5e/ URL，由电视端原生解密层处理（VPS 零视频字节）。
    const useProxy = configLib.isDecryptProxyEnabled(cfg);
    const proxyBase = getProxyBase();
    streams = streams.map(s => {
      const needsDecrypt = !!(s._needsDecrypt || /\/asp\/(h5e|enc2?)\//.test(s.url));
      if (!needsDecrypt) {
        return {
          url: s.url,
          name: s.name,
          behaviorHints: { notWebReady: false }
        };
      }
      if (useProxy) {
        const proxyUrl = `${proxyBase}/m3u8/${Buffer.from(s.url).toString('base64url')}`;
        logger.info('STREAM', '步骤 4/4 加密源改写为解密代理 URL', {
          logId, originalUrl: s.url, proxyUrl
        });
        return {
          url: proxyUrl,
          name: s.name.replace('网页源·可能花屏', '网页源·已解密'),
          behaviorHints: { notWebReady: false }
        };
      }
      logger.info('STREAM', '步骤 4/4 加密源保留原始 URL（电视端原生解密）', {
        logId, originalUrl: s.url
      });
      return {
        url: s.url,
        name: s.name.replace('网页源·可能花屏', '网页源·加密原址'),
        behaviorHints: { notWebReady: false, h5eEncrypted: true }
      };
    });

    logger.info('STREAM', '输出 streams', {
      logId, count: streams.length, durationMs: Date.now() - started,
      qualities: streams.map(s => s.name),
      fullUrls: streams.map(s => s.url)
    });
    return { streams };
  } catch (e) {
    logger.error('STREAM', 'stream 异常', { logId, message: e.message, stack: e.stack });
    return { streams: [] };
  }
});

// ---------- 响应摘要 ----------
function summarizeResponse(body) {
  if (!body || typeof body !== 'object') return { bodyType: typeof body };
  const out = {};
  if (Array.isArray(body.metas)) {
    out.resource = 'catalog';
    out.metaCount = body.metas.length;
    out.metaIds = body.metas.slice(0, 2).map(m => m.id);
    out.metaNames = body.metas.slice(0, 2).map(m => m.name);
  } else if (body.meta !== undefined) {
    out.resource = 'meta';
    out.metaNull = body.meta === null;
    out.videoCount = body.meta && Array.isArray(body.meta.videos) ? body.meta.videos.length : 0;
  } else if (Array.isArray(body.streams)) {
    out.resource = 'stream';
    out.streamCount = body.streams.length;
    out.streamNames = body.streams.map(s => s.name);
    out.streamUrls = body.streams.map(s => s.url);
  } else if (body.manifest) {
    out.resource = 'manifest';
    out.manifestId = body.manifest.id;
    out.catalogCount = body.manifest.catalogs ? body.manifest.catalogs.length : 0;
  } else {
    out.keys = Object.keys(body);
  }
  return out;
}

function isNoisyLogPath(p) {
  const s = String(p || '');
  return /\/api\/logs(\/|$)/.test(s) || /\/h5e\/ts\//.test(s) || /\.(?:css|js|png|jpg|ico)$/.test(s);
}

function requestLogger(req, res, next) {
  if (!req.__cfg || !req.__cfg.debug || isNoisyLogPath(req.originalUrl)) return next();
  const logId = logger.nextId();
  const started = Date.now();

  logger.section('HTTP', `${req.method} ${req.originalUrl}`, {
    method: req.method,
    path: req.originalUrl,
    fullUrl: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    query: req.query,
    ip: req.ip || req.socket.remoteAddress,
    ua: (req.headers['user-agent'] || '').slice(0, 160),
    config: configLib.summary(req.__cfg)
  });

  const recordResponse = function (body) {
    if (res.__respLogged) return;
    res.__respLogged = true;
    let bytes = 0;
    try { bytes = Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)); } catch (e) { /* ignore */ }
    let parsed = body;
    if (typeof body === 'string') {
      try { parsed = JSON.parse(body); } catch (e) { /* not json */ }
    }
    logger.info('HTTP', `← HTTP ${res.statusCode} ${req.originalUrl}`, {
      status: res.statusCode,
      durationMs: Date.now() - started,
      bytes,
      ...summarizeResponse(parsed)
    });
  };

  const origJson = res.json.bind(res);
  res.json = function (body) { recordResponse(body); return origJson(body); };
  const origSend = res.send.bind(res);
  res.send = function (body) { recordResponse(body); return origSend(body); };
  const origEnd = res.end.bind(res);
  res.end = function (chunk) {
    if (!res.__respLogged && chunk !== undefined) recordResponse(chunk.toString());
    else if (!res.__respLogged) res.__respLogged = true;
    return origEnd(chunk);
  };

  next();
}

// ---------- Express 启动 ----------
const app = express();
app.disable('x-powered-by');

// Stremio 要求 CORS
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// 配置解析：支持 Stremio 标准路径 /<cfg>/...，也兼容 ?cfg=<base64url(JSON)>
app.use((req, res, next) => {
  let cfg;
  if (req.query && req.query.cfg) {
    cfg = configLib.normalize(req.query.cfg);
    try {
      const u = new URL(req.originalUrl, 'http://local');
      u.searchParams.delete('cfg');
      req.url = `/${configLib.encodePathConfig(cfg)}${u.pathname}${u.search || ''}`;
    } catch (e) { /* 保持原路径 */ }
  } else {
    cfg = configLib.fromPath(req.path);
  }
  req.__cfg = cfg;

  const reqId = logger.nextId();
  req.__reqId = reqId;
  const noisy = isNoisyLogPath(req.path);
  logger.run({
    force: !!cfg.debug && !noisy,
    silent: noisy,
    reqId,
    consoleLevel: 20
  }, () => next());
});

app.use(requestLogger);

// ---------- 静态页面 ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
function sendConfigurePage(req, res) {
  res.sendFile(path.join(PUBLIC_DIR, 'configure.html'));
}
app.get('/', sendConfigurePage);
app.get('/configure', sendConfigurePage);
app.get('/configure.html', sendConfigurePage);
// Stremio 点击 addon 的「配置」图标时，会把安装 URL 里的 manifest.json 替换成
// configure，因此已配置的安装会请求 /<encoded-config>/configure。若只注册
// /configure，这类请求会落到 SDK router 并返回 404，配置页打不开。
// 前端 initialCfg() 会从 pathname 第一段读出配置并回填表单。
app.get('/:config/configure', sendConfigurePage);
app.get('/:config/configure.html', sendConfigurePage);

// ---------- 实时日志 ----------
function logsEnabled(req) {
  return !!(req.__cfg && req.__cfg.debug) || logger.isEnabled();
}

function sendLogs(req, res, asHtml) {
  const q = req.query || {};
  if (q.clear === '1') {
    logger.clearLogs();
    return res.json({ ok: true, cleared: true, ...logger.stats() });
  }
  if (q.enable === '1') {
    logger.setEnabled(true);
    logger.info('LOGCTRL', '进程级日志已手动开启');
    if (asHtml) return res.redirect('/api/logs?format=html');
    return res.json({ ok: true, enabled: true, ...logger.stats() });
  }
  if (q.disable === '1') {
    logger.info('LOGCTRL', '进程级日志已手动关闭');
    logger.setEnabled(false);
    if (asHtml) return res.redirect('/api/logs?format=html');
    return res.json({ ok: true, enabled: false, ...logger.stats() });
  }

  if (!logsEnabled(req)) {
    if (asHtml) return res.type('html').send(logPage.OFF_HTML);
    return res.json({
      ok: true,
      debug: false,
      hint: '日志默认关闭。请在配置页勾选实时日志后用生成的链接打开，或访问 /api/logs?enable=1 临时开启。',
      ...logger.stats(),
      logs: []
    });
  }
  if (asHtml) return res.type('html').send(logPage.ON_HTML);
  return res.json({
    ok: true,
    debug: true,
    ...logger.stats(),
    logs: logger.getLogs({
      level: q.level || 'DEBUG',
      limit: q.limit || 400,
      since: q.since || 0,
      q: q.q || ''
    })
  });
}

app.get('/api/logs', (req, res) => sendLogs(req, res, req.query.format === 'html'));
app.get('/:config/api/logs', (req, res) => sendLogs(req, res, req.query.format === 'html'));
app.get('/logs', (req, res) => res.type('html').send(logsEnabled(req) ? logPage.ON_HTML : logPage.OFF_HTML));

// ---------- 动态 manifest（按配置过滤 catalog） ----------
function sendManifest(req, res) {
  res.set('Cache-Control', 'no-cache, max-age=0');
  res.json(configLib.buildManifest(manifest, req.__cfg));
}
app.get('/manifest.json', sendManifest);
app.get('/:config/manifest.json', sendManifest);

// ---------- 在线自检 ----------
app.get('/_diagnostics', async (req, res) => {
  const logId = logger.nextId();
  logger.section('DIAG', '在线自检', { logId, config: configLib.summary(req.__cfg) });
  const report = {
    time: new Date().toISOString(),
    manifest: {
      id: manifest.id,
      version: configLib.buildManifest(manifest, req.__cfg).version,
      types: manifest.types,
      idPrefixes: manifest.idPrefixes,
      catalogs: configLib.buildManifest(manifest, req.__cfg).catalogs.map(c => ({ id: c.id, name: c.name }))
    },
    config: configLib.summary(req.__cfg),
    logs: logger.stats(),
    checks: {}
  };
  try {
    const albums = await getCatalog('all');
    report.checks.catalog = {
      ok: albums.length > 0,
      count: albums.length,
      sampleIds: albums.slice(0, 2).map(a => encodeSeriesId(a.url)),
      sampleNames: albums.slice(0, 2).map(a => a.title)
    };
    let metaCheck = null;
    let tried = 0;
    let lastErr = '';
    for (const al of albums.slice(0, 8)) {
      tried++;
      try {
        const candidate = await getAlbumMeta(al.url);
        if (candidate && candidate.title) { metaCheck = candidate; break; }
      } catch (e) { lastErr = e.message; }
    }
    report.checks.meta = metaCheck ? {
      ok: true, tried, title: metaCheck.title,
      episodes: metaCheck.episodes.length,
      descLen: (metaCheck.description || '').length
    } : { ok: false, tried, lastError: lastErr };

    report.checks.fourk = {};
    for (const cfg of FOURK_TYPES) {
      try {
        const list = await get4KCatalog(cfg.id);
        const entry = { ok: list.length > 0, count: list.length, sample: list[0] && list[0].title };
        if (list[0]) {
          try {
            const m4 = await get4KAlbumMeta(list[0].url);
            entry.metaCheck = m4 ? {
              ok: m4.episodes.length > 0,
              title: m4.title,
              episodes: m4.episodes.length,
              withThumbnails: m4.episodes.filter(e => e.image).length
            } : { ok: false };
          } catch (e) { entry.metaCheck = { ok: false, error: e.message }; }
        }
        report.checks.fourk[cfg.id] = entry;
      } catch (e) {
        report.checks.fourk[cfg.id] = { ok: false, error: e.message };
      }
    }

    report.checks.yxg = {};
    for (const cfg of Object.values(YXG_TYPES)) {
      try {
        const list = await getYxgCatalog(cfg.id, '全部', 1);
        report.checks.yxg[cfg.id] = { ok: list.length > 0, count: list.length, sample: list[0] && list[0].title };
      } catch (e) {
        report.checks.yxg[cfg.id] = { ok: false, error: e.message };
      }
    }

    try {
      const hits = await searchCatalog('海洋', 20);
      report.checks.search = {
        ok: hits.length > 0, keyword: '海洋',
        count: hits.length, samples: hits.slice(0, 3).map(h => h.title)
      };
    } catch (e) {
      report.checks.search = { ok: false, error: e.message };
    }
  } catch (e) {
    report.checks.error = e.message;
  }
  logger.info('DIAG', '自检结果', report.checks);
  res.json(report);
});

// ---------- H5e 解密代理 ----------
function decodeProxyUrl(encoded) {
  try {
    const url = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!/^https?:\/\//.test(url)) return null;
    return url;
  } catch (e) { return null; }
}

function proxyBase(req) {
  const host = req.get('host') || `127.0.0.1:${process.env.PORT || 7120}`;
  return `${withScheme(host)}/h5e`;
}

function encodeProxyUrl(url) {
  return Buffer.from(url).toString('base64url');
}

async function fetchBinary(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  logger.debug('H5EPROXY', '→ 下载加密分片/播放列表', { upstreamUrl: url, timeoutMs });
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36',
        'Referer': 'https://tv.cctv.com/'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    logger.info('H5EPROXY', `← HTTP ${resp.status} ${url}`, {
      upstreamUrl: url, status: resp.status, bytes: buf.length, durationMs: Date.now() - started
    });
    return buf;
  } catch (e) {
    logger.error('H5EPROXY', `← 下载失败 ${url}: ${e.message}`, {
      upstreamUrl: url, error: e.message, durationMs: Date.now() - started
    });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

app.get('/h5e/m3u8/:encoded', async (req, res) => {
  const logId = logger.nextId();
  logger.section('H5EPROXY', 'm3u8 代理改写', { logId, encoded: req.params.encoded.slice(0, 80) });
  const originUrl = decodeProxyUrl(req.params.encoded);
  if (!originUrl) return res.status(400).send('invalid url');
  try {
    const body = (await fetchBinary(originUrl)).toString('utf8');
    const base = originUrl.slice(0, originUrl.lastIndexOf('/') + 1);
    const prefix = proxyBase(req);
    const out = body.split(/\r?\n/).map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const tsUrl = /^https?:\/\//.test(t) ? t : new URL(t, base).href;
      return `${prefix}/ts/${encodeProxyUrl(tsUrl)}`;
    }).join('\n');
    logger.info('H5EPROXY', '步骤 2/2 分片 URL 已改写为本地代理', {
      logId, originUrl, proxyBase: prefix, lines: out.split('\n').length,
      firstTsProxyUrl: out.split('\n').find(l => l.includes('/h5e/ts/')) || ''
    });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'public, max-age=1800');
    res.send(out);
  } catch (e) {
    logger.error('H5EPROXY', 'm3u8 代理失败', { logId, originUrl, error: e.message });
    res.status(502).send('upstream error: ' + e.message);
  }
});

app.get('/h5e/ts/:encoded', async (req, res) => {
  const logId = logger.nextId();
  const originUrl = decodeProxyUrl(req.params.encoded);
  if (!originUrl) return res.status(400).send('invalid url');
  logger.section('H5EPROXY', 'TS 分片解密', { logId, tsUrl: originUrl });
  const started = Date.now();
  try {
    const encrypted = await fetchBinary(originUrl);
    let out;
    let decryptError = '';
    try {
      out = await h5e.decryptSegment(encrypted);
      logger.info('H5EPROXY', '步骤 2/2 wasm 解密成功', {
        logId, inBytes: encrypted.length, outBytes: out.length, durationMs: Date.now() - started
      });
    } catch (de) {
      decryptError = de.message;
      logger.warn('H5EPROXY', '步骤 2/2 解密失败，回退原始分片（老片源可能未加密）', {
        logId, error: de.message, tsUrl: originUrl
      });
      out = encrypted;
    }
    res.set('Content-Type', 'video/mp2t');
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('X-CCTV-Decrypt', decryptError ? 'fallback' : 'ok');
    res.send(out);
  } catch (e) {
    logger.error('H5EPROXY', 'TS 分片代理失败', { logId, tsUrl: originUrl, error: e.message });
    res.status(502).send('upstream error: ' + e.message);
  }
});

// SDK 路由必须最后挂载；带 config 前缀的 catalog/meta/stream 由它解析 args.config
app.use(getRouter(builder.getInterface()));

const port = parseInt(process.env.PORT || '7120', 10);
app.listen(port, () => {
  console.log(`央视片库 addon 已启动: http://127.0.0.1:${port}/manifest.json`);
  console.log(`配置页: http://127.0.0.1:${port}/configure`);
  console.log('运行日志：默认关闭（配置页可开启，或 /api/logs?enable=1 临时开启）');
});
