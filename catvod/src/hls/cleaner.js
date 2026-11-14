import { findSourceGroup, compileRule, getRules } from "./rules.js";
import { fetchManifest } from "./fetchManifest.js";
import { isMasterPlaylist, rewriteMaster } from "./master.js";
import { log } from "../logger.js";

export const DEFAULT_HLS_CONFIG = {
  maxReduction: 0.3,         // 片段减少 > 30% 判高风险
  maxHits: 50,               // 单次命中 > 50 条判中风险
  enableAdDomains: true,
};

export function countSegments(text) {
  let n = 0;
  for (const line of text.split("\n")) if (line.startsWith("#EXTINF")) n++;
  return n;
}

/** A3：ads 黑名单行级删除（仅删含黑名单 URI 的片段/标签） */
export function removeAdSegments(text, adList) {
  if (!adList?.length) return { text, hits: [] };
  const out = [];
  const hits = [];
  for (const line of text.split("\n")) {
    // 标签 URI 属性
    const m = line.match(/URI="([^"]+)"/);
    if (m && adList.some((ad) => m[1].includes(ad))) {
      hits.push(m[1]);
      continue;
    }
    // 媒体 URI 行
    if (!line.startsWith("#") && line.trim() && adList.some((ad) => line.includes(ad))) {
      hits.push(line);
      if (out.length && out[out.length - 1].startsWith("#EXTINF")) out.pop();
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), hits };
}

/** 媒体 URI 绝对化（含 #EXT-X-KEY 的 URI 属性） */
export function absolutizeUris(text, baseUrl) {
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  if (!base) return text;
  const out = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) {
        try {
          const abs = new URL(m[1], base).href;
          out.push(line.replace(`"${m[1]}"`, `"${abs}"`));
          continue;
        } catch {}
      }
      out.push(line);
    } else if (line.trim()) {
      try { out.push(new URL(line.trim(), base).href); }
      catch { out.push(line); }
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function detectRisk(original, cleaned, hits, config) {
  const before = countSegments(original);
  const after = countSegments(cleaned);
  if (before === 0) return { risk: "low", reason: "no-segments" };
  if (after === 0) return { risk: "high", reason: "all-removed", before, after };
  const reduction = (before - after) / before;
  if (reduction > config.maxReduction) {
    return { risk: "high", reason: `reduction=${(reduction * 100).toFixed(1)}%`, before, after };
  }
  if (hits.length > config.maxHits) {
    return { risk: "medium", reason: `hits=${hits.length}` };
  }
  return { risk: "low", before, after };
}

/**
 * 主清洗入口
 * @returns {Promise<{
 *   type: "master"|"media"|"error",
 *   original: string, cleaned: string,
 *   hits: any[], risk: "low"|"medium"|"high",
 *   degraded?: boolean, reason?: string
 * }>}
 */
export async function cleanHls(url, sourceId, { addonBaseUrl, hlsConfig = {}, sourceCfg = {} }) {
  const cfg = { ...DEFAULT_HLS_CONFIG, ...hlsConfig };
  const rules = getRules();

  let text;
  try {
    text = await fetchManifest(url, {
      ua: sourceCfg.ua,
      referer: sourceCfg.referer,
      timeoutMs: sourceCfg.timeoutMs,
    });
  } catch (e) {
    log.error(`[hls] fetch failed ${url}: ${e.message}`);
    return { type: "error", original: "", cleaned: "", hits: [], risk: "high", degraded: true, reason: `fetch-failed: ${e.message}` };
  }

  if (isMasterPlaylist(text)) {
    return {
      type: "master",
      original: text,
      cleaned: rewriteMaster(text, url, sourceId, addonBaseUrl),
      hits: [],
      risk: "low",
    };
  }

  // media playlist
  const group = findSourceGroup(url, sourceId);
  let cleaned = text;
  const hits = [];

  if (group) {
    const rulesArr = group.regex || group.rule || [];
    for (const raw of rulesArr) {
      const re = compileRule(raw);
      if (!re) continue;
      const before = cleaned;
      cleaned = cleaned.replace(re, "");
      if (before !== cleaned) {
        const removed = countSegments(before) - countSegments(cleaned);
        hits.push({ rule: raw, removed });
        log.debug(`[hls] hit rule "${raw}", removed ${removed} segments`);
      }
    }
  } else {
    log.warn(`[hls] no rules group matched for ${url} (src=${sourceId})`);
  }

  if (cfg.enableAdDomains) {
    const r = removeAdSegments(cleaned, rules.ads);
    cleaned = r.text;
    if (r.hits.length) {
      hits.push({ rule: "ads-domains", matched: r.hits });
      log.debug(`[hls] ads domains hit ${r.hits.length}`);
    }
  }

  cleaned = absolutizeUris(cleaned, url);

  const risk = detectRisk(text, cleaned, hits, cfg);
  if (risk.risk === "high") {
    log.warn(`[hls] high risk (${risk.reason}), degrade to original`);
    return {
      type: "media",
      original: text,
      cleaned: absolutizeUris(text, url),
      hits,
      risk: "high",
      degraded: true,
      reason: risk.reason,
    };
  }

  return { type: "media", original: text, cleaned, hits, risk: risk.risk };
}