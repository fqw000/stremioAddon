// cleaner.js  ——  只替换 cleanHls 函数，其余 import/export/工具函数不动
import { filterPlaylist, DEFAULT_RULES } from './filter-playlist.js';   // ← 引入黄金标准核心
import { findSourceGroup, compileRule, getRules } from "./rules.js";
import { fetchManifestWithMeta } from "./fetchManifest.js";
import { isMasterPlaylist, rewriteMaster } from "./master.js";
import { log } from "../logger.js";

export const DEFAULT_HLS_CONFIG = {
  maxReduction: 0.3,
  maxHits: 50,
  enableAdDomains: true,
};

/** ---------- 规则适配器：cleaner 规则 → 核心 DEFAULT_RULES 格式 ---------- */
function adaptCleanerRules(sourceId, url) {
  const cleanerRules = getRules();
  const group = findSourceGroup(url, sourceId);

  // 基础规则 = 核心内置规则（保持与 filter-playlist.js 一致）
  const adapted = {
    globalRegex: [...DEFAULT_RULES.globalRegex],
    globalKeywords: [...DEFAULT_RULES.globalKeywords],
    hostRules: [...DEFAULT_RULES.hostRules],
  };

  // 1. 全局 ads 域名黑名单 → 转为 globalKeywords
  if (cleanerRules.ads?.length) {
    adapted.globalKeywords.push(...cleanerRules.ads);
  }

  // 2. 源分组规则 → 转为 hostRules 或 globalRegex
  if (group) {
    const host = new URL(url).hostname;
    const hostRule = { host, keywords: [], regex: [] };
    for (const raw of group.regex || group.rule || []) {
      try {
        const re = compileRule(raw);
        if (re) hostRule.regex.push(re);
      } catch { /* ignore */ }
    }
    if (hostRule.keywords.length || hostRule.regex.length) {
      adapted.hostRules.push(hostRule);
    }
  }

  return adapted;
}

/** ---------- 主清洗入口（对外签名、返回结构 100% 兼容旧版） ---------- */
export async function cleanHls(url, sourceId, { addonBaseUrl, hlsConfig = {}, sourceCfg = {} }) {
  const cfg = { ...DEFAULT_HLS_CONFIG, ...hlsConfig };
  const startTime = Date.now();

  // ===== fetch 阶段（完全保留原逻辑） =====
  let text, fetchAttempts = [];
  try {
    const r = await fetchManifestWithMeta(url, {
      ua: sourceCfg.ua, referer: sourceCfg.referer, timeoutMs: sourceCfg.timeoutMs,
    });
    fetchAttempts = r.attempts;
    if (!r.ok) {
      const last = r.attempts[r.attempts.length - 1];
      const reasonText = last?.error ? `${last.error.name}: ${last.error.message}` : `HTTP ${last?.response?.status}`;
      log.error(`[hls] fetch failed ${url}: ${reasonText}`);
      return { type: "error", original: "", cleaned: "", hits: [], risk: "high", degraded: true, reason: `fetch-failed: ${reasonText}`, fetchAttempts };
    }
    text = r.text;
  } catch (e) {
    log.error(`[hls] fetch failed ${url}: ${e.message}`);
    return { type: "error", original: "", cleaned: "", hits: [], risk: "high", degraded: true, reason: `fetch-failed: ${e.message}`, fetchAttempts };
  }

  // ===== Master 清单：仅重写，不去广告（保留原逻辑） =====
  if (isMasterPlaylist(text)) {
    return {
      type: "master",
      original: text,
      cleaned: rewriteMaster(text, url, sourceId, addonBaseUrl),
      hits: [], risk: "low", fetchAttempts,
    };
  }

  // ===== Media 清单：调用核心算法 =====
  const adaptedRules = adaptCleanerRules(sourceId, url);
  const coreResult = filterPlaylist(text, url, {
    rules: adaptedRules,
    // 可选：若想贴近 cleaner 原“轻量模式”，可显式关闭部分重检测器
    // useScte: false, useKeyNone: false, useNamingReuse: false, useMirrorReuse: false, useCommentMarker: false,
    // baseThreshold: 0.8,  // 提高阈值减少误杀
  });

  // ===== 结果映射回 cleaner 返回结构 =====
  const hits = coreResult.report.removed.map(r => ({
    rule: r.reasons[0] || 'unknown',
    matched: r.uri,
    removed: 1,
  }));

  // 复用原 detectRisk 做最后一道熔断（保留原风控语义）
  const riskInfo = detectRisk(text, coreResult.body, hits, cfg);

  if (riskInfo.risk === "high") {
    log.warn(`[hls] high risk (${riskInfo.reason}), degrade to original`);
    return {
      type: "media",
      original: text,
      cleaned: absolutizeUris(text, url),   // 保留原 absolutizeUris
      hits, risk: "high", degraded: true, reason: riskInfo.reason, fetchAttempts,
    };
  }

  return {
    type: "media",
    original: text,
    cleaned: absolutizeUris(coreResult.body, url),  // 核心去广告后再做绝对化
    hits,
    risk: riskInfo.risk,
    fetchAttempts,
  };
}

/* ===== 工具函数 ===== */
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
