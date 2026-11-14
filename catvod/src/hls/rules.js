// src/hls/rules.js
// 广告规则加载与编译
// - adRules.json：规则库（按源分组 + 全局广告域名黑名单）
// - sources.json：源配置（每个源的 adRuleGroup 决定用哪组规则）
// - ijk 段仅文档参考，本文件不读取
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AD_RULES_PATH = process.env.AD_RULES_PATH
  || path.resolve(__dirname, "../../config/adRules.json");
const SOURCES_CONFIG_PATH = process.env.SOURCES_CONFIG_PATH
  || path.resolve(__dirname, "../../config/sources.json");

let _rulesCache = null;
let _sourceGroupMap = null;

/**
 * 加载 adRules.json
 * @returns {{ rules: any[], ads: string[] }}
 */
export function loadRules(configPath = AD_RULES_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  _rulesCache = {
    rules: raw.rules || [],
    ads: raw.ads || [],
    // ijk 段不加载（仅文档参考，任何运行路径不得读取）
  };
  log.info(`[rules] loaded ${_rulesCache.rules.length} groups, ${_rulesCache.ads.length} ad domains from ${configPath}`);
  return _rulesCache;
}

export function getRules() {
  return _rulesCache || loadRules();
}

/**
 * 从 sources.json 构建 srcId → adRuleGroup 映射
 * 例：{ bfzy: "暴风", ffzy: "非凡", lz: "量子" }
 * 读取失败时返回空对象（不影响 host 匹配 fallback）
 */
function loadSourceGroupMap() {
  if (_sourceGroupMap) return _sourceGroupMap;
  const map = {};
  try {
    const raw = JSON.parse(fs.readFileSync(SOURCES_CONFIG_PATH, "utf-8"));
    for (const s of raw.sources || []) {
      if (s.id && s.adRuleGroup) map[s.id] = s.adRuleGroup;
    }
    log.debug(`[rules] source→group map: ${JSON.stringify(map)}`);
  } catch (e) {
    log.warn(`[rules] 读取 sources.json 失败，降级为 host 匹配: ${e.message}`);
  }
  _sourceGroupMap = map;
  return map;
}

/** 热重载时清空源映射缓存（sources.json 变更后调用） */
export function invalidateSourceMap() {
  _sourceGroupMap = null;
}

/**
 * A4：host 匹配支持「host + path 前缀」
 * - 含 "/" 的模式（如 "shturl.cc/kw314KJ"）→ 整体字符串 includes
 * - 纯 host 模式 → 主机名精确 / 后缀 / 包含匹配
 */
function matchHost(url, hostPattern) {
  if (hostPattern.includes("/")) {
    return url.includes(hostPattern);
  }
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === hostPattern ||
      hostname.endsWith("." + hostPattern) ||
      hostname.includes(hostPattern)
    );
  } catch {
    return false;
  }
}

/**
 * 查找命中的规则组
 * 优先级：
 *   1. sources.json 里该源的 adRuleGroup（最可靠，避免 host 漂移）
 *   2. host 匹配 fallback（应对 share 解析后 host 变化或未配置 adRuleGroup 的情况）
 * @returns {null | { name?: string, hosts?: string[], host?: string, regex?: string[], rule?: string[] }}
 */
export function findSourceGroup(url, sourceId) {
  const rules = getRules();

  // 1. sourceId → adRuleGroup
  if (sourceId) {
    const map = loadSourceGroupMap();
    const groupName = map[sourceId];
    if (groupName) {
      const g = rules.rules.find((r) => r.name === groupName);
      if (g) return g;
      log.warn(`[rules] sources.json 指定 ${sourceId} → "${groupName}"，但 adRules.json 无此组`);
    }
  }

  // 2. host 匹配 fallback
  for (const g of rules.rules) {
    const hosts = g.hosts || (g.host ? [g.host] : []);
    for (const h of hosts) {
      if (matchHost(url, h)) return g;
    }
  }

  return null;
}

/**
 * 编译单条规则为正则
 * A2 支持：
 *   - 纯数字（"17.19"）：编译为 `#EXTINF:?\s*17\.19[^\n]*\n[^\n]*(?:\n|$)` 整段删片段
 *   - 含 "#" 开头或正则元字符：视为正则表达式
 *   - 纯字面量（"更多"）：命中 #EXTINF 行含该关键词的片段整段删除
 * @returns {RegExp | null}
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
    try {
      return new RegExp(s, "g");
    } catch (e) {
      log.warn(`[rules] invalid regex "${s}": ${e.message}`);
      return null;
    }
  }

  // 纯字面量关键词
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`#EXTINF[^\\n]*${esc}[^\\n]*\\n[^\\n]*(?:\\n|$)`, "g");
}