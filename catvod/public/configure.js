function base64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function collectConfig() {
  const cfg = {};

  // 1. 源开关（如果全选就不传，保持默认）
  const sources = [...document.querySelectorAll('#sources input:checked')].map(el => el.value);
  if (sources.length < 3) cfg.sources = sources;

  // 2. 黑名单
  const blacklistText = document.getElementById('blacklist').value.trim();
  if (blacklistText) {
    cfg.blacklist = blacklistText.split('\n').map(s => s.trim()).filter(Boolean);
  }

  // 3. TMDB Key
  const tk = document.getElementById('tmdbKey').value.trim();
  if (tk) cfg.tmdbKey = tk;

  // 4. 调试开关（仅隐藏日志区可见时提供）
  const dbg = document.getElementById('dbg');
  if (dbg && dbg.checked) cfg.dbg = true;

  // 5. 用户标识 uid：所有安装链接都带，全量日志汇总靠它区分不同用户
  cfg.uid = getOrCreateDebugUid();

  return cfg;
}

// 用户标识：8 位随机值，localStorage 持久化；同一浏览器稳定
function getOrCreateDebugUid() {
  try {
    let uid = localStorage.getItem('catvod_dbg_uid');
    if (!uid) {
      uid = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('catvod_dbg_uid', uid);
    }
    return uid;
  } catch (e) {
    return Math.random().toString(36).slice(2, 10);
  }
}

function buildInstallUrl() {
  const cfg = collectConfig();
  const baseUrl = window.location.origin;
  if (Object.keys(cfg).length === 0) return `${baseUrl}/manifest.json`;
  return `${baseUrl}/manifest.json?cfg=${base64urlEncode(JSON.stringify(cfg))}`;
}

function updateSummary() {
  document.getElementById('installUrl').textContent = buildInstallUrl();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[type="text"], input[type="checkbox"], textarea').forEach(el => {
    el.addEventListener('input', updateSummary);
    el.addEventListener('change', updateSummary);
  });

  document.getElementById('copyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(buildInstallUrl());
    const btn = document.getElementById('copyBtn');
    btn.textContent = '✓ 已复制';
    setTimeout(() => btn.textContent = '复制链接', 1500);
  });

  document.getElementById('installBtn').addEventListener('click', () => {
    window.location.href = 'stremio://' + buildInstallUrl().replace(/^https?:\/\//, '');
  });

  // 查看运行日志：带 cfg 只看当前配置；不带 cfg 在页面顶部切换全局视图
  const logsBtn = document.getElementById('logsBtn');
  if (logsBtn) logsBtn.addEventListener('click', () => {
    const cfg = collectConfig();
    const base = window.location.origin;
    const url = Object.keys(cfg).length
      ? `${base}/api/logs?format=html&cfg=${base64urlEncode(JSON.stringify(cfg))}`
      : `${base}/api/logs?format=html`;
    window.open(url, '_blank');
  });

  // 调试入口默认隐藏：连点底部访客统计图标 4 次（5 秒内）显示
  const badge = document.getElementById('visitorBadge');
  const logsSection = document.getElementById('logsSection');
  if (badge && logsSection) {
    let clicks = 0, timer = null;
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', () => {
      clicks += 1;
      clearTimeout(timer);
      timer = setTimeout(() => { clicks = 0; }, 5000);
      if (clicks >= 4) {
        logsSection.style.display = '';
        clearTimeout(timer);
        clicks = 0;
      }
    });
  }

  updateSummary();
});