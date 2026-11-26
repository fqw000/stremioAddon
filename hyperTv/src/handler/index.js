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
import { clearLogs, createLogger, getLogs, logStats, NOOP_LOGGER } from '../logger.js';
import { loggedFetch } from '../http-log.js';
import { webBlockStatus } from '../tmdb-web.js';
import { handleCatalog } from './catalog.js';
import { handleMeta } from './meta.js';
import { handleStream } from './stream.js';
import { handleSubtitle, needsSubtitleProxy } from './subtitle.js';

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
    // 变更 resources / 路由 / 字幕行为时必须升版本，否则客户端会一直用缓存的旧 manifest
    version: '1.0.6',
    name: 'HypeTv',
    author: 'wangqifei.eu.org',
    description: '[audio: 葡萄牙语 ] [sub: 中英文]基于 HypeTv / Xtream / M3U 的直播、电影与剧集 Stremio 插件, 提供字幕 和 mp4 文件支持。 ',
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
// 但部分客户端（含一些 Web / TV 壳）会直接发 ?search=xxx&skip=100 —— 旧版完全忽略，
// 导致中文搜索「没反应」（实际返回了整页目录）。这里做三路兼容：直接 query < ?extra= < 路径段
const DIRECT_EXTRA_KEYS = [
  'search', 'skip', 'genre', 'filename', 'videoHash', 'videoSize', 'season', 'episode',
];
function parseExtra(url, segment = '') {
  const direct = {};
  for (const k of DIRECT_EXTRA_KEYS) {
    const v = url.searchParams.get(k);
    if (v != null && v !== '') direct[k] = v;
  }
  return {
    ...direct,
    ...parseExtraRaw(url.searchParams.get('extra')),
    ...parseExtraRaw(segment),
  };
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 路径段解码后展示，日志里能直接看到 search=黑客帝国 而不是 %E9%BB%91...
function readablePath(url) {
  return url.pathname
    .split('/')
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    })
    .join('/');
}

// 日志里展示的请求路径：屏蔽 cfg / key / password / u 等敏感参数
function safePath(url) {
  const parts = [];
  for (const [k, v] of url.searchParams) {
    if (/^(cfg|api_key|apikey|password|pass|token|auth|secret|key|u)$/i.test(k)) parts.push(`${k}=***`);
    else parts.push(`${k}=${String(v).slice(0, 80)}`);
  }
  return readablePath(url) + (parts.length ? `?${parts.join('&')}` : '');
}

