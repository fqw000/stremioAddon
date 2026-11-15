// src/hls/fetchManifest.js
//
// 拉取 m3u8 清单（带 UA/Referer/超时/重试）
// 关键改动：失败时不吞错误，返回每次尝试的 request/response 细节
//
import { log } from "../logger.js";

/**
 * @returns {Promise<{ ok: boolean, text: string|null, attempts: Array }>}
 * attempts[]: {
 *   attempt: number,
 *   elapsed: ms,
 *   request: { url, method, headers },
 *   response?: { status, ok, headers, bodyHead },
 *   error?: { name, message }
 * }
 */
export async function fetchManifestWithMeta(url, {
  ua,
  referer,
  timeoutMs = 10000,
  retries = 1,
  srcId,
} = {}) {
  // 实际发出的请求头（用于诊断"UA/Referer 是否真的传了"）
  const builtHeaders = { Accept: "*/*" };
  if (ua) builtHeaders["User-Agent"] = ua;
  if (referer) builtHeaders["Referer"] = referer;

  const attempts = [];

  for (let i = 0; i <= retries; i++) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: builtHeaders,
        signal: ctrl.signal,
        redirect: "follow",
      });
      const elapsed = Date.now() - t0;

      const responseHeaders = {};
      for (const [k, v] of res.headers.entries()) responseHeaders[k] = v;

      let text = null;
      let bodyHead = "";

      if (res.ok) {
        text = await res.text();
        bodyHead = text.slice(0, 500);
      } else {
        // 非 2xx：只读前 500 字节，用于展示源站返回的错误页（可能是伪 404 HTML）
        try {
          const clone = res.clone();
          const raw = await clone.text();
          bodyHead = raw.slice(0, 500);
        } catch {}
      }

      attempts.push({
        attempt: i + 1,
        elapsed,
        request: { url, method: "GET", headers: builtHeaders },
        response: {
          status: res.status,
          ok: res.ok,
          headers: responseHeaders,
          bodyHead,
        },
      });

      if (res.ok) {
        return { ok: true, text, attempts };
      }

      log.warn(`[hls] fetch attempt ${i + 1} failed: HTTP ${res.status} ${url}`);
    } catch (e) {
      const elapsed = Date.now() - t0;
      const errName = e.name === "AbortError" ? "timeout" : e.name;
      attempts.push({
        attempt: i + 1,
        elapsed,
        request: { url, method: "GET", headers: builtHeaders },
        error: { name: errName, message: e.message },
      });
      log.warn(`[hls] fetch attempt ${i + 1} failed: ${errName}: ${e.message} ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, text: null, attempts };
}

/**
 * 兼容旧调用：成功返回 text，失败抛错
 */
export async function fetchManifest(url, opts) {
  const r = await fetchManifestWithMeta(url, opts);
  if (!r.ok) {
    const last = r.attempts[r.attempts.length - 1];
    const reason = last?.error
      ? `${last.error.name}: ${last.error.message}`
      : `HTTP ${last?.response?.status}`;
    throw new Error(reason);
  }
  return r.text;
}