/**
 * Vercel Edge Function 入口
 *
 * 职责：
 *   1. 解析请求
 *   2. 调用 src/handler.js 的分发逻辑
 *   3. 统一错误处理和日志
 *
 * 注意：本文件仅做入口转发，业务逻辑在 src/handler.js
 */

import { handleRequest } from '../src/handler.js';
import {
  createLogger, setLogLevel, initLogStore, scopeFromCfg, safeCfgTag,
  getLogs, clearLogs, logStats, flushLogWrites,
} from '../src/logger.js';

export const config = { runtime: 'edge' };

const isLogRoute = (p) => p === '/api/logs' || p === '/api/logs.html';

// 统一收尾：注册 waitUntil 等待日志刷写完成，避免 Edge 在响应后立即冻结实例导致日志丢失。
// 本地测试 / 非 Edge 环境没有 waitUntil 时，退化为直接 await。
function finalize(res, context) {
  const flush = flushLogWrites();
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(flush);
  }
  return res;
}

// 生成日志页 HTML。
// globalMode=true：读全局 debug 流（所有开启 debug 的用户，靠 cfg 区分），不写自身访问日志。
function logsHtml(scope, globalMode) {
  const modeLabel = globalMode ? '全局调试流（所有已开启 debug 的用户）' : '当前配置 scope=' + scope;
  const modeHint = globalMode
    ? '全局视图只收录<b>开启 debug</b> 的用户日志，每行以 <code>[user=随机值]</code> 区分来源；日志页自身轮询不再写入日志。'
    : '当前作用域 <code>' + scope + '</code>。未带 cfg 的 <code>/api/logs?format=html</code> 显示全局 debug 流。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TryBox 运行日志</title><style>
:root{color-scheme:light}body{margin:0;background:#0f172a;color:#e2e8f0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#1e293b;padding:12px 16px;border-bottom:1px solid #334155;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0 8px 0 0;color:#f8fafc}select,input[type=text],button{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:5px 8px;font:inherit}
button{cursor:pointer}label{display:flex;gap:5px;align-items:center;color:#94a3b8}#stat{color:#94a3b8;margin-left:auto;font-size:11px}
#list{padding:10px 16px}.row{white-space:pre-wrap;word-break:break-all;padding:1px 0;border-bottom:1px solid rgba(148,163,184,.08)}
.lv-debug{color:#94a3b8}.lv-info{color:#e2e8f0}.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.tag{color:#38bdf8}.user{color:#c084fc}.hint{color:#94a3b8;font-size:11px;padding:8px 16px 0}code{background:#1e293b;padding:2px 6px;border-radius:4px}
#pause{min-width:88px}
</style></head><body><header><h1>TryBox 运行日志</h1>
<select id="level"><option value="debug">DEBUG+</option><option value="info" selected>INFO+</option><option value="warn">WARN+</option><option value="error">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：Stream / tt5034838 / user=a1b2c3d4" size="26">
<button id="pause">⏸ 暂停接收</button>
<button id="clear">清空</button><button id="now">立即刷新</button><span id="stat"></span></header>
<p class="hint">${modeLabel}。${modeHint} 请求进出看 <span class="tag">Edge</span>，取流链路看 <span class="tag">Stream</span>。时间为北京时间（UTC+8）。</p>
<div id="list"></div><script>
var SCOPE=${JSON.stringify(scope)};
var GLOBAL=${globalMode ? 'true' : 'false'};
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
// 后端 ts 为 UTC ISO；+8h 后取时间部分即北京时间
function bj(ts){try{return new Date(new Date(ts).getTime()+8*3600*1000).toISOString().slice(11,23)}catch(e){return String(ts).slice(11,23)}}
var paused=false;
function refresh(){
  var p=new URLSearchParams({level:$('level').value,q:$('q').value,limit:'400'});
  if(GLOBAL) p.set('global','1'); else p.set('scope',SCOPE);
  fetch('/api/logs?'+p.toString()).then(function(r){return r.json()}).then(function(d){
    $('stat').textContent='累计 '+d.total+' 条 / 缓冲 '+d.buffered+' 条 / 控制台 '+d.consoleLevel+' / 存储 '+d.store+(GLOBAL?' / 全局':'');
    var out='';
    for(var i=0;i<d.logs.length;i++){var e=d.logs[i];
      var rid=(e.ctx&&e.ctx.reqId)?'('+esc(e.ctx.reqId)+') ':'';
      // 用户区分：cfg 里的 dbg 标识对所有人相同、无区分意义，只显示随机用户 uid
      var who=e.uid?'<span class="user">[user='+esc(e.uid)+'] </span>':'';
      out+='<div class="row lv-'+esc(e.level)+'">['+esc(bj(e.ts))+'] ['+esc(e.level.toUpperCase())+'] ['+esc(e.tag)+'] '+who+rid+esc(e.msg)+'</div>';
    }
    $('list').innerHTML=out;
    if(!paused) window.scrollTo(0,document.body.scrollHeight);
  });
}
$('now').onclick=refresh;
$('pause').onclick=function(){
  paused=!paused;
  this.textContent=paused?'▶ 继续接收':'⏸ 暂停接收';
  $('stat').style.color=paused?'#fbbf24':'#94a3b8';
};
$('clear').onclick=function(){var p=new URLSearchParams(GLOBAL?{global:'1'}:{scope:SCOPE});p.set('clear','1');fetch('/api/logs?'+p.toString()).then(refresh)};
$('level').onchange=refresh;$('q').oninput=refresh;
setInterval(function(){if(!paused)refresh()},3000);
refresh();
</script></body></html>`;
}

export default async function (request, context) {
  const t0 = Date.now();
  const url = new URL(request.url);
  const cfgParam = url.searchParams.get('cfg') || '';
  const scopeParam = url.searchParams.get('scope') || '';
  const logRoute = isLogRoute(url.pathname);
  // 未带 cfg / scope 的日志路由 = 全局调试视图；带 cfg / scope = 个人视图
  const globalMode = logRoute && !cfgParam && !scopeParam;
  const scope = scopeParam || scopeFromCfg(cfgParam);

  // 解析 cfg：debug 开关 + 随机 uid（用于全局汇总区分用户）
  let cfgDebug = false;
  let cfgUid = '';
  try {
    let b64 = cfgParam.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const cfgObj = JSON.parse(atob(b64));
    cfgDebug = cfgObj.dbg === true;
    cfgUid = String(cfgObj.uid || '');
  } catch (e) {}
  setLogLevel(cfgDebug ? 'debug' : (process.env.LOG_LEVEL || 'info'));

  initLogStore(process.env, {
    prefix: process.env.APP_PREFIX || 'tryboxStream',
    scope,
    debugUser: cfgDebug,
    cfgTag: safeCfgTag(cfgParam),
    uid: cfgUid,
  });

  // 关键：日志页自身请求不写日志，否则轮询 GET /api/logs 会刷屏且显示为 debug=false。
  const logR = createLogger('Edge', { reqId: Math.random().toString(36).slice(2, 8) });
  if (!logRoute) {
    logR.info(`${request.method} ${url.pathname}${url.search.slice(0, 120)} scope=${scope} debug=${cfgDebug}`);
  }

  // 日志接口 / 页面（在 handleRequest 之前处理，避免被当 404）
  if (logRoute) {
    if (url.searchParams.get('clear') === '1') {
      await clearLogs({ global: globalMode });
      return finalize(new Response(JSON.stringify({ ok: true, cleared: true, global: globalMode, ...logStats() }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      }), context);
    }
    if (url.searchParams.get('format') === 'html') {
      return finalize(new Response(logsHtml(scope, globalMode), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      }), context);
    }
    const level = url.searchParams.get('level') || 'debug';
    const limit = Number(url.searchParams.get('limit')) || 200;
    const q = url.searchParams.get('q') || '';
    return finalize(new Response(JSON.stringify({ ok: true, global: globalMode, ...logStats(), logs: await getLogs({ level, limit, q, global: globalMode }) }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    }), context);
  }

  // 根路径：浏览器访问 → 302 跳转到 /configure
  if (url.pathname === '/') {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/html')) {
      logR.info('浏览器访问根路径，跳转到 /configure');
      return finalize(Response.redirect(new URL('/configure', request.url).toString(), 302), context);
    }
    // 非浏览器（Stremio / API）→ 继续走 handleRequest，返回 manifest
  }

  try {
    const response = await handleRequest(request, process.env);
    const elapsed = Date.now() - t0;
    logR.info(`${url.pathname} → ${response.status} (${elapsed}ms)`);
    return finalize(response, context);
  } catch (err) {
    logR.error(`${url.pathname} 未捕获异常:`, err.message);
    logR.error(err.stack?.slice(0, 500));
    return finalize(new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }), context);
  }
}
