// src/health.js

export const startTime = Date.now();

export function getHealthData() {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  
  // 格式化运行时间 (例如: 2天 3小时 15分钟)
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = uptimeSec % 60;
  
  let uptimeStr = '';
  if (days > 0) uptimeStr += `${days}天 `;
  if (hours > 0) uptimeStr += `${hours}小时 `;
  if (minutes > 0) uptimeStr += `${minutes}分 `;
  uptimeStr += `${seconds}秒`;

  return {
    status: 'ok',
    uptime: uptimeStr,
    uptimeSec,
    timestamp: new Date().toISOString(),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
    },
    node: process.version,
    platform: process.platform,
  };
}

export function renderHealthPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>服务运行状态 - Vyla Addon</title>
<link rel="icon" href="/favicon.ico">
<style>
  :root {
    --bg: #f5f6f8;
    --card-bg: #ffffff;
    --text-main: #111827;
    --text-sub: #6b7280;
    --primary: #10b981; /* 绿色 */
    --border: #e5e7eb;
    --radius: 16px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text-main);
    min-height: 100vh;
    padding: 40px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .container { width: 100%; max-width: 600px; }
  
  .header { text-align: center; margin-bottom: 30px; }
  .header img { width: 64px; height: 64px; border-radius: 16px; margin-bottom: 16px; }
  .header h1 { font-size: 22px; font-weight: 600; color: #111; }
  
  .status-badge {
    display: inline-flex;
    align-items: center;
    background: #ecfdf5;
    color: #065f46;
    padding: 6px 16px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 600;
    margin-top: 12px;
    border: 1px solid #a7f3d0;
  }
  .status-dot {
    width: 8px; height: 8px;
    background: var(--primary);
    border-radius: 50%;
    margin-right: 8px;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
    70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
    100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
  }

  .card {
    background: var(--card-bg);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.03);
    border: 1px solid var(--border);
  }
  .card-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-sub);
    margin-bottom: 16px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .data-row {
    display: flex;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid #f3f4f6;
    font-size: 15px;
  }
  .data-row:last-child { border-bottom: none; padding-bottom: 0; }
  .data-row .label { color: var(--text-sub); }
  .data-row .value { font-family: ui-monospace, monospace; font-weight: 500; }

  .btn {
    display: block;
    width: 100%;
    background: #3b82f6;
    color: #fff;
    text-align: center;
    padding: 14px;
    border-radius: 10px;
    text-decoration: none;
    font-weight: 600;
    transition: background 0.2s;
  }
  .btn:hover { background: #2563eb; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <img src="/favicon.ico" alt="Logo" onerror="this.style.display='none'">
    <h1>系统运行状态</h1>
    <div class="status-badge">
      <span class="status-dot"></span> 运行正常 (Healthy)
    </div>
  </div>

  <div class="card">
    <div class="card-title">📊 基础信息</div>
    <div class="data-row">
      <span class="label">当前时间</span>
      <span class="value" id="sys-time">加载中...</span>
    </div>
    <div class="data-row">
      <span class="label">连续运行时间</span>
      <span class="value" id="uptime">加载中...</span>
    </div>
    <div class="data-row">
      <span class="label">Node.js 版本</span>
      <span class="value" id="node-ver">加载中...</span>
    </div>
    <div class="data-row">
      <span class="label">运行平台</span>
      <span class="value" id="platform">加载中...</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">🧠 内存占用</div>
    <div class="data-row">
      <span class="label">常驻内存 (RSS)</span>
      <span class="value" id="mem-rss">加载中...</span>
    </div>
    <div class="data-row">
      <span class="label">堆内存使用 (Heap)</span>
      <span class="value" id="mem-used">加载中...</span>
    </div>
    <div class="data-row">
      <span class="label">堆内存总量 (Total)</span>
      <span class="value" id="mem-total">加载中...</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">🔌 连通性测试 (Vyla SDK)</div>
    <div class="data-row">
      <span class="label">VidFast 源解析</span>
      <span class="value" id="test-result" style="color:#6b7280">等待测试...</span>
    </div>
    <button onclick="runTest()" style="margin-top:16px; padding:8px 16px; border-radius:8px; border:1px solid #d1d5db; background:#f9fafb; cursor:pointer; font-size:13px;">手动测试接口</button>
  </div>

  <a href="/configure" class="btn">返回配置页</a>
</div>

<script>
  // 填充基础数据
  const data = ${JSON.stringify(getHealthData())};
  document.getElementById('sys-time').textContent = new Date(data.timestamp).toLocaleString();
  document.getElementById('uptime').textContent = data.uptime;
  document.getElementById('node-ver').textContent = data.node;
  document.getElementById('platform').textContent = data.platform;
  
  document.getElementById('mem-rss').textContent = data.memory.rss;
  document.getElementById('mem-used').textContent = data.memory.heapUsed;
  document.getElementById('mem-total').textContent = data.memory.heapTotal;

  // 测试接口连通性（请求一个已知有效的电影 tt28014327）
  async function runTest() {
    const el = document.getElementById('test-result');
    el.textContent = '测试中...';
    el.style.color = '#f59e0b';
    const start = Date.now();
    try {
      const res = await fetch('/stream/movie/tt28014327.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const count = json.streams ? json.streams.length : 0;
      const ms = Date.now() - start;
      if (count > 0) {
        el.textContent = \`成功 (\${ms}ms) - 提取到 \${count} 个流\`;
        el.style.color = '#10b981';
      } else {
        el.textContent = \`解析成功但无流 (\${ms}ms)\`;
        el.style.color = '#f59e0b';
      }
    } catch (e) {
      el.textContent = '失败: ' + e.message;
      el.style.color = '#ef4444';
    }
  }
  
  // 页面加载后自动跑一次测试
  setTimeout(runTest, 500);
</script>
</body>
</html>`;
}