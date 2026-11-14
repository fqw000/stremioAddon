import { log } from "../logger.js";

export async function fetchManifest(url, { ua, referer, timeoutMs = 10000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { Accept: "*/*" };
      if (ua) headers["User-Agent"] = ua;
      if (referer) headers["Referer"] = referer;
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      log.warn(`[hls] fetch attempt ${i + 1} failed: ${e.message} ${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}