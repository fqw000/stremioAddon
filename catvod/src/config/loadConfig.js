// 加载 sources.json + 环境变量覆盖
// 环境变量命名规则：<SOURCE_ID>_BASE_URL / <SOURCE_ID>_ENABLED / UA_OVERRIDE
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.SOURCES_CONFIG_PATH
  || path.resolve(__dirname, "../../config/sources.json");

export function loadSourcesConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const ua = process.env.UA_OVERRIDE || raw.ua;

  const sources = raw.sources.map((s) => {
    const key = s.id.toUpperCase();
    const baseUrl = process.env[`${key}_BASE_URL`] || s.baseUrl;
    const enabledEnv = process.env[`${key}_ENABLED`];
    const enabled = enabledEnv === undefined ? s.enabled : enabledEnv === "true";
    return { ...s, baseUrl, enabled, ua };
  });

  return { ua, sources };
}