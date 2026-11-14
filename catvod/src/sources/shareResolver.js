import { fetchWithRetry } from "../utils/http.js";
import { getJSON, setJSON, withInflight } from "../cache/index.js";
import { KEY, TTL, NEG_TTL } from "../cache/ttl.js";
import { log } from "../logger.js";

const URL_VAR_RE = /(?:const\s+url|url)\s*=\s*["']([^"']+?\.m3u8[^"']*)["']/;
const M3U8_RE = /["']([^"']+?\.m3u8[^"']*)["']/;
const ABS_M3U8_RE = /(https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*)/;

export async function resolveShare(shareUrl, { ua, referer, timeoutMs = 10000, srcId } = {}) {
  const cacheKey = srcId ? KEY.share(srcId, shareUrl) : null;

  if (cacheKey) {
    const hit = await getJSON(cacheKey);
    if (hit) {
      log.info(`[cache] hit share ${srcId} ${shareUrl.slice(-12)}`);
      return hit;
    }
  }

  return withInflight(`share:${shareUrl}`, async () => {
    const result = await resolveShareUncached(shareUrl, { ua, referer, timeoutMs });
    if (cacheKey) {
      // 成功 → TTL.STREAM_RESOLVE（3min）
      // 失败 → NEG_TTL.STREAM_403（3min），防止反复打 share 页面
      const ttl = result.ok ? TTL.STREAM_RESOLVE : NEG_TTL.STREAM_403;
      await setJSON(cacheKey, result, ttl);
    }
    return result;
  });
}

async function resolveShareUncached(shareUrl, { ua, referer, timeoutMs }) {
  let origin;
  try { origin = new URL(shareUrl).origin; }
  catch { return { ok: false, error: "invalid share url" }; }

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
