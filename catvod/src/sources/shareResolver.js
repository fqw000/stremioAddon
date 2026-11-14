// share 页面 → 真实 m3u8 URL
// 探针确认：ffzy / lz 的 share 页面均在 <script> 中有 m3u8 相对路径
// 通用策略：优先匹配 url 变量，回退匹配 .m3u8 字符串
import { fetchWithRetry } from "../utils/http.js";

const URL_VAR_RE = /(?:const\s+url|url)\s*=\s*["']([^"']+?\.m3u8[^"']*)["']/;
const M3U8_RE = /["']([^"']+?\.m3u8[^"']*)["']/;
const ABS_M3U8_RE = /(https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*)/;

/**
 * @param {string} shareUrl 形如 https://vip.ffzy-online2.com/share/xxx
 * @param {{ ua:string, referer:string, timeoutMs?:number }} opts
 * @returns {Promise<{ ok:boolean, m3u8?:string, error?:string }>}
 */
export async function resolveShare(shareUrl, { ua, referer, timeoutMs = 10000 }) {
  let origin;
  try {
    origin = new URL(shareUrl).origin;
  } catch {
    return { ok: false, error: "invalid share url" };
  }

  let html;
  try {
    html = await fetchWithRetry(shareUrl, {
      headers: { "User-Agent": ua, Referer: referer, Accept: "text/html,*/*" },
      timeoutMs,
      retries: 1,
    });
  } catch (e) {
    return { ok: false, error: `fetch share failed: ${e.message}` };
  }

  const candidate =
    html.match(URL_VAR_RE)?.[1] ||
    html.match(M3U8_RE)?.[1] ||
    html.match(ABS_M3U8_RE)?.[1];

  if (!candidate) return { ok: false, error: "no m3u8 candidate in share html" };

  const m3u8 = candidate.startsWith("http") ? candidate : origin + candidate;
  return { ok: true, m3u8 };
}