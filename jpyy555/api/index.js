/**
 * Vercel Edge Function 入口
 *
 * 职责：
 *   1. 初始化统一日志系统（scope 隔离 + Redis 持久化 + console 桥接）
 *   2. 处理 /api/logs 日志页与接口
 *   3. 转交请求给 src/handler.js
 *
 * 业务代码里的 200+ 处 console.log 无需改动：此处一次性桥接到 logger，
 * 自动获得分级、脱敏、reqId、scope 隔离与 Redis 持久化。
 *
 * @module api/index
 */

import handler from '../src/handler.js';
import {
  createLogger, setLogLevel, initLogStore, scopeFromCfg, safeCfgTag,
  getLogs, clearLogs, logStats, flushLogWrites, redact, setNativeConsole,
} from '../src/logger.js';

export const config = { runtime: 'edge' };

const isLogRoute = (p) => p === '/api/logs' || p === '/api/logs.html';

// ── 日志页 HTML ────────────────────────────────────────────
// globalMode=true：读全局 debug 流（所有开启 debug 的用户，靠 cfg 区分），不写自身访问日志。
function logsHtml(scope, globalMode) {
  const modeLabel = globalMode ? '全局调试流（所有已开启 debug 的用户）' : '当前配置 scope=' + scope;
  const modeHint = globalMode
    ? '全局视图只收录<b>开启 debug</b> 的用户日志，每行以 <code>[user=随机值]</code> 区分来源；日志页自身轮询不再写入日志。'
    : '当前作用域 <code>' + scope + '</code>。未带 cfg 的 <code>/api/logs?format=html</code> 显示全局 debug 流。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JPYY 运行日志</title><style>
:root{color-scheme:light}body{margin:0;background:#0f172a;color:#e2e8f0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#1e293b;padding:12px 16px;border-bottom:1px solid #334155;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0 8px 0 0;color:#f8fafc}select,input[type=text],button{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:5px 8px;font:inherit}
button{cursor:pointer}label{display:flex;gap:5px;align-items:center;color:#94a3b8}#stat{color:#94a3b8;margin-left:auto;font-size:11px}
#list{padding:10px 16px}.row{white-space:pre-wrap;word-break:break-all;padding:1px 0;border-bottom:1px solid rgba(148,163,184,.08)}
.lv-debug{color:#94a3b8}.lv-info{color:#e2e8f0}.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.tag{color:#38bdf8}.user{color:#c084fc}.hint{color:#94a3b8;font-size:11px;padding:8px 16px 0}code{background:#1e293b;padding:2px 6px;border-radius:4px}
#pause{min-width:88px}
</style></head><body><header><h1>JPYY 运行日志</h1>
<select id="level"><option value="debug">DEBUG+</option><option value="info" selected>INFO+</option><option value="warn">WARN+</option><option value="error">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：Stream / tt0109830 / user=a1b2c3d4" size="26">
<button id="pause">⏸ 暂停接收</button>
<button id="clear">清空</button><button id="now">立即刷新</button><span id="stat"></span></header>
<p class="hint">${modeLabel}。${modeHint} 取流链路看 <span class="tag">Stream</span> / <span class="tag">adapter</span>，域名切换看 <span class="tag">domain</span>。时间为北京时间（UTC+8）。</p>
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
      // 用户区分：cfg 里的 dbg 标识对所有人相同、无区分意义，只显示随机用户 uid
      var who=e.uid?'<span class="user">[user='+esc(e.uid)+'] </span>':'';
      out+='<div class="row lv-'+esc(e.level)+'">['+esc(bj(e.ts))+'] ['+esc(e.level.toUpperCase())+'] ['+esc(e.tag)+'] '+who+esc(e.msg)+'</div>';
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

// 统一收尾：注册 waitUntil 等待日志刷写完成，避免 Edge 冻结实例导致日志丢失
function finalize(res, ctx) {
  const flush = flushLogWrites();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(flush);
  return res;
}

// ── 主入口 ────────────────────────────────────────────────
export default async function vercelHandler(request, env, ctx) {
  env = env || process.env;
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
  setLogLevel(cfgDebug ? 'debug' : (env.LOG_LEVEL || 'info'));
  initLogStore(env, {
    prefix: env.APP_PREFIX || 'jpyy555',
    scope,
    debugUser: cfgDebug,
    cfgTag: safeCfgTag(cfgParam),
    uid: cfgUid,
  });

  const entry = createLogger('Edge', { reqId: Math.random().toString(36).slice(2, 8) });

  // console → logger 桥接（只装一次，幂等），把业务代码里的 console 全部纳入日志系统
  if (!globalThis.__loggerBridged) {
    globalThis.__loggerBridged = true;
    // 先保存原生 console，供 logger.emit 的终端输出使用，防止桥接后递归
    setNativeConsole({ log: console.log, warn: console.warn, error: console.error });
    const bridge = (level) => (...args) => {
      const raw = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
      // 从第一个 [Tag] 提取 tag，并从正文去掉，避免页面上 tag 重复
      const m = /^\[([^\]]{1,24})\]\s*/.exec(raw);
      const tag = m ? m[1] : 'console';
      const msg = m ? raw.slice(m[0].length) : raw;
      const L = createLogger(tag);
      if (level === 'error') L.error(msg);
      else if (level === 'warn') L.warn(msg);
      else L.info(msg);   // 业务 console.log 归为 info，避免 debug 刷屏
    };
    console.log = bridge('info');
    console.warn = bridge('warn');
    console.error = bridge('error');
  }

  // 关键：日志页自身请求不写日志，否则轮询 GET /api/logs 会刷屏且显示为 debug=false
  if (!logRoute) {
    entry.info(`${request.method} ${url.pathname} scope=${scope} debug=${cfgDebug}`);
  }

  // ── 日志接口 / 页面 ────────────────────────────────────
  if (logRoute) {
    if (url.searchParams.get('clear') === '1') {
      await clearLogs({ global: globalMode });
      return finalize(new Response(JSON.stringify({ ok: true, cleared: true, global: globalMode, ...logStats() }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      }), ctx);
    }
    if (url.searchParams.get('format') === 'html') {
      return finalize(new Response(logsHtml(scope, globalMode), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      }), ctx);
    }
    const level = url.searchParams.get('level') || 'debug';
    const limit = Number(url.searchParams.get('limit')) || 200;
    const q = url.searchParams.get('q') || '';
    return finalize(new Response(JSON.stringify({ ok: true, global: globalMode, ...logStats(), logs: await getLogs({ level, limit, q, global: globalMode }) }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    }), ctx);
  }

  try {
    const response = await handler.fetch(request, env, ctx);
    const elapsed = Date.now() - t0;
    entry.info(`${url.pathname} → ${response.status} (${elapsed}ms)`);
    return finalize(response, ctx);
  } catch (err) {
    entry.error(`${url.pathname} 未捕获异常: ${err.message}`);
    entry.error(redact(String(err.stack || '').slice(0, 500)));
    return finalize(new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }), ctx);
  }
}