// 结构化请求参数（脱敏），放进日志 ctx，供日志页「显示详情」查看
function requestParams(url) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    out[k] = /^(cfg|api_key|apikey|password|pass|token|auth|secret|key|u)$/i.test(k)
      ? '***'
      : String(v).slice(0, 160);
  }
  return out;
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
// 未开启调试模式时的日志页：明确告知如何打开，而不是给一个空白列表
const LOGS_OFF_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HypeTv 运行日志</title><style>
body{margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:640px;margin:72px auto;padding:28px 30px;background:#1e293b;border:1px solid #334155;border-radius:14px}
h1{font-size:18px;margin:0 0 10px;color:#f8fafc}code{background:#0f172a;border:1px solid #334155;border-radius:4px;padding:1px 6px;font-size:12px;color:#7dd3fc}
a{color:#38bdf8}ol{color:#cbd5e1;padding-left:20px}li{margin:6px 0}.muted{color:#94a3b8;font-size:13px}
</style></head><body><div class="card"><h1>调试模式未开启</h1>
<p class="muted">为降低开销，插件默认<b>不记录任何运行日志</b>。只有安装链接中开启了「开发调试模式」的请求才会写入日志缓冲。</p>
<ol>
<li>打开 <a href="/configure">配置页</a>，在「元数据与字幕」里勾选 <b>开发调试模式（debug）</b>；</li>
<li>点击「生成安装链接」，在下方点 <b>打开运行日志</b>（链接会带上 <code>?cfg=</code>）；</li>
<li>在客户端里点一次播放，回到日志页即可看到这次请求的完整链路。</li>
</ol>
<p class="muted">已经装了 debug 版？直接从配置页生成的日志链接进入，或手动访问 <code>/api/logs?format=html&amp;cfg=&lt;你的配置&gt;</code>。</p>
</div></body></html>`;

const LOGS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HypeTv 运行日志</title><style>
:root{color-scheme:dark}
body{margin:0;background:#0b1220;color:#cbd5e1;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#111a2e;padding:10px 16px;border-bottom:1px solid #24324d;display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:3}
h1{font-size:14px;margin:0 10px 0 0;color:#f1f5f9;font-weight:600;letter-spacing:.3px}
select,input[type=text],button{background:#0b1220;color:#dbeafe;border:1px solid #33456b;border-radius:6px;padding:4px 8px;font:inherit}
button{cursor:pointer}button:hover{border-color:#4f6a99}button.on{border-color:#38bdf8;color:#7dd3fc}
label{display:flex;gap:5px;align-items:center;color:#94a3b8}
#stat{color:#7c8db0;margin-left:auto;font-size:11px}
#cfgbar{padding:6px 16px;background:#0e1729;border-bottom:1px solid #1c2740;color:#7dd3fc;font-size:11px;word-break:break-all}
#list{padding:8px 0 40px}
.sec{display:flex;gap:10px;align-items:baseline;margin:14px 0 6px;padding:6px 16px;background:linear-gradient(90deg,#1b2540,#0b1220 70%);border-left:3px solid #a78bfa}
.sec .badge{font-size:10px;color:#0b1220;background:#a78bfa;border-radius:3px;padding:0 5px;font-weight:700;letter-spacing:.5px}
.sec .title{color:#e9d5ff;font-weight:600;font-size:12.5px;word-break:break-all}
.sec .meta{color:#8b9ec2;font-size:11px;word-break:break-all}
.row{padding:2px 16px 2px 22px;white-space:pre-wrap;word-break:break-word;border-left:3px solid transparent}
.row:hover{background:#0e1729}
.t{color:#5b6d8f}.lv{display:inline-block;min-width:52px;font-weight:700}
.lv-debug{color:#64748b}.lv-info{color:#7dd3fc}.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.rid{color:#0b1220;background:#334155;border-radius:3px;padding:0 4px;margin-right:6px;font-size:10.5px}
.tag{display:inline-block;min-width:74px;margin-right:6px;font-weight:600}
.t-http{color:#60a5fa}.t-sub{color:#f0abfc}.t-up{color:#22d3ee}.t-tmdb{color:#2dd4bf}.t-cat{color:#4ade80}.t-dim{color:#94a3b8}
.msg{color:#dbe3f0}
.st-ok{color:#4ade80}.st-info{color:#22d3ee}.st-warn{color:#fbbf24}.st-bad{color:#f87171}
.url{color:#93c5fd;text-decoration:underline dotted}.ms{color:#a5b4fc}
.ctx{color:#7c8db0;padding:1px 0 4px 14px;font-size:11px;white-space:pre-wrap}
.ctx b{color:#94a3b8;font-weight:600}
.hint{color:#7c8db0;font-size:11px;padding:6px 16px;margin:0}
.hint a{color:#38bdf8}
button.off{border-color:#f59e0b;color:#fbbf24}
</style></head><body>
<header><h1>HypeTv 运行日志</h1>
<select id="level"><option value="debug" selected>DEBUG+（全链路）</option><option value="info">INFO+</option><option value="warn">WARN+</option><option value="error">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：字幕 / 黑客帝国 / 403" size="22">
<button id="fsub">只看字幕</button>
<label><input type="checkbox" id="detail"> 显示详情</label>
<label><input type="checkbox" id="follow" checked> 自动滚动</label>
<button id="pause">暂停接收</button><button id="clear">清空</button><button id="now">立即刷新</button>
<span id="stat"></span></header>
<div id="cfgbar">配置：读取中…</div>
<p class="hint">时间 UTC+8。日志页轮询本身不写日志，按序号增量追加，不会把业务日志刷掉；勾选「显示详情」可展开每个请求的路径 / 参数 / 状态 / 字节 / 耗时与上游接口完整 URL。只有配置了 <b>debug</b> 的请求才会被记录。</p>
<div id="list"></div><script>
var $=function(id){return document.getElementById(id)};
var CFG=new URLSearchParams(location.search).get('cfg')||'';
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
var lastSeq=0,paused=false;
function api(p){p=p||new URLSearchParams();if(CFG)p.set('cfg',CFG);return '/api/logs?'+p.toString()}
function bj(ts){return new Date(new Date(ts).getTime()+8*3600000).toISOString().slice(11,23)}
function readCfg(){try{var s=CFG.replace(/-/g,'+').replace(/_/g,'/');s+='='.repeat((4-s.length%4)%4);var bin=atob(s),arr=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return JSON.parse(new TextDecoder().decode(arr))}catch(e){return null}}
function cfgBar(){var c=readCfg();if(!c){$('cfgbar').textContent='配置：未随链接传入（部分链路由客户端生成，属正常）';return}
var s=c.source||{};var parts=['source='+(s.type||'hypetv')];
if(s.listId)parts.push('list='+s.listId);parts.push('lang='+(c.language||'zh-CN'));parts.push('subtitleLang='+(c.subtitleLang||'both'));
parts.push('catalogs='+['live','vod','series'].filter(function(k){return c.catalogs&&c.catalogs[k]}).join('/'));
parts.push('debug='+(c.debug?'on':'off'));$('cfgbar').textContent='配置：'+parts.join(' · ')}
function ctxText(c){
  var keys=['path','method','params','config','status','resource','summary','bytes','elapsed','contentType','error'],parts=[];
  for(var i=0;i<keys.length;i++){var k=keys[i],v=c[k];if(v===undefined||v===null||v==='')continue;
    parts.push('<b>'+k+'</b>='+(typeof v==='object'?esc(JSON.stringify(v)):esc(v)))}
  return parts.join('  ')}
function hi(s){
  var t=esc(s);
  t=t.replace(/(→|←|HTTP)\\s?(\\d{3})/g,function(m,a,c){var n=+c;var cls=n>=500?'st-bad':n>=400?'st-warn':n>=300?'st-info':'st-ok';return a+' <span class="'+cls+'">'+c+'</span>'});
  t=t.replace(/(https?:\\/\\/[^\\s"'）]+)/g,'<span class="url">$1</span>');
  t=t.replace(/(\\d+(?:\\.\\d+)?ms)\\b/g,'<span class="ms">$1</span>');
  return t}
function tagCls(tag){var m={http:'t-http',subtitle:'t-sub','subtitle-proxy':'t-sub',upstream:'t-up',tmdb:'t-tmdb',catalog:'t-cat',meta:'t-cat',stream:'t-cat'};return m[tag]||'t-dim'}
function nearBottom(){return document.body.scrollHeight-window.scrollY-window.innerHeight<140}
function rowHtml(e){
  var detail=$('detail').checked,ctx=detail&&e.ctx?ctxText(e.ctx):'';
  if(e.tag==='section'){
    var d=detail&&e.ctx?ctxText(e.ctx):'';
    return '<div class="sec"><span class="badge">事项</span><span class="title">'+esc(String(e.msg).replace(/^=+\\s*|\\s*=+$/g,''))+'</span>'+(d?'<span class="meta">'+d+'</span>':'')+'</div>'}
  var rid=e.ctx&&e.ctx.reqId?'<span class="rid">'+esc(e.ctx.reqId)+'</span>':'';
  return '<div class="row lv-'+esc(e.level)+'"><span class="t">'+bj(e.ts)+'</span> <span class="lv lv-'+esc(e.level)+'">'+esc(e.level.toUpperCase())+'</span> <span class="tag '+tagCls(e.tag)+'">'+esc(e.tag)+'</span>'+rid+'<span class="msg">'+hi(e.msg)+'</span>'+(ctx?'<div class="ctx">↳ '+ctx+'</div>':'')+'</div>'}
function apply(d,append){
  var stick=nearBottom();if(!append)$('list').innerHTML='';
  var html='';for(var i=0;i<d.logs.length;i++){var e=d.logs[i];if(append&&e.seq<=lastSeq)continue;
    html+=rowHtml(e);if(e.seq>lastSeq)lastSeq=e.seq}
  if(html)$('list').insertAdjacentHTML('beforeend',html);
  $('stat').textContent='累计 '+d.total+' 条 / 缓冲 '+d.buffered+'/'+d.maxBuffered+(d.debug===false?' / 未开启 debug':'')+(paused?' / 已暂停':'');
  if(stick&&$('follow').checked)window.scrollTo(0,document.body.scrollHeight)}
function refresh(full){
  if(full)lastSeq=0;
  var p=new URLSearchParams({level:$('level').value,q:$('q').value,limit:'400'});
  if(!full&&lastSeq>0)p.set('since',String(lastSeq));
  fetch(api(p)).then(function(r){return r.json()}).then(function(d){apply(d,!full)}).catch(function(){})}
$('now').onclick=function(){refresh(true)};
$('clear').onclick=function(){var p=new URLSearchParams({clear:'1'});fetch(api(p)).then(function(){refresh(true)})};
$('level').onchange=function(){refresh(true)};
$('q').oninput=function(){refresh(true)};
$('fsub').onclick=function(){var on=$('q').value==='subtitle';$('q').value=on?'':'subtitle';refresh(true)};
$('detail').onchange=function(){refresh(true)};
$('pause').onclick=function(){paused=!paused;$('pause').textContent=paused?'继续接收':'暂停接收';$('pause').className=paused?'off':'';refresh(true)};
setInterval(function(){if(!paused)refresh(false)},3000);
if(new URLSearchParams(location.search).get('detail')==='1')$('detail').checked=true;
cfgBar();refresh(true);
</script></body></html>`;

function logsResponse(url, config) {
  if (url.searchParams.get('clear') === '1') {
    clearLogs();
    return jsonResponse({ ok: true, cleared: true, debug: !!config?.debug, ...logStats() });
  }
  const debug = !!config?.debug;
  const wantHtml = url.searchParams.get('format') === 'html';
  if (!debug) {
    // 默认不记录日志：明确回显「未开启」而不是让用户面对空白页猜原因
    if (wantHtml) return htmlResponse(LOGS_OFF_HTML);
    return jsonResponse({
      ok: true,
      debug: false,
      hint: '调试模式未开启，未记录运行日志。请在配置页勾选「开发调试模式」后用生成的链接打开日志页。',
      ...logStats(),
      logs: [],
    });
  }
  if (wantHtml) return htmlResponse(LOGS_HTML);
  const level = url.searchParams.get('level') || 'debug';
  const limit = Number(url.searchParams.get('limit')) || 200;
  const since = Number(url.searchParams.get('since')) || 0;
  const q = url.searchParams.get('q') || '';
  return jsonResponse({ ok: true, debug: true, ...logStats(), logs: getLogs({ level, limit, since, q }) });
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
    L.info('manifest', `version=${manifest.version} types=${manifest.types.join('/')} subtitles=${manifest.resources.some((r) => r.name === 'subtitles')} prefix=${prefix}`);
    // 声明类响应强制重新校验：客户端缓存旧 manifest 会一直不发字幕请求
    return jsonResponse(manifest, { noCache: true });
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
  // 日志接口：只有配置了 debug 的链接才返回内容；日志页自身请求不写日志
  if (path === '/api/logs') {
    meta.resource = 'logs';
    return logsResponse(url, config);
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
      // rezesubs（vidzee 字幕文件）校验 Referer，不带就 403；其余源保持原样
      const host = (() => {
        try {
          return new URL(target).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();
      const headers = { 'user-agent': 'curl/8.7.1', accept: '*/*' };
      if (/(^|\.)rezesubs\.com$/i.test(host)) headers.referer = 'https://core.vidzee.wtf/';
      // rezesubs 等免费 CDN 偶发失败，重试一次再报错
      const doFetch = () =>
        loggedFetch(target, { headers, signal: AbortSignal.timeout(20000) }, { L, tag: 'subtitle-proxy', label: '字幕下载', measure: false });
      let r;
      try {
        r = await doFetch();
        if (!r.ok && needsSubtitleProxy(target)) r = await doFetch();
      } catch (e) {
        if (!needsSubtitleProxy(target)) throw e;
        L.warn('subtitle-proxy', `首次失败，重试: ${e.message}`);
        r = await doFetch();
      }
      const body = await r.arrayBuffer();
      const ct = (r.headers.get('content-type') || '').split(';')[0] || 'application/x-subrip';
      meta.summary = `upstream=${r.status} bytes=${body.byteLength}`;
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
    const extra = parseExtra(url, m[3] ? decodePart(m[3]) : '');
    const result = await handleCatalog({
      type: decodePart(m[1]),
      catalogId: decodePart(m[2]),
      extra,
      config,
      prefix,
      logger: L,
    });
    meta.summary = [
      `metas=${result.metas?.length ?? 0}`,
      extra.search ? `search="${extra.search}"` : '',
      extra.skip ? `skip=${extra.skip}` : '',
    ]
      .filter(Boolean)
      .join(' ');
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
    meta.summary = `meta=${result.meta ? `"${result.meta.name}"` : 'null'} videos=${result.meta?.videos?.length ?? 0}`;
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
    const list = result.streams ?? [];
    const diagCount = list.filter((s) => s.name === '诊断信息').length;
    const embedded = list.filter((s) => s.subtitles?.length).length;
    const embeddedLangs = [...new Set(list.flatMap((s) => (s.subtitles ?? []).map((x) => x.lang)))];
    meta.summary = [
      `streams=${list.length}`,
      diagCount ? `诊断流=${diagCount}` : '',
      embedded ? `内嵌字幕 ${embedded} 条流/${embeddedLangs.join(',')}` : '无内嵌字幕',
    ]
      .filter(Boolean)
      .join(' ');
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
    const d = result.diag || {};
    meta.summary = [
      `subtitles=${result.subtitles?.length ?? 0}`,
      d.langs?.length ? `langs=${d.langs.join('+')}` : '',
      d.imdbId ? `imdb=${d.imdbId}` : 'imdb=未解析',
      d.cached ? '缓存命中' : d.upstream ? `上游=${d.upstream}条` : '',
    ]
      .filter(Boolean)
      .join(' ');
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

// 配置摘要：写进「事项」标题的详情里，替代旧版每条请求都重复一遍的 [config] DEBUG 行
function configSummary(config) {
  if (!config) return '';
  const cats = ['live', 'vod', 'series'].filter((k) => config.catalogs?.[k]).join('/') || '无';
  return [
    `source=${config.source.type}`,
    `lang=${config.language}`,
    `字幕=${config.subtitleLang}`,
    `目录=${cats}`,
    `播放代理=${config.useProxy ? 'on' : 'off'}`,
    `字幕代理=${config.subtitleProxy ? 'on' : 'off'}`,
    `debug=${config.debug ? 'on' : 'off'}`,
    `诊断流=${config.diagnosticStream ? 'on' : 'off'}`,
  ].join(' · ');
}

// 路径 -> 中文事项名，日志分区标题一眼能看懂在干什么
function resourceLabel(path) {
  if (path === '/manifest.json') return '资源声明';
  if (path.startsWith('/catalog/')) return '目录';
  if (path.startsWith('/meta/')) return '详情';
  if (path.startsWith('/stream/')) return '播放源';
  if (path.startsWith('/subtitles/')) return '字幕';
  if (path.startsWith('/api/subtitle')) return '字幕代理';
  if (path.startsWith('/api/diagnose')) return '诊断页';
  if (path.startsWith('/search/')) return '搜索';
  if (path === '/health') return '健康检查';
  if (path === '/') return '首页';
  return '请求';
}

function humanBytes(n) {
  // 未统计（非 debug）时不要显示 0B，否则会误以为响应体是空
  if (n == null || !Number.isFinite(n)) return '-';
  if (n <= 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const started = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  const meta = { reqId, started, resource: 'unknown', summary: '', force: false };
  let urlObj = null;
  let shown = request.url;
  let params = {};
  let isLogs = false;
  try {
    urlObj = new URL(request.url);
    shown = safePath(urlObj);
    params = requestParams(urlObj);
    isLogs = urlObj.pathname === '/api/logs';
    meta.config = getConfig(urlObj);
    // debug 只决定「是否额外输出 DEBUG 明细」，不影响记录本身
    meta.force = !!meta.config?.debug;
  } catch {
    // URL 异常时仍走 dispatch，由它自己报错
  }

  const debug = meta.force;
  // 日志页自身请求完全不写日志（含进出标记），杜绝 3 秒轮询把业务日志刷掉
  const L = isLogs ? NOOP_LOGGER : createLogger({ reqId, force: debug });
  meta.log = L;
  const baseCtx = {
    reqId,
    path: urlObj?.pathname || '',
    method: request.method,
    params,
    query: shown,
  };
  if (!isLogs) {
    // 「事项」分区：一次说清这次请求的路径 / 参数 / 配置，后续日志都归在这一段下面
    L.section(`${resourceLabel(urlObj?.pathname || '')} · ${request.method} ${shown}`, {
      ...baseCtx,
      config: configSummary(meta.config),
    });
  }

  let response;
  try {
    response = await dispatch(request, meta);
  } catch (e) {
    L.error('handler', `unexpected error: ${e?.stack || e?.message}`, baseCtx);
    response = errorResponse(`Internal error: ${e?.message || 'unknown'}`, 500);
  }

  if (!isLogs) {
    const elapsed = Date.now() - started;
    // 只有 debug 才统计响应体大小（克隆读取，不消费原响应）
    let bytes = null;
    if (debug) {
      try {
        bytes = (await response.clone().text()).length;
      } catch {
        bytes = null;
      }
    }
    const line = `← ${response.status} ${meta.resource} ${meta.summary || '-'} ${humanBytes(bytes)} ${elapsed}ms`;
    const outCtx = {
      ...baseCtx,
      status: response.status,
      resource: meta.resource,
      summary: meta.summary,
      bytes,
      elapsed,
    };
    if (response.status >= 400) L.warn('http', line, outCtx);
    else L.info('http', line, outCtx);
  }
  return response;
}
