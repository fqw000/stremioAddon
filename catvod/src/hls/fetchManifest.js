// src/hls/fetchManifest.js
//
// 拉取 m3u8 清单（带 UA/Referer/超时/重试）
//
// 三层降级策略（按优先级）：
//   1. 直连源站（原有逻辑，一字不动）
//   2. 直连失败 → 走代理（MANIFEST_PROXY_URL）
//   3. 代理也失败 → 返回 ok:false，/hls 会 307 重定向到原始 URL
//
// 代理配置：
//   MANIFEST_PROXY_URL=https://hls.wangqifei.eu.org
//   代理接口：GET {PROXY}/hls?url=<encoded>&referer=<...>&ua=<...>
//   （hls_proxy 同时保留 /m3u 别名；路径可用 MANIFEST_PROXY_PATH 覆盖）
//   代理侧从 query 读取 referer/ua，再带给源站。
//
// 每次尝试的 request/response 细节都记录到 attempts，便于诊断。
//
import { log } from "../logger.js";

const MANIFEST_PROXY = (process.env.MANIFEST_PROXY_URL || "").replace(/\/$/, "");
const MANIFEST_PROXY_PATH = (process.env.MANIFEST_PROXY_PATH || "/hls").replace(/\/$/, "");
const USE_PROXY = Boolean(MANIFEST_PROXY);

/** 校验响应内容是否是合法 m3u8 */
function isM3U8Text(text) {
  return typeof text === "string" && text.trimStart().startsWith("#EXTM3U");
}

/** 构造代理 URL：UA/Referer 放 query，代理会带给源站 */
function buildProxyUrl(targetUrl, { ua, referer }) {
  const params = new URLSearchParams();
  params.set("url", targetUrl);
  if (referer) params.set("referer", referer);
  if (ua) params.set("ua", ua);
  const p = MANIFEST_PROXY_PATH.startsWith("/") ? MANIFEST_PROXY_PATH : "/" + MANIFEST_PROXY_PATH;
  return `${MANIFEST_PROXY}${p}?${params.toString()}`;
}

/** 代理模式的请求头：UA/Referer 已在 query 里，这里只带 Accept */
function buildProxyHeaders() {
  return { Accept: "*/*" };
}

/** 直连模式的请求头：原有逻辑 */
function buildDirectHeaders({ ua, referer }) {
  const h = { Accept: "*/*" };
  if (ua) h["User-Agent"] = ua;
  if (referer) h["Referer"] = referer;
  return h;
}

/**
 * 单阶段尝试（内部带重试）
 * @returns {Promise<{ ok: boolean, text: string|null }>}
 * 每次尝试 push 到外部 attempts 数组
 */
async function tryFetchStage({
  targetUrl,
  requestHeaders,
  stage,           // "direct" | "proxy"
  timeoutMs,
  retries,
  attempts,
}) {
  for (let i = 0; i <= retries; i++) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(targetUrl, {
        headers: requestHeaders,
        signal: ctrl.signal,
        redirect: "follow",
      });
      const elapsed = Date.now() - t0;

      const responseHeaders = {};
      for (const [k, v] of res.headers.entries()) responseHeaders[k] = v;

      // ===== 2xx 但内容非 m3u8：视为失败 =====
      if (res.ok) {
        const text = await res.text();
        if (isM3U8Text(text)) {
          attempts.push({
            attempt: i + 1,
            elapsed,
            stage,
            viaProxy: stage === "proxy",
            request: { url: targetUrl, method: "GET", headers: requestHeaders },
            response: {
              status: res.status,
              ok: true,
              headers: responseHeaders,
              bodyHead: text.slice(0, 500),
            },
          });
          return { ok: true, text };
        }
        attempts.push({
          attempt: i + 1,
          elapsed,
          stage,
          viaProxy: stage === "proxy",
          request: { url: targetUrl, method: "GET", headers: requestHeaders },
          response: {
            status: res.status,
            ok: false,
            headers: responseHeaders,
            bodyHead: text.slice(0, 500),
            note: "200-but-not-m3u8",
          },
        });
        log.warn(`[hls][${stage}] attempt ${i + 1}: 200 但非 m3u8 ${targetUrl}`);
        continue;
      }

      // 非 2xx
      let bodyHead = "";
      try {
        const raw = await res.clone().text();
        bodyHead = raw.slice(0, 500);
      } catch {}

      attempts.push({
        attempt: i + 1,
        elapsed,
        stage,
        viaProxy: stage === "proxy",
        request: { url: targetUrl, method: "GET", headers: requestHeaders },
        response: {
          status: res.status,
          ok: false,
          headers: responseHeaders,
          bodyHead,
        },
      });
      log.warn(`[hls][${stage}] attempt ${i + 1} failed: HTTP ${res.status} ${targetUrl}`);
    } catch (e) {
      const elapsed = Date.now() - t0;
      const errName = e.name === "AbortError" ? "timeout" : e.name;
      attempts.push({
        attempt: i + 1,
        elapsed,
        stage,
        viaProxy: stage === "proxy",
        request: { url: targetUrl, method: "GET", headers: requestHeaders },
        error: { name: errName, message: e.message },
      });
      log.warn(`[hls][${stage}] attempt ${i + 1} failed: ${errName}: ${e.message} ${targetUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, text: null };
}

/**
 * 拉清单主流程：直连优先 → 代理降级 → 返回 ok:false
 * @returns {Promise<{ ok: boolean, text: string|null, attempts: Array, viaProxy: boolean }>}
 */
export async function fetchManifestWithMeta(url, {
  ua,
  referer,
  timeoutMs = 10000,
  retries = 1,
  srcId,
} = {}) {
  const attempts = [];

  // ===== 第 1 层：直连（原有逻辑，首选）=====
  const directResult = await tryFetchStage({
    targetUrl: url,
    requestHeaders: buildDirectHeaders({ ua, referer }),
    stage: "direct",
    timeoutMs,
    retries,
    attempts,
  });
  if (directResult.ok) {
    return { ok: true, text: directResult.text, attempts, viaProxy: false };
  }

  // ===== 第 2 层：直连失败 → 代理降级 =====
  if (USE_PROXY) {
    log.warn(`[hls] 直连失败，降级走代理 ${srcId || "?"} ${url}`);
    const proxyResult = await tryFetchStage({
      targetUrl: buildProxyUrl(url, { ua, referer }),
      requestHeaders: buildProxyHeaders(),
      stage: "proxy",
      timeoutMs,
      retries,
      attempts,
    });
    if (proxyResult.ok) {
      return { ok: true, text: proxyResult.text, attempts, viaProxy: true };
    }
    log.warn(`[hls] 代理也失败 ${srcId || "?"} ${url}`);
  }

  // ===== 第 3 层交给 /hls：ok:false → 307 重定向 =====
  return { ok: false, text: null, attempts, viaProxy: USE_PROXY };
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
      : last?.response?.note === "200-but-not-m3u8"
        ? "200 但非 m3u8"
        : `HTTP ${last?.response?.status}`;
    throw new Error(reason);
  }
  return r.text;
}