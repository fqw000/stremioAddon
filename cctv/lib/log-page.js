'use strict';

// 参考 hyperTv 的实时日志页：按「事项」分区、按序号增量轮询、可选显示详情。
// 本页自身不写日志；只有 debug 配置或手动 enable 后才有内容。

const OFF_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>央视片库 · 运行日志</title><style>
body{margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:680px;margin:72px auto;padding:28px 30px;background:#1e293b;border:1px solid #334155;border-radius:14px}
h1{font-size:18px;margin:0 0 10px;color:#f8fafc}code{background:#0f172a;border:1px solid #334155;border-radius:4px;padding:1px 6px;font-size:12px;color:#7dd3fc}
a{color:#38bdf8}ol{color:#cbd5e1;padding-left:20px}li{margin:6px 0}.muted{color:#94a3b8;font-size:13px}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;font:600 14px inherit;margin-right:8px}
button.gray{background:#475569}
</style></head><body><div class="card"><h1>日志系统当前已关闭</h1>
<p class="muted">为降低电视端开销，默认不记录任何日志。只有两种方式可以开启：</p>
<ol>
<li>打开 <a href="/configure">配置页</a>，勾选 <b>开启实时日志</b>，生成安装链接后点击「打开实时日志」；</li>
<li>临时排查：点击下方按钮，仅对当前进程生效，重启服务后自动关闭。</li>
</ol>
<p><button id="on">临时开启日志</button><button class="gray" id="diag">打开在线自检</button></p>
<p class="muted">命令行深度排查：在服务目录运行 <code>node health.js</code>。</p>
</div><script>
document.getElementById('on').onclick=async function(){await fetch('/api/logs?enable=1');location.reload()};
document.getElementById('diag').onclick=function(){location.href='/_diagnostics'};
</script></body></html>`;

const ON_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>央视片库 · 实时日志</title><style>
:root{color-scheme:dark}
body{margin:0;background:#0b1220;color:#cbd5e1;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#111a2e;padding:10px 16px;border-bottom:1px solid #24324d;display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:3}
h1{font-size:14px;margin:0 10px 0 0;color:#f1f5f9;font-weight:600;letter-spacing:.3px}
select,input[type=text],button{background:#0b1220;color:#dbeafe;border:1px solid #33456b;border-radius:6px;padding:4px 8px;font:inherit}
button{cursor:pointer}button:hover{border-color:#4f6a99}button.on{border-color:#38bdf8;color:#7dd3fc}button.warn{border-color:#f59e0b;color:#fbbf24}
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
.tag{display:inline-block;min-width:92px;margin-right:6px;font-weight:600}
.t-http{color:#60a5fa}.t-upstream{color:#22d3ee}.t-catalog{color:#4ade80}.t-meta{color:#4ade80}.t-stream{color:#4ade80}.t-h5eproxy{color:#f0abfc}.t-dim{color:#94a3b8}
.msg{color:#dbe3f0}
.st-ok{color:#4ade80}.st-info{color:#22d3ee}.st-warn{color:#fbbf24}.st-bad{color:#f87171}
.url{color:#93c5fd;text-decoration:underline dotted}.ms{color:#a5b4fc}
.ctx{color:#7c8db0;padding:1px 0 4px 14px;font-size:11px;white-space:pre-wrap}
.ctx b{color:#94a3b8;font-weight:600}
.hint{color:#7c8db0;font-size:11px;padding:6px 16px;margin:0}.hint a{color:#38bdf8}
</style></head><body>
<header><h1>央视片库 · 实时日志</h1>
<select id="level"><option value="DEBUG" selected>DEBUG+（全链路）</option><option value="INFO">INFO+</option><option value="WARN">WARN+</option><option value="ERROR">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：catalog / 403 / URL" size="22">
<label><input type="checkbox" id="detail" checked> 显示详情</label>
<label><input type="checkbox" id="follow" checked> 自动滚动</label>
<button id="pause">暂停接收</button><button id="clear">清空</button><button id="now">立即刷新</button><button id="off" class="warn">关闭日志</button>
<span id="stat"></span></header>
<div id="cfgbar">配置：读取中…</div>
<p class="hint">时间按本机显示。每个请求一个「事项」分区；详情里可看到完整 URL、上游状态、字节数、耗时与各步骤。日志页轮询不写日志。</p>
<div id="list"></div><script>
var $=function(id){return document.getElementById(id)};
var SEG=(function(){var p=location.pathname.split('/').filter(Boolean);return p.length&&p[0]!=='api'&&p[0]!=='logs'?p[0]:''})();
var QCFG=new URLSearchParams(location.search).get('cfg')||'';
var CFG=SEG||QCFG;
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
var lastSeq=0,paused=false;
function url(p){p=p||new URLSearchParams();var base=CFG?'/'+encodeURIComponent(CFG)+'/api/logs':'/api/logs';return base+(p.toString()?'?'+p.toString():'')}
function localTime(ts){var d=new Date(ts);return d.toTimeString().slice(0,12)}
function readCfg(){try{var s=CFG;if(!/^[\[{]/.test(s)){s=decodeURIComponent(s)}return JSON.parse(s)}catch(e){return null}}
function cfgBar(){var c=readCfg();if(!c){$('cfgbar').textContent='配置：进程级日志或客户端未提供配置';return}
var parts=['catalogs='+Object.keys(c.catalogs||{}).filter(function(k){return c.catalogs[k]}).length,
'qualities='+Object.keys(c.qualities||{}).filter(function(k){return c.qualities[k]}).length,
'debug='+(c.debug?'on':'off')];$('cfgbar').textContent='配置：'+parts.join(' · ')}
function ctxText(c){
  var parts=[];
  for(var k in c){if(!Object.prototype.hasOwnProperty.call(c,k))continue;var v=c[k];if(v===undefined||v===null||v==='')continue;
    parts.push('<b>'+esc(k)+'</b>='+(typeof v==='object'?esc(JSON.stringify(v)):esc(v)))}
  return parts.join('  ')}
function hi(s){
  var t=esc(s);
  t=t.replace(/(→|←|HTTP)\s?(\d{3})/g,function(m,a,c){var n=+c;var cls=n>=500?'st-bad':n>=400?'st-warn':n>=300?'st-info':'st-ok';return a+' <span class="'+cls+'">'+c+'</span>'});
  t=t.replace(/(https?:\/\/[^\s"'）]+)/g,'<span class="url">$1</span>');
  t=t.replace(/(\d+(?:\.\d+)?ms)\b/g,'<span class="ms">$1</span>');
  return t}
function tagCls(tag){var m={http:'t-http',upstream:'t-upstream',catalog:'t-catalog',meta:'t-meta',stream:'t-stream',h5eproxy:'t-h5eproxy'};return m[tag]||'t-dim'}
function nearBottom(){return document.body.scrollHeight-window.scrollY-window.innerHeight<140}
function rowHtml(e){
  var detail=$('detail').checked,ctx=detail&&e.ctx?ctxText(e.ctx):'';
  if(e.tag==='section'){
    var d=detail&&e.ctx?ctxText(e.ctx):'';
    return '<div class="sec"><span class="badge">事项</span><span class="title">'+esc(String(e.msg).replace(/^=+\s*|\s*=+$/g,''))+'</span>'+(d?'<span class="meta">'+d+'</span>':'')+'</div>'}
  var rid=e.reqId?'<span class="rid">'+esc(e.reqId)+'</span>':'';
  return '<div class="row lv-'+esc(e.level)+'"><span class="t">'+localTime(e.ts)+'</span> <span class="lv lv-'+esc(e.level)+'">'+esc(e.level.toUpperCase())+'</span> <span class="tag '+tagCls(e.tag)+'">'+esc(e.tag)+'</span>'+rid+'<span class="msg">'+hi(e.msg)+'</span>'+(ctx?'<div class="ctx">↳ '+ctx+'</div>':'')+'</div>'}
function apply(d,append){
  var stick=nearBottom();if(!append)$('list').innerHTML='';
  var html='';for(var i=0;i<d.logs.length;i++){var e=d.logs[i];if(append&&e.seq<=lastSeq)continue;
    html+=rowHtml(e);if(e.seq>lastSeq)lastSeq=e.seq}
  if(html)$('list').insertAdjacentHTML('beforeend',html);
  $('stat').textContent='累计 '+d.total+' 条 / 缓冲 '+d.buffered+'/'+d.maxBuffered+(paused?' / 已暂停':'');
  if(stick&&$('follow').checked)window.scrollTo(0,document.body.scrollHeight)}
function refresh(full){
  if(full)lastSeq=0;
  var p=new URLSearchParams({level:$('level').value,q:$('q').value,limit:'400'});
  if(!full&&lastSeq>0)p.set('since',String(lastSeq));
  fetch(url(p)).then(function(r){return r.json()}).then(function(d){apply(d,!full)}).catch(function(){})}
$('now').onclick=function(){refresh(true)};
$('clear').onclick=function(){fetch(url(new URLSearchParams({clear:'1'}))).then(function(){refresh(true)})};
$('level').onchange=function(){refresh(true)};
$('q').oninput=function(){refresh(true)};
$('detail').onchange=function(){refresh(true)};
$('pause').onclick=function(){paused=!paused;$('pause').textContent=paused?'继续接收':'暂停接收';$('pause').className=paused?'on':'';refresh(true)};
$('off').onclick=function(){fetch('/api/logs?disable=1').then(function(){location.reload()})};
setInterval(function(){if(!paused)refresh(false)},3000);
cfgBar();refresh(true);
</script></body></html>`;

module.exports = { OFF_HTML, ON_HTML };
