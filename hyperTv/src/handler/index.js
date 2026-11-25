// 路由分发：manifest / catalog / meta / stream / subtitles / 日志 / 落地页
import { getConfig, getPrefix } from '../config.js';
import {
  corsHeaders,
  decodeDebugData,
  errorResponse,
  escapeHtml,
  htmlResponse,
  jsonResponse,
} from '../helper.js';
import { clearLogs, createLogger, getLogs, logStats, setConsoleLevel } from '../logger.js';
import { webBlockStatus } from '../tmdb-web.js';
import { handleCatalog } from './catalog.js';
import { handleMeta } from './meta.js';
import { handleStream } from './stream.js';
import { handleSubtitle } from './subtitle.js';

export function buildManifest(config, prefix) {
  const types = [];
  const catalogs = [];
  const extra = [
    { name: 'search', isRequired: false },
    { name: 'skip', isRequired: false },
  ];
  if (config.catalogs.live) {
    types.push('channel');
    catalogs.push({ type: 'channel', id: 'htv_live', name: 'HypeTv · 直播', extra });
  }
  if (config.catalogs.vod) {
    types.push('movie');
    catalogs.push({ type: 'movie', id: 'htv_movie', name: 'HypeTv · 电影', extra });
  }
  if (config.catalogs.series) {
    types.push('series');
    catalogs.push({ type: 'series', id: 'htv_series', name: 'HypeTv · 剧集', extra });
  }
  const finalTypes = types.length ? types : ['movie'];

  const subtitleTypes = finalTypes.filter((t) => t !== 'channel');
  const resources = [
    { name: 'catalog', types: finalTypes },
    // 'tt' 让 Stremio 把其他 addon 的 IMDb ID 请求也路由到本插件
    { name: 'meta', types: finalTypes, idPrefixes: [prefix, 'tt'] },
    { name: 'stream', types: finalTypes, idPrefixes: [prefix, 'tt'] },
  ];
  if (subtitleTypes.length) {
    resources.push({ name: 'subtitles', types: subtitleTypes, idPrefixes: [prefix, 'tt'] });
  }

  return {
    id: 'org.hypetv.stremio',
    version: '1.0.2',
    name: 'HypeTv',
    description: '基于 HypeTv / Xtream / M3U 的直播、电影与剧集 Stremio 插件',
    resources,
    types: finalTypes,
    // 部分客户端（nuvio 等）只读取顶层 idPrefixes 来决定是否发起请求
    idPrefixes: Array.from(new Set([prefix, 'tt'])),
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

function parseExtraRaw(raw) {
  const out = {};
  if (!raw) return out;
  let text = String(raw);
  // 兼容 extra=<json> / extra=<k=v> 前缀（部分客户端把整段包在 extra= 里）
  const wrapped = /^extra=(.*)$/is.exec(text);
  if (wrapped) text = wrapped[1];
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 兼容 search=xxx&skip=100 形式
  }
  for (const part of text.split('&')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const k = part.slice(0, at);
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(at + 1));
    } catch {
      out[k] = part.slice(at + 1);
    }
  }
  return out;
}

