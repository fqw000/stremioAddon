// 带超时 + 重试 + UA/Referer 的 fetch 包装
// export async function fetchWithRetry(url, { headers = {}, timeoutMs = 8000, retries = 1 } = {}) {
//   let lastErr;
//   for (let attempt = 0; attempt <= retries; attempt++) {
//     const ctrl = new AbortController();
//     const timer = setTimeout(() => ctrl.abort(), timeoutMs);
//     try {
//       const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
//       if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
//       return await res.text();
//     } catch (e) {
//       lastErr = e;
//     } finally {
//       clearTimeout(timer);
//     }
//   }
//   throw lastErr;
// }
import { log } from "../logger.js";

export async function fetchWithRetry(url, { headers = {}, timeoutMs = 8000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      log.info(`=============== ${url} ===============`);
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
      log.info(`[ ☕️ ] 响应状态: ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const text = await res.text();
      log.debug(`[ ☕️ ]  ${attempt+1}/${retries+1}请求成功`);
      return text;
    } catch (e) {
      lastErr = e;
      log.debug(`[ ☕️ ]  ${attempt+1}/${retries+1}请求失败:`, e.message);
    } finally {
      clearTimeout(timer);
    }
  }
  log.error(`[ ☕️ ] 全部重试失败，最后错误：`, lastErr);
  throw lastErr;
}
