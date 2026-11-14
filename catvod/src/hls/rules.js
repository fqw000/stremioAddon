import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, "../../config/adRules.json");

// sourceId → rules 分组名（host 匹配失败时的兜底）
const SOURCE_TO_GROUP = { bfzy: "暴风", ffzy: "非凡", lz: "量子" };

let cache = null;

export function loadRules(configPath = process.env.AD_RULES_PATH || DEFAULT_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  cache = {
    rules: raw.rules || [],
    ads: raw.ads || [],
    // ijk 不加载（仅文档参考）
  };
  log.info(`[rules] loaded ${cache.rules.length} groups, ${cache.ads.length} ad domains from ${configPath}`);
  return cache;
}

export function getRules() {
  return cache || loadRules();
}

/** A4：host 匹配支持「host + path 前缀」 */
function matchHost(url, hostPattern) {
  if (hostPattern.includes("/")) {
    return url.includes(hostPattern);
  }
  try {
    const hostname = new URL(url).hostname;
    return hostname === hostPattern || hostname.endsWith("." + hostPattern) || hostname.includes(hostPattern);
  } catch {
    return false;
  }
}

/**
 * 查找命中的规则组
 * 优先 sourceId → 组名映射（因 bfzy/lz share 解析后 host 不含特征）
 * fallback host 匹配
 */
export function findSourceGroup(url, sourceId) {
  const rules = getRules();

  if (sourceId && SOURCE_TO_GROUP[sourceId]) {
    const name = SOURCE_TO_GROUP[sourceId];
    const g = rules.rules.find((r) => r.name === name);
    if (g) return g;
  }

  for (const g of rules.rules) {
    const hosts = g.hosts || (g.host ? [g.host] : []);
    for (const h of hosts) {
      if (matchHost(url, h)) return g;
    }
  }
  return null;
}

/**
 * 编译单条规则
 *  - 纯数字（"17.19"）：A2 → `#EXTINF:?17\.19` 片段整段删除
 *  - 含正则元字符或 # 开头：视为正则
 *  - 纯字面量（"更多"）：命中 #EXTINF 行即删片段
 */
export function compileRule(raw) {
  const s = String(raw).trim();
  if (!s) return null;

  // 纯数字时长
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const esc = s.replace(/\./g, "\\.");
    return new RegExp(`#EXTINF:\\s*${esc}[^\\n]*\\n[^\\n]*(?:\\n|$)`, "g");
  }

  // 正则表达式
  if (s.startsWith("#") || /[\\*+?()[\]{}|^$]/.test(s)) {
    try { return new RegExp(s, "g"); }
    catch (e) { log.warn(`[rules] invalid regex "${s}": ${e.message}`); return null; }
  }

  // 字面量关键词 → 命中 #EXTINF 行
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`#EXTINF[^\\n]*${esc}[^\\n]*\\n[^\\n]*(?:\\n|$)`, "g");
}