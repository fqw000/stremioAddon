/**
 * master playlist 改写：
 *   - 子清单 (.m3u8) → 改写为 /hls?url=<abs>&src=<src>
 *   - 子清单保留父 query（sign）
 *   - 非 m3u8 子资源只做绝对化
 */
export function isMasterPlaylist(text) {
  return text.includes("#EXT-X-STREAM-INF");
}

export function rewriteMaster(text, baseUrl, sourceId, addonBaseUrl) {
  const lines = text.split("\n");
  const out = [];
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();

  for (const line of lines) {
    if (line.startsWith("#") || !line.trim()) {
      out.push(line);
      continue;
    }
    const child = line.trim();
    let abs;
    try { abs = new URL(child, baseUrl); }
    catch { out.push(line); continue; }

    // 保留父 sign 等 query（仅当子清单自身无 query 时）
    if (base?.search && !abs.search) {
      abs.search = base.search;
    }

    if (!/\.m3u8(\?|$)/i.test(abs.pathname + abs.search)) {
      out.push(abs.href);
      continue;
    }

    const params = new URLSearchParams({ url: abs.href });
    if (sourceId) params.set("src", sourceId);
    out.push(`${addonBaseUrl}/hls?${params.toString()}`);
  }
  return out.join("\n");
}