// 官方协议把 extra 放在路径里：/catalog/{type}/{id}/search=xxx&skip=100.json
// 同时兼容早期 ?extra= 形式，路径参数优先
function parseExtra(url, segment = '') {
  return { ...parseExtraRaw(url.searchParams.get('extra')), ...parseExtraRaw(segment) };
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 日志里展示的请求路径：屏蔽 cfg / key / password / u 等敏感参数
function safePath(url) {
  const parts = [];
  for (const [k, v] of url.searchParams) {
    if (/^(cfg|api_key|apikey|password|pass|token|auth|secret|key|u)$/i.test(k)) parts.push(`${k}=***`);
    else parts.push(`${k}=${String(v).slice(0, 80)}`);
  }
  return url.pathname + (parts.length ? `?${parts.join('&')}` : '');
}

const LANDING = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HypeTv Stremio Addon</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:60px auto;padding:0 20px;color:#1f2937;line-height:1.7}a{color:#2563eb}.card{border:1px solid #e5e7eb;border-radius:12px;padding:24px;box-shadow:0 2px 10px rgba(0,0,0,.04)}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head><body><div class="card"><h1>HypeTv Stremio Addon</h1><p>将 HypeTv 内置片库、自有 Xtream 账号或 M3U 列表接入 Stremio。</p><p><a href="/configure">打开配置页 →</a> · <a href="/api/logs?format=html">查看运行日志 →</a></p><p>接口：<code>/manifest.json</code>、<code>/catalog/{type}/{id}.json</code>、<code>/meta/{type}/{id}.json</code>、<code>/stream/{type}/{id}.json</code>、<code>/subtitles/{type}/{id}.json</code></p></div></body></html>`;

// 诊断页：所有信息已编码在 URL 中，用户复制链接即可交给开发者排查
function renderDiagnose(data, href) {
  const rows = Object.entries(data)
    .filter(([k]) => !['d', 'raw'].includes(k))
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td><pre>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre></td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HypeTv 诊断信息</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#1f2937;line-height:1.6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:top;font-size:13px}th{width:150px;background:#f9fafb}pre{margin:0;white-space:pre-wrap;word-break:break-word}button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;font-size:14px}.url{background:#f3f4f6;padding:10px;border-radius:8px;word-break:break-all;font-size:12px}</style></head><body><h1>HypeTv 诊断信息</h1><p class="hint">此链接仅在配置页开启「开发调试模式」时由插件生成，包含排查所需的全部上下文（不含账号密码）。</p><button id="copy">复制诊断链接</button><div class="url" id="link">${escapeHtml(href)}</div><table>${rows}</table></body><script>document.getElementById('copy').onclick=async function(){await navigator.clipboard.writeText(location.href);this.textContent='已复制';setTimeout(()=>this.textContent='复制诊断链接',1500)}</script></html>`;
}

const LOGS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HypeTv 运行日志</title><style>
:root{color-scheme:light}body{margin:0;background:#0f172a;color:#e2e8f0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#1e293b;padding:12px 16px;border-bottom:1px solid #334155;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0 8px 0 0;color:#f8fafc}select,input[type=text],button{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:5px 8px;font:inherit}
button{cursor:pointer}label{display:flex;gap:5px;align-items:center;color:#94a3b8}#stat{color:#94a3b8;margin-left:auto;font-size:11px}
#list{padding:10px 16px}.row{white-space:pre-wrap;word-break:break-all;padding:1px 0;border-bottom:1px solid rgba(148,163,184,.08)}
.lv-debug{color:#94a3b8}.lv-info{color:#e2e8f0}.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.tag{color:#38bdf8}.hint{color:#94a3b8;font-size:11px;padding:8px 16px 0}
</style></head><body><header><h1>HypeTv 运行日志</h1>
<select id="level"><option value="debug">DEBUG+</option><option value="info" selected>INFO+</option><option value="warn">WARN+</option><option value="error">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：subtitle / tt5034838 / 403" size="26">
<label><input type="checkbox" id="auto" checked> 自动刷新</label>
<button id="clear">清空</button><button id="now">立即刷新</button><span id="stat"></span></header>
<p class="hint">每个请求的进出看 <span class="tag">http</span>；字幕是否被执行、ID 解析与上游结果看 <span class="tag">subtitle</span>。配置页勾选「开发调试模式」或选择日志级别 DEBUG 后，终端也会输出完整链路。</p>
<div id="list"></div><script>
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
function refresh(){
  var p=new URLSearchParams({level:$('level').value,q:$('q').value,limit:'400'});
  fetch('/api/logs?'+p.toString()).then(function(r){return r.json()}).then(function(d){
    $('stat').textContent='累计 '+d.total+' 条 / 缓冲 '+d.buffered+' 条 / 控制台 '+d.consoleLevel;
    var out='';
    for(var i=0;i<d.logs.length;i++){var e=d.logs[i];
      var rid=(e.ctx&&e.ctx.reqId)?'('+e.ctx.reqId+') ':'';
      out+='<div class="row lv-'+esc(e.level)+'">['+esc(e.ts.slice(11,23))+'] ['+esc(e.level.toUpperCase())+'] ['+esc(e.tag)+'] '+esc(rid)+esc(e.msg)+'</div>';
    }
    $('list').innerHTML=out;
    window.scrollTo(0,document.body.scrollHeight);
  });
}
$('now').onclick=refresh;
$('clear').onclick=function(){fetch('/api/logs?clear=1').then(refresh)};
$('level').onchange=refresh;$('q').oninput=refresh;
setInterval(function(){if($('auto').checked)refresh()},3000);
refresh();
</script></body></html>`;

function logsResponse(url) {
  if (url.searchParams.get('clear') === '1') {
    clearLogs();
    return jsonResponse({ ok: true, cleared: true, ...logStats() });
  }
  if (url.searchParams.get('format') === 'html') return htmlResponse(LOGS_HTML);
  const level = url.searchParams.get('level') || 'debug';
  const limit = Number(url.searchParams.get('limit')) || 200;
  const since = Number(url.searchParams.get('since')) || 0;
  const q = url.searchParams.get('q') || '';
  return jsonResponse({ ok: true, ...logStats(), logs: getLogs({ level, limit, since, q }) });
}

async function dispatch(request, meta) {
  const url = new URL(request.url);
  const config = meta.config || getConfig(url);
  const prefix = getPrefix(config);
  const path = url.pathname;
  const L = meta.log;

  if (path === '/' || path === '') {
    meta.resource = 'landing';
    return htmlResponse(LANDING);
  }
  if (path === '/manifest.json') {
    meta.resource = 'manifest';
    const manifest = buildManifest(config, prefix);
    meta.summary = `resources=${manifest.resources.length} types=${manifest.types.join('/')}`;
    L.debug('manifest', `types=${manifest.types.join('/')} subtitles=${manifest.resources.some((r) => r.name === 'subtitles')} prefix=${prefix}`);
    return jsonResponse(manifest, { cacheMaxAge: 300 });
  }
  if (path === '/health') {
    meta.resource = 'health';
    return jsonResponse({
      ok: true,
      prefix,
      source: config.source.type,
      catalogs: config.catalogs,
      logs: logStats(),
      tmdbWeb: webBlockStatus(),
    });
  }
  // 运行日志级别：允许通过 ?logLevel= 临时调整服务端控制台输出（便于不改环境变量排查）
  const requestedLevel = url.searchParams.get('logLevel');
  if (requestedLevel) {
    setConsoleLevel(requestedLevel);
    L.info('logs', `控制台日志级别已设为 ${requestedLevel.toUpperCase()}`);
  }
  if (path === '/api/logs') {
    meta.resource = 'logs';
    L.debug('logs', `查看运行日志 level=${url.searchParams.get('level') || 'debug'}`);
    return logsResponse(url);
  }

  // 诊断页：数据完全来自 URL 编码，便于用户一键复制并反馈
  if (path === '/api/diagnose') {
    meta.resource = 'diagnose';
    const data = decodeDebugData(url.searchParams.get('d'));
    if (!data || typeof data !== 'object') return errorResponse('invalid diagnostic data', 400);
    L.debug('diagnose', `type=${data.type} id=${data.id} title=${data.title}`);
    return htmlResponse(renderDiagnose(data, request.url));
  }

  // 字幕代理：服务端用 curl UA 转发，规避客户端 UA / 防盗链导致的 403
  if (path === '/api/subtitle') {
    meta.resource = 'subtitle-proxy';
    const target = url.searchParams.get('u');
    if (!target || !/^https?:\/\//i.test(target)) return errorResponse('invalid u', 400);
    try {
      const r = await fetch(target, {
        headers: { 'user-agent': 'curl/8.7.1', accept: '*/*', range: url.searchParams.get('range') || '' },
        signal: AbortSignal.timeout(12000),
      });
      const body = await r.arrayBuffer();
      const ct = (r.headers.get('content-type') || '').split(';')[0] || 'application/x-subrip';
      meta.summary = `upstream=${r.status} bytes=${body.byteLength}`;
      L.debug('subtitle-proxy', `上游 HTTP ${r.status}, ${body.byteLength} bytes`);
      if (!r.ok) L.warn('subtitle-proxy', `字幕下载失败 HTTP ${r.status}`);
      return new Response(body, {
        status: r.ok ? 200 : r.status,
        headers: corsHeaders({
          'content-type': `${ct}; charset=utf-8`,
          'cache-control': 'public, max-age=86400',
        }),
      });
    } catch (e) {
      L.warn('subtitle-proxy', `转发失败: ${e.message}`);
      return errorResponse(`proxy failed: ${e.message}`, 502);
    }
  }

  let m = /^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(path);
  if (m) {
    meta.resource = 'catalog';
    const result = await handleCatalog({
      type: decodePart(m[1]),
      catalogId: decodePart(m[2]),
      extra: parseExtra(url, m[3] ? decodePart(m[3]) : ''),
      config,
      prefix,
      logger: L,
    });
    meta.summary = `metas=${result.metas?.length ?? 0}`;
    return jsonResponse(result, {
      cacheMaxAge: result.cacheMaxAge ?? 300,
      staleRevalidate: result.staleRevalidate ?? 600,
      staleError: result.staleError ?? 300,
    });
  }

  // meta / stream / subtitles 都可能带官方协议的 extra 路径段，忽略或透传，不能误当成 ID
  m = /^\/meta\/([^/]+)\/([^/]+?)(?:\/[^/]+)?\.json$/.exec(path);
  if (m) {
    meta.resource = 'meta';
    L.debug('meta', `请求 type=${decodePart(m[1])} id=${decodePart(m[2])}`);
    const result = await handleMeta({ type: decodePart(m[1]), id: decodePart(m[2]), config, prefix, logger: L });
    meta.summary = `meta=${result.meta ? 'yes' : 'null'}`;
    return jsonResponse(result, {
      cacheMaxAge: result.cacheMaxAge ?? 300,
      staleRevalidate: 600,
      staleError: 300,
    });
  }

  m = /^\/stream\/([^/]+)\/([^/]+?)(?:\/[^/]+)?\.json$/.exec(path);
  if (m) {
    meta.resource = 'stream';
    L.debug('stream', `请求 type=${decodePart(m[1])} id=${decodePart(m[2])}`);
    const result = await handleStream({
      type: decodePart(m[1]),
      id: decodePart(m[2]),
      config,
      prefix,
      addonBase: url.origin,
      logger: L,
    });
    meta.summary = `streams=${result.streams?.length ?? 0}`;
    return jsonResponse(result, { cacheMaxAge: result.cacheMaxAge ?? 180, staleError: 60 });
  }

  m = /^\/subtitles\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(path);
  if (m) {
    meta.resource = 'subtitles';
    const result = await handleSubtitle({
      type: decodePart(m[1]),
      id: decodePart(m[2]),
      extra: parseExtra(url, m[3] ? decodePart(m[3]) : ''),
      config,
      prefix,
      addonBase: url.origin,
      logger: L,
    });
    meta.summary = `subtitles=${result.subtitles?.length ?? 0}`;
    return jsonResponse(result, { cacheMaxAge: result.cacheMaxAge ?? 3600 });
  }

  // 便捷搜索路由（官方搜索通过 catalog extra.search 完成，这里提供等价入口）
  m = /^\/search\/(.+)\.json$/.exec(path);
  if (m) {
    meta.resource = 'search';
    const type = ['movie', 'series', 'channel'].includes(url.searchParams.get('type'))
      ? url.searchParams.get('type')
      : 'movie';
    const result = await handleCatalog({
      type,
      catalogId: `htv_${type === 'channel' ? 'live' : type}`,
      extra: { search: decodePart(m[1]) },
      config,
      prefix,
      logger: L,
    });
    meta.summary = `metas=${result.metas?.length ?? 0}`;
    return jsonResponse(result, { cacheMaxAge: result.cacheMaxAge ?? 300 });
  }

  meta.resource = '404';
  L.warn('http', `未匹配的路由: ${safePath(url)}`);
  return errorResponse('Not found', 404);
}

export async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const started = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  const meta = { reqId, started, resource: 'unknown', summary: '', force: false };
  let shown = request.url;
  let isLogs = false;
  try {
    const u = new URL(request.url);
    shown = safePath(u);
    isLogs = u.pathname === '/api/logs';
    meta.config = getConfig(u);
    meta.force = !!(meta.config.debug || meta.config.logLevel === 'debug');
  } catch {
    // URL 异常时仍走 dispatch，由它自己报错
  }

  const L = createLogger({ reqId, force: meta.force });
  meta.log = L;
  // 日志页自身的轮询不计入 INFO，避免每 3 秒刷一条
  if (isLogs) L.debug('http', `→ ${request.method} ${shown}`);
  else L.info('http', `→ ${request.method} ${shown}`);
  if (meta.config) {
    L.debug('config', `source=${meta.config.source.type} lang=${meta.config.language} subtitleLang=${meta.config.subtitleLang} subtitleProxy=${meta.config.subtitleProxy} debug=${meta.config.debug} logLevel=${meta.config.logLevel || 'default'}`);
  }

  let response;
  try {
    response = await dispatch(request, meta);
  } catch (e) {
    L.error('handler', `unexpected error: ${e?.stack || e?.message}`);
    response = errorResponse(`Internal error: ${e?.message || 'unknown'}`, 500);
  }
  L.info('http', `← ${response.status} ${meta.resource} ${meta.summary} ${Date.now() - started}ms`);
  return response;
}
