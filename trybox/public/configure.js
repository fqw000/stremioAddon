/**
 * TryBox 配置页面交互
 *
 * 流程：
 *   用户调整配置 → 实时生成 base64url → 显示安装 URL
 *   用户点击复制/安装 → 使用生成的 URL
 */

// ============================================================
// base64url 编码（支持 UTF-8）
// ============================================================
function base64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ============================================================
// 默认值（与后端 constants.js 保持一致）
// ============================================================
const DEFAULTS = {
  cats: ['topRated', 'movie', 'tv'],
  feats: ['catalog', 'search', 'meta', 'subtitle', 'stream'],
  subLang: 'zh-en',
  removeIdValidation: true,
};

// 页面加载时记录的默认状态（用于判断用户是否改了）
const initialFeats = [...DEFAULTS.feats];
const initialCats = [...DEFAULTS.cats];

// ============================================================
// 收集配置
// ============================================================
function collectConfig() {
  const cfg = {};

  // 认证
  const rt = document.getElementById('rt').value.trim();
  if (rt) cfg.rt = rt;

  const at = document.getElementById('at').value.trim();
  if (at) cfg.at = at;

  // Catalog（用户改动才写入）
  const cats = [...document.querySelectorAll('#cats input:checked')].map(el => el.value);
  if (JSON.stringify(cats.slice().sort()) !== JSON.stringify(initialCats.slice().sort())) {
    cfg.cats = cats;
  }

  // 功能（catalog-meta 开关展开为两个 feature，search 独立）
  const featsUI = [...document.querySelectorAll('#feats input:checked')].map(el => el.value);
  const feats = [];
  if (featsUI.includes('catalog-meta')) {
    feats.push('catalog', 'meta');
  }
  if (featsUI.includes('search')) feats.push('search');
  if (featsUI.includes('subtitle')) feats.push('subtitle');
  if (featsUI.includes('stream')) feats.push('stream');

  if (JSON.stringify(feats.slice().sort()) !== JSON.stringify(initialFeats.slice().sort())) {
    cfg.feats = feats;
  }

  // 字幕语言
  const subLang = document.getElementById('subLang').value;
  if (subLang !== DEFAULTS.subLang) cfg.subLang = subLang;

  // 剔除 ID 校验 URL（默认 true，用户关闭时才写入）
  const removeIdValidation = document.getElementById('removeIdValidation').checked;
  if (removeIdValidation !== DEFAULTS.removeIdValidation) {
    cfg.removeIdValidation = removeIdValidation;
  }

  // TMDB Key
  const tk = document.getElementById('tk').value.trim();
  if (tk) cfg.tk = tk;

  // 用户标识 uid：所有安装链接都带，全量日志汇总靠它区分不同用户
  cfg.uid = getOrCreateDebugUid();

  // debug 开关（仅开启时写入，减小 URL 长度）
  if (document.getElementById('dbg').checked) cfg.dbg = true;

  return cfg;
}

// 用户标识：8 位随机值，localStorage 持久化；所有安装链接都带，用于日志汇总区分用户
function getOrCreateDebugUid() {
  try {
    let uid = localStorage.getItem('trybox_dbg_uid');
    if (!uid) {
      uid = Math.random().toString(36).slice(2, 10);
      localStorage.setItem('trybox_dbg_uid', uid);
    }
    return uid;
  } catch (e) {
    return Math.random().toString(36).slice(2, 10);
  }
}

// ============================================================
// 生成安装 URL
// ============================================================
function buildInstallUrl() {
  const cfg = collectConfig();
  const baseUrl = window.location.origin;

  if (Object.keys(cfg).length === 0) {
    // 无自定义配置 → 直接使用默认 manifest
    return `${baseUrl}/manifest.json`;
  }

  const cfgEncoded = base64urlEncode(JSON.stringify(cfg));
  return `${baseUrl}/manifest.json?cfg=${cfgEncoded}`;
}

// ============================================================
// 更新界面
// ============================================================
function updateSummary() {
  const url = buildInstallUrl();
  document.getElementById('installUrl').textContent = url;
  return url;
}

// ============================================================
// 事件绑定
// ============================================================
function bindEvents() {
  // 所有输入变更 → 实时更新摘要
  document.querySelectorAll('input[type="text"], input[type="checkbox"], select').forEach(el => {
    el.addEventListener('input', updateSummary);
    el.addEventListener('change', updateSummary);
  });

  // 复制按钮
  document.getElementById('copyBtn').addEventListener('click', async () => {
    const url = buildInstallUrl();
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('copyBtn');
      btn.textContent = '✓ 已复制';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '复制链接';
        btn.classList.remove('copied');
      }, 1500);
    } catch (e) {
      // 降级：选中文本
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('installUrl'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      alert('复制失败，请手动复制');
    }
  });

  // 安装按钮
  document.getElementById('installBtn').addEventListener('click', () => {
    const url = buildInstallUrl();
    // 去掉 https:// 前缀，用 stremio:// 协议
    const stremioUrl = 'stremio://' + url.replace(/^https?:\/\//, '');
    window.location.href = stremioUrl;
  });

  // 查看运行日志：带上当前 cfg，确保 scope 与安装地址一致
  const logsBtn = document.getElementById('logsBtn');
  if (logsBtn) logsBtn.addEventListener('click', () => {
    const cfg = collectConfig();
    const baseUrl = window.location.origin;
    const url = Object.keys(cfg).length
      ? `${baseUrl}/api/logs?format=html&cfg=${base64urlEncode(JSON.stringify(cfg))}`
      : `${baseUrl}/api/logs?format=html`;
    window.open(url, '_blank');
  });

  // 调试入口默认隐藏：连续点击底部访客统计图标 4 次（5 秒内）才显示
  bindVisitorUnlock();
}

function bindVisitorUnlock() {
  const badge = document.getElementById('visitorBadge');
  const section = document.getElementById('logsSection');
  if (!badge || !section) return;
  let clicks = 0;
  let timer = null;
  badge.style.cursor = 'pointer';
  badge.addEventListener('click', () => {
    clicks += 1;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 5000); // 5 秒内未完成 4 击则重置
    if (clicks >= 4) {
      section.style.display = '';
      clearTimeout(timer);
      clicks = 0;
    }
  });
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  updateSummary();
});