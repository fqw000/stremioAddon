// Catvod 运行日志页（三视图 + 暂停 + 详情 + 北京时间）
// 设计见 ../日志系统规范.md；模板与 trybox / dongpiandi 一致
function logsHtml(scope, view) {
  const viewLabel = view === 'all' ? '所有用户（info+）'
    : view === 'debug' ? 'debug 用户（debug+）'
    : '当前配置 scope=' + scope;
  const viewHint = view === 'personal'
    ? '个人视图按 cfg 隔离，只显示当前配置的日志。顶部可切换到全局汇总。'
    : '全局汇总以 <code>[user=随机值]</code> 区分来源；日志页自身轮询不写入日志。';
  const opt = (v, t) => `<option value="${v}"${view === v ? ' selected' : ''}>${t}</option>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catvod 运行日志</title><style>
:root{color-scheme:light}body{margin:0;background:#0f172a;color:#e2e8f0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;background:#1e293b;padding:12px 16px;border-bottom:1px solid #334155;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{font-size:15px;margin:0 8px 0 0;color:#f8fafc}select,input[type=text],button{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:5px 8px;font:inherit}
button{cursor:pointer}label{display:flex;gap:5px;align-items:center;color:#94a3b8}#stat{color:#94a3b8;margin-left:auto;font-size:11px}
#list{padding:10px 16px}
.row{white-space:pre-wrap;word-break:break-word;padding:1px 0;border-bottom:1px solid rgba(148,163,184,.08)}
.lv-debug{color:#94a3b8}.lv-info{color:#e2e8f0}.lv-warn{color:#fbbf24}.lv-error{color:#f87171}
.tag{color:#38bdf8}.user{color:#c084fc}.hint{color:#94a3b8;font-size:11px;padding:8px 16px 0}code{background:#1e293b;padding:2px 6px;border-radius:4px}
#pause{min-width:88px}
.sec{display:flex;gap:10px;align-items:baseline;margin:12px 0 4px;padding:6px 10px;background:linear-gradient(90deg,#312e5a,#1e293b 70%);border-left:3px solid #a78bfa}
.sec .badge{font-size:10px;color:#0f172a;background:#a78bfa;border-radius:3px;padding:0 5px;font-weight:700}
.sec .title{color:#e9d5ff;font-weight:600;word-break:break-all}
.sec .meta{color:#94a3b8;font-size:11px;word-break:break-all}
.ctx{color:#94a3b8;padding:1px 0 3px 16px;font-size:11px;white-space:pre-wrap}
.ctx b{color:#cbd5e1;font-weight:600}.rid{color:#0f172a;background:#64748b;border-radius:3px;padding:0 4px;margin-right:5px;font-size:10px}
.st-ok{color:#4ade80}.st-warn{color:#fbbf24}.st-bad{color:#f87171}.ms{color:#a5b4fc}.url{color:#93c5fd}
</style></head><body><header><h1>Catvod 运行日志</h1>
<select id="view" title="日志范围">${opt('all', '所有用户')}${opt('debug', 'debug 用户')}${opt('personal', '当前配置')}</select>
<select id="level"><option value="debug">DEBUG+</option><option value="info" selected>INFO+</option><option value="warn">WARN+</option><option value="error">ERROR</option></select>
<input type="text" id="q" placeholder="过滤：Stream / tt5034838 / user=a1b2c3d4" size="26">
<label><input type="checkbox" id="detail"> 显示详情</label>
<button id="pause">⏸ 暂停接收</button>
<button id="clear">清空</button><button id="now">立即刷新</button><span id="stat"></span></header>
<p class="hint">当前范围：<b>${viewLabel}</b>。${viewHint} 勾选「显示详情」展开请求的路径/参数/响应/耗时与底层接口 URL；事项区块按请求分段。时间为北京时间（UTC+8）。</p>
<div id="list"></div><script>
var SCOPE=${JSON.stringify(scope)};
var VIEW=${JSON.stringify(view)};
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
// 后端 ts 为 UTC ISO；+8h 后取时间部分即北京时间
function bj(ts){try{return new Date(new Date(ts).getTime()+8*3600*1000).toISOString().slice(11,23)}catch(e){return String(ts).slice(11,23)}}
var paused=false,lastSeq=0;
function scopeParams(){
  return VIEW==='personal'?{scope:SCOPE}:{view:VIEW};
}
function ctxText(c){
  var keys=['path','method','params','config','status','resource','summary','bytes','elapsed','upstream','contentType','error'],parts=[];
  for(var i=0;i<keys.length;i++){var k=keys[i],v=c[k];if(v===undefined||v===null||v==='')continue;
    parts.push('<b>'+k+'</b>='+(typeof v==='object'?esc(JSON.stringify(v)):esc(v)))}
  return parts.join('  ')}
function hi(s){
  var t=esc(s);
  t=t.replace(/(→|←|HTTP)\s?(\d{3})/g,function(m,a,c){var n=+c;var cls=n>=500?'st-bad':n>=400?'st-warn':'st-ok';return a+' <span class="'+cls+'">'+c+'</span>'});
  t=t.replace(/(https?:\/\/[^\s"'）]+)/g,'<span class="url">$1</span>');
  t=t.replace(/(\d+(?:\.\d+)?ms)\b/g,'<span class="ms">$1</span>');
  return t}
function rowHtml(e){
  var detail=$('detail').checked,ctx=detail&&e.ctx?ctxText(e.ctx):'';
  if(e.tag==='section'||e.section){
    var d=detail&&e.ctx?ctxText(e.ctx):'';
    return '<div class="sec"><span class="badge">事项</span><span class="title">'+esc(String(e.msg).replace(/^=+\s*|\s*=+$/g,''))+'</span>'+(d?'<span class="meta">'+d+'</span>':'')+'</div>'}
  var rid=(e.ctx&&e.ctx.reqId)?'<span class="rid">'+esc(e.ctx.reqId)+'</span>':'';
  var who=e.uid?'<span class="user">[user='+esc(e.uid)+'] </span>':'';
  return '<div class="row lv-'+esc(e.level)+'">['+esc(bj(e.ts))+'] ['+esc(e.level.toUpperCase())+'] ['+esc(e.tag)+'] '+who+rid+hi(e.msg)+(ctx?'<div class="ctx">↳ '+ctx+'</div>':'')+'</div>'}
function apply(d,append){
  var stick=!paused;
  if(!append){$('list').innerHTML='';lastSeq=0}
  var html='';for(var i=0;i<d.logs.length;i++){var e=d.logs[i];if(append&&e.seq<=lastSeq)continue;
    html+=rowHtml(e);if(e.seq>lastSeq)lastSeq=e.seq}
  if(html)$('list').insertAdjacentHTML('beforeend',html);
  $('stat').textContent='['+VIEW+'] 累计 '+d.total+' 条 / 缓冲 '+d.buffered+' 条 / 控制台 '+d.consoleLevel+' / 存储 '+d.store;
  if(stick)window.scrollTo(0,document.body.scrollHeight)}
function refresh(full){
  var p=new URLSearchParams(Object.assign({level:$('level').value,q:$('q').value,limit:'400'},scopeParams()));
  if(!full&&lastSeq>0)p.set('since',String(lastSeq));
  fetch('/api/logs?'+p.toString()).then(function(r){return r.json()}).then(function(d){apply(d,!full)});
}
$('now').onclick=function(){refresh(true)};
$('detail').onchange=function(){refresh(true)};
$('pause').onclick=function(){
  paused=!paused;
  this.textContent=paused?'▶ 继续接收':'⏸ 暂停接收';
  $('stat').style.color=paused?'#fbbf24':'#94a3b8';
};
$('clear').onclick=function(){var p=new URLSearchParams(scopeParams());p.set('clear','1');fetch('/api/logs?'+p.toString()).then(function(){refresh(true)})};
$('level').onchange=function(){refresh(true)};$('q').oninput=function(){refresh(true)};
$('view').onchange=function(){VIEW=this.value;refresh(true)};
setInterval(function(){if(!paused)refresh(false)},3000);
refresh(true);
</script></body></html>`;
}

export { logsHtml };
