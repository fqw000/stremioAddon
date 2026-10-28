/**
 * 配置页交互
 * 
 * 流程：
 *   用户调整 → 实时生成 cfg base64url → 显示安装 URL
 */

// ============================================================
// 默认值（与 src/config.js 保持一致）
// ============================================================
const DEFAULT_CATS = ['movie', 'series', 'anime', 'variety', 'short'];

// ============================================================
// base64url 编码（UTF-8 安全）
// ============================================================
function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// ============================================================
// 收集配置
// ============================================================
function collectConfig() {
    const cfg = {};

    // 1. cats（只有在非默认时才写入）
    const cats = [...document.querySelectorAll('#cats input:checked')].map(el => el.value);
    const catsSorted = [...cats].sort();
    const defaultSorted = [...DEFAULT_CATS].sort();
    if (JSON.stringify(catsSorted) !== JSON.stringify(defaultSorted)) {
        cfg.cats = cats;
    }

    // 2. hl（hideEncrypted，默认 true，用户取消才写 false）
    const hl = document.getElementById('hl').checked;
    if (hl === false) {
        cfg.hl = false;
    }

    // 3. lines（黑名单）
    const linesRaw = document.getElementById('lines').value.trim();
    if (linesRaw) {
        const lines = linesRaw.split(/[,，\s]+/).filter(s => s);
        if (lines.length > 0) {
            cfg.lines = lines;
        }
    }

    // 4. tk（TMDB Key）
    const tk = document.getElementById('tk').value.trim();
    if (tk) {
        cfg.tk = tk;
    }

    return cfg;
}

// ============================================================
// 生成安装 URL
// ============================================================
function buildInstallUrl() {
    const cfg = collectConfig();
    const baseUrl = window.location.origin;

    // 空配置 → 纯 manifest URL
    if (Object.keys(cfg).length === 0) {
        return `${baseUrl}/manifest.json`;
    }

    return `${baseUrl}/manifest.json?cfg=${b64urlEncode(JSON.stringify(cfg))}`;
}

// ============================================================
// 更新摘要
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
    // 所有输入变化 → 实时更新
    document.querySelectorAll('input[type="text"], input[type="checkbox"]').forEach(el => {
        el.addEventListener('input', updateSummary);
        el.addEventListener('change', updateSummary);
    });

    // 复制按钮
    document.getElementById('copyBtn').addEventListener('click', async () => {
        const url = buildInstallUrl();
        try {
            await navigator.clipboard.writeText(url);
            const btn = document.getElementById('copyBtn');
            const original = btn.textContent;
            btn.textContent = '✓ 已复制';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = original;
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
        const stremioUrl = 'stremio://' + url.replace(/^https?:\/\//, '');
        window.location.href = stremioUrl;
    });
}

// ============================================================
// 初始化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    updateSummary();
});