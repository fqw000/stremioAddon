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

  return cfg;
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

  updateSummary();
});