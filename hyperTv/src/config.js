// 配置层：用户配置（?cfg=base64url） > 环境变量默认 > 代码默认
import { decodeConfig, hashId } from './helper.js';

const BUILTIN_LIVE_RESTRICTED = true;
// 用户提供的可用 Key，作为服务端默认值；配置页/环境变量可覆盖
const BUILTIN_TMDB_KEY = 'e5c3c7269a147fee368c3649ddd98875';
const BUILTIN_TMDB_PROXY = 'https://api.tmdb.org/3';

function baseConfig(sourceType = 'hypetv') {
  return {
    // 内置列表的直播流实测 403（站点声明仅部分账号开放），默认关闭
    source: { type: 'hypetv', listId: '1' },
    catalogs: {
      live: sourceType !== 'hypetv',
      vod: true,
      series: true,
    },
    useProxy: true,
    // TMDB 元数据：用户配置 > 环境变量 > 默认代理（沿用本机其他 addon 的惯例）
    tmdbApiKey: String(
      globalThis.process?.env?.TMDB_API_KEY ||
        globalThis.process?.env?.TMDB_KEY ||
        BUILTIN_TMDB_KEY,
    ),
    tmdbProxy: String(globalThis.process?.env?.TMDB_PROXY || BUILTIN_TMDB_PROXY),
    // 免密代理：代理端已内置 Key，客户端不传 api_key（自定义接口同样支持）
    tmdbKeyless: /^(1|true|yes)$/i.test(String(globalThis.process?.env?.TMDB_KEYLESS || '')),
    language: 'zh-CN',
    enrichCatalog: true,
    // 字幕只保留中文/英文：both | zh | en
    subtitleLang: 'both',
    // 字幕 URL 走 addon 同源代理，规避客户端 UA / 防盗链 403
    subtitleProxy: true,
    // 开发调试模式：仅此模式返回诊断流（含可复制的诊断 URL），默认关闭
    debug: /^(1|true|yes)$/i.test(String(globalThis.process?.env?.HYPETV_DEBUG || '')),
    // 运行日志级别：DEBUG 会在终端强制输出完整链路（含字幕请求、ID 解析、上游结果）
    logLevel: String(globalThis.process?.env?.LOG_LEVEL || 'info').toLowerCase(),
  };
}

export function normalizeConfig(raw) {
  const type = raw?.source?.type;
  const out = baseConfig(type);
  if (!raw || typeof raw !== 'object') return out;

  const s = raw.source;
  if (s && typeof s === 'object') {
    if (s.type === 'hypetv') {
      out.source = { type: 'hypetv', listId: String(s.listId || '1') };
    } else if (s.type === 'xtream' && s.server && s.username !== undefined && s.password !== undefined) {
      out.source = {
        type: 'xtream',
        server: String(s.server).replace(/\/+$/, ''),
        username: String(s.username),
        password: String(s.password),
      };
      out.catalogs.live = true;
    } else if (s.type === 'm3u' && s.url) {
      out.source = { type: 'm3u', url: String(s.url) };
      out.catalogs.live = true;
    }
  }

  if (raw.catalogs && typeof raw.catalogs === 'object') {
    for (const k of ['live', 'vod', 'series']) {
      if (typeof raw.catalogs[k] === 'boolean') out.catalogs[k] = raw.catalogs[k];
    }
  }
  if (typeof raw.useProxy === 'boolean') out.useProxy = raw.useProxy;
  // 空字符串表示「沿用服务端默认 Key」，不清空内置默认值
  if (typeof raw.tmdbApiKey === 'string' && raw.tmdbApiKey.trim()) out.tmdbApiKey = raw.tmdbApiKey.trim();
  if (typeof raw.tmdbProxy === 'string' && /^https?:\/\//i.test(raw.tmdbProxy.trim())) {
    out.tmdbProxy = raw.tmdbProxy.trim().replace(/\/+$/, '');
  }
  if (typeof raw.tmdbKeyless === 'boolean') out.tmdbKeyless = raw.tmdbKeyless;
  if (['zh-CN', 'pt-BR', 'original'].includes(raw.language)) out.language = raw.language;
  if (typeof raw.enrichCatalog === 'boolean') out.enrichCatalog = raw.enrichCatalog;
  if (['both', 'zh', 'en'].includes(raw.subtitleLang)) out.subtitleLang = raw.subtitleLang;
  if (typeof raw.subtitleProxy === 'boolean') out.subtitleProxy = raw.subtitleProxy;
  if (typeof raw.debug === 'boolean') out.debug = raw.debug;
  if (['debug', 'info', 'warn', 'error'].includes(raw.logLevel)) out.logLevel = raw.logLevel;

  return out;
}

export function getConfig(url) {
  const raw = url.searchParams.get('cfg');
  if (!raw) return baseConfig();
  const parsed = decodeConfig(raw);
  return normalizeConfig(parsed);
}

// ID 前缀：仅字母数字，禁止冒号（SOP 红线）
export function getPrefix(config) {
  const s = config.source;
  if (s.type === 'hypetv') {
    const digits = String(s.listId).replace(/\D/g, '');
    return `htvb${digits || hashId(s.listId).slice(0, 6)}`;
  }
  if (s.type === 'xtream') return `htvx${hashId(`${s.server}|${s.username}`).slice(0, 8)}`;
  return `htvm${hashId(s.url).slice(0, 8)}`;
}

export { BUILTIN_LIVE_RESTRICTED };
