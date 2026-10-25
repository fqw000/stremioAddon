// ==UserScript==
// @name         Trybox Token Capture & Push
// @namespace    https://trybox.app/
// @version      1.0
// @description  捕获 sb-trybox-auth-token 并推送到 Upstash
// @match        https://trybox.app/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      upstash.io
// ==/UserScript==

// console测试是否生效：
// localStorage.setItem('sb-trybox-auth-token', JSON.stringify({
//   access_token: 'eyJh……U51dHoTWcNDg',
//   refresh_token: '5efh……sw'
// }));



(function () {
  'use strict';

  // ========== 配置区 ==========
  const UPSTASH_URL = 'https://***********.upstash.io';
  const UPSTASH_TOKEN = 'gQ………………………………5Nw';
  const APP_PREFIX = 'tryboxStream:dev';
  const TARGET_KEY = 'sb-trybox-auth-token';
  const AUTO_PUSH = true;
  // ============================

  console.log('✅ Trybox localStorage 钩子已挂载');

  /**
   * 推送 token 到 Upstash
   */
  async function pushToUpstash(accessToken, refreshToken) {
    if (!accessToken || !refreshToken) {
      throw new Error('access_token 或 refresh_token 为空');
    }

    const body = JSON.stringify([
      ['SET', `${APP_PREFIX}:token:access`, accessToken],
    //   refresh 为一次性token,使用一次及失效，使用端在使用时会获取并推送新的值，这里不能推送的原因是会把失效的token覆盖其他服务推送的新refreshtoken
      ['SET', `${APP_PREFIX}:token:refresh`, refreshToken],
    ]);

    // 用 GM_xmlhttpRequest 绕过 CORS
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${UPSTASH_URL}/pipeline`,
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        data: body,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const data = JSON.parse(res.responseText);
              // 检查每条命令结果
              const errors = data.filter((item) => item.error);
              if (errors.length) {
                reject(new Error(`Redis 命令失败: ${JSON.stringify(errors)}`));
              } else {
                resolve(data);
              }
            } catch (e) {
              reject(new Error(`解析响应失败: ${res.responseText}`));
            }
          } else {
            reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
          }
        },
        onerror: (err) => reject(new Error(`请求失败: ${err}`)),
        ontimeout: () => reject(new Error('请求超时')),
        timeout: 15000,
      });
    });
  }

  /**
   * 处理捕获到的 token
   */
 async function handleToken(accessToken, refreshToken, source = 'auto') {
  const out = `access_token:\n${accessToken}\n\nrefresh_token:\n${refreshToken}`;

  console.log(`==== [${source}] 捕获的 Token ====`);
  console.log('access_token:', accessToken);
  console.log('refresh_token:', refreshToken);

  // 复制到剪贴板
  try {
    GM_setClipboard(out);
  } catch (e) {
    console.warn('复制到剪贴板失败', e);
  }

  // 弹窗显示结果
  showTokenPanel(accessToken, refreshToken, source);

  // 自动推送
  if (AUTO_PUSH) {
    try {
      await pushToUpstash(accessToken, refreshToken);
      console.log('✅ 已推送到 Upstash');
      showToast(`✅ [${source}] Token 已捕获并推送`);
    } catch (err) {
      console.error('❌ 推送失败:', err);
      showToast(`⚠️ 推送失败: ${err.message}`, true);
    }
  } else {
    showToast(`✅ [${source}] Token 已捕获（未推送）`);
  }
}

  /**
   * 简易提示条，避免 alert 阻塞
   */
  function showToast(msg, isError = false) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '9999999',
      padding: '10px 16px',
      background: isError ? '#ff4d4f' : '#52c41a',
      color: '#fff',
      borderRadius: '6px',
      fontSize: '13px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      transition: 'opacity 0.3s',
    });
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

    /**
 * 显示 Token 结果面板（可复制、可关闭）
 */
function showTokenPanel(accessToken, refreshToken, source = 'auto') {
  // 避免重复面板，先移除旧的
  const old = document.getElementById('trybox-token-panel');
  if (old) old.remove();

  const panel = document.createElement('div');
  panel.id = 'trybox-token-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    top: '60px',
    right: '20px',
    zIndex: '9999999',
    width: '420px',
    maxHeight: '70vh',
    overflow: 'auto',
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #444',
    borderRadius: '8px',
    padding: '12px',
    fontSize: '12px',
    fontFamily: 'monospace',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  });

  // 标题栏
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    color: '#fff',
    fontWeight: 'bold',
  });
  header.textContent = `[${source}] Token 捕获结果`;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'transparent',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
  });
  closeBtn.onclick = () => panel.remove();
  header.appendChild(closeBtn);

  // 内容
  const content = document.createElement('div');
  content.textContent =
    `access_token:\n${accessToken}\n\nrefresh_token:\n${refreshToken}`;

  // 复制按钮
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '复制全部';
  Object.assign(copyBtn.style, {
    marginTop: '10px',
    padding: '6px 10px',
    background: '#1677ff',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  });
  copyBtn.onclick = () => {
    const text = `access_token:\n${accessToken}\n\nrefresh_token:\n${refreshToken}`;
    try {
      GM_setClipboard(text);
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => (copyBtn.textContent = '复制全部'), 1500);
    } catch (e) {
      alert('复制失败，请手动选择文本复制');
    }
  };

  panel.appendChild(header);
  panel.appendChild(content);
  panel.appendChild(copyBtn);
  document.body.appendChild(panel);
}

  // ========== 1. 重写 setItem ==========
  const originalSetItem = localStorage.setItem;

  localStorage.setItem = function (key, value) {
    originalSetItem.call(localStorage, key, value);

    if (key === TARGET_KEY) {
      console.log('🔔 捕获到 sb-trybox-auth-token 更新！');
      try {
        const authObj = JSON.parse(value);
        const { access_token, refresh_token } = authObj;
        handleToken(access_token, refresh_token, 'auto');
      } catch (err) {
        console.error('❌ JSON 解析失败', err, value);
        showToast('❌ JSON 解析失败，查看控制台', true);
      }
    }
  };

  // ========== 2. 手动读取兜底 ==========
  function getCurrentToken() {
    const rawStr = localStorage.getItem(TARGET_KEY);
    if (!rawStr) {
      showToast('❌ 当前 localStorage 无 ' + TARGET_KEY, true);
      return;
    }
    try {
      const authObj = JSON.parse(rawStr);
      const { access_token, refresh_token } = authObj;
      console.log('==== 手动读取 Token ====');
      handleToken(access_token, refresh_token, 'manual');
    } catch (err) {
      console.error('❌ JSON 解析失败', err, rawStr);
      showToast('❌ JSON 解析失败，查看控制台', true);
    }
  }

  // ========== 3. 悬浮按钮 ==========
  const btn = document.createElement('button');
  btn.innerText = 'Get Trybox Tokens';
  Object.assign(btn.style, {
    position: 'fixed',
    top: '100px',
    right: '20px',
    zIndex: '999999',
    padding: '8px 12px',
    background: '#1677ff',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
  });
  document.body.appendChild(btn);
  btn.onclick = getCurrentToken;
})();
