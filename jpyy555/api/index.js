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
  createLogger, setLogLevel, initLogStore, scopeFromCfg,
  getLogs, clearLogs, logStats, flushLogWrites, redact, setNativeConsole,
} from '../src/logger.js';

export const config = { runtime: 'edge' };

// ── 日志页 HTML（读当前 scope）─────────────────────────────
function logsHtml(scope) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JPYY 运行日志</title><style>
:root{color-scheme:light}body{margin:0;background:#0f172a;color:#e2e8f0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#1e293b;padding:12px 16px;border-bottom:1px solid #334155;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0 8px 0 0;color:#f8fafc}select,input[type=text],button{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:5px 8px;font:inherit}
button{cursor:pointer}label{display:flex;gap:5px;align-items:center;color:#94a3b8}#stat{color:#94a3b8;margin-left:auto;font-size:11px}
#list{padding:10px 16px}.row{white-space:pre-wrap;word-break:break-all;padding:1px 0;border-bottom:1px solid rgba(148,163,184,.08)}
.lv-debug{color:#94a3b8}.lv-info{color:#e2e8f0}.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.tag{color:#38bdf8}.hint{color:#94a3b8;font-size:11px;padding:8px 16px 0}code{background:#1e293b;padding:2px 6px;border-radius:4px}
</style></head><body><header><h1>JPYY 运行日志</h1>
<select id="level"><option value="debug">DEBUG+</option><option value="info" selected>INFO+</option><option value="warn">WARN+</option><option value="error">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：Stream / tt0109830 / 403" size="26">
<label><input type="checkbox" id="auto" checked> 自动刷新</label>
<button id="clear">清空</button><button id="now">立即刷新</button><span id="stat"></span></header>
<p class="hint">当前作用域 <code>${scope}</code>。日志页需带与安装地址相同的 <code>?cfg=</code> 才能看到对应记录；在配置页点「查看运行日志」会自动带上。取流链路看 <span class="tag">Stream</span> / <span class="tag">adapter</span>，域名切换看 <span class="tag">domain</span>。配置页勾选 debug 后写入完整链路。</p>
<div id="list"></div><script>
var SCOPE=${JSON.stringify(scope)};
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
function refresh(){
  var p=new URLSearchParams({level:$('level').value,q:$('q').value,limit:'400',scope:SCOPE});
  fetch('/api/logs?'+p.toString()).then(function(r){return r.json()}).then(function(d){
    $('stat').textContent='累计 '+d.total+' 条 / 缓冲 '+d.buffered+' 条 / 控制台 '+d.consoleLevel+' / 存储 '+d.store;
    var out='';
    for(var i=0;i<d.logs.length;i++){var e=d.logs[i];
      out+='<div class="row lv-'+esc(e.level)+'">['+esc(e.ts.slice(11,23))+'] ['+esc(e.level.toUpperCase())+'] ['+esc(e.tag)+'] '+esc(e.msg)+'</div>';
    }
    $('list').innerHTML=out;
    window.scrollTo(0,document.body.scrollHeight);
  });
}
$('now').onclick=refresh;
$('clear').onclick=function(){var p=new URLSearchParams({clear:'1',scope:SCOPE});fetch('/api/logs?'+p.toString()).then(refresh)};
$('level').onchange=refresh;$('q').oninput=refresh;
setInterval(function(){if($('auto').checked)refresh()},3000);
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
  const scope = url.searchParams.get('scope') || scopeFromCfg(cfgParam);

  // debug 开关（cfg 里 dbg=true）
  let cfgDebug = false;
  try {
    let b64 = cfgParam.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    cfgDebug = JSON.parse(atob(b64)).dbg === true;
  } catch (e) {}
  setLogLevel(cfgDebug ? 'debug' : (env.LOG_LEVEL || 'info'));
  initLogStore(env, { prefix: env.APP_PREFIX || 'jpyy555', scope });

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

  entry.info(`${request.method} ${url.pathname} scope=${scope} debug=${cfgDebug}`);

  // ── 日志接口 / 页面 ────────────────────────────────────
  if (url.pathname === '/api/logs' || url.pathname === '/api/logs.html') {
    if (url.searchParams.get('clear') === '1') {
      await clearLogs();
      return finalize(new Response(JSON.stringify({ ok: true, cleared: true, ...logStats() }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      }), ctx);
    }
    if (url.searchParams.get('format') === 'html') {
      return finalize(new Response(logsHtml(scope), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      }), ctx);
    }
    const level = url.searchParams.get('level') || 'debug';
    const limit = Number(url.searchParams.get('limit')) || 200;
    const q = url.searchParams.get('q') || '';
    return finalize(new Response(JSON.stringify({ ok: true, ...logStats(), logs: await getLogs({ level, limit, q }) }), {
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
