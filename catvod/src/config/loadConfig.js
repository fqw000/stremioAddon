// 加载 sources.json + 环境变量覆盖 + 用户 cfg 覆盖
// 环境变量命名：<SOURCE_ID>_BASE_URL / <SOURCE_ID>_ENABLED / UA_OVERRIDE
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.SOURCES_CONFIG_PATH
  || path.resolve(__dirname, "../../config/sources.json");

// 模块级缓存：只读一次文件（Vercel fs 只读且慢）
let _rawCache = null;
function getRawConfig() {
  if (!_rawCache) {
    _rawCache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  }
  return _rawCache;
}

/**
 * @param {object} userConfig 从 URL ?cfg=base64url 解析出的用户配置
 *   - userConfig.sources: string[] 启用的源 id 列表；缺省全部启用
 */
export function loadSourcesConfig(userConfig = {}) {
  const raw = getRawConfig();
  const ua = process.env.UA_OVERRIDE || raw.ua;
  const userSources = Array.isArray(userConfig.sources) ? userConfig.sources : null;

  const sources = raw.sources.map((s) => {
    const key = s.id.toUpperCase();
    const baseUrl = process.env[`${key}_BASE_URL`] || s.baseUrl;
    const enabledEnv = process.env[`${key}_ENABLED`];

    let enabled = enabledEnv === undefined ? s.enabled : enabledEnv === "true";
    // 用户配置优先级最高
    if (userSources) enabled = userSources.includes(s.id);

    return { ...s, baseUrl, enabled, ua };
  });

  return { ua, sources };
}