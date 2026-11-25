/**
 * 配置合并
 * 从 URL ?cfg= 参数解码用户配置，与代码默认值合并
 * 环境变量提供基础设施默认值（REFRESH_TOKEN / BARK_KEY / TMDB_KEY 等）
 */

import { DEFAULTS } from './constants.js';

export function decodeCfg(cfgParam) {
  if (!cfgParam) return {};
  try {
    let b64 = cfgParam.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = atob(b64);
    return JSON.parse(json);
  } catch (e) {
    return {};
  }
}

export function mergeConfig(user = {}, env = {}) {
  return {
    refreshToken: user.rt || env.REFRESH_TOKEN || DEFAULTS.REFRESH_TOKEN,
    accessToken: user.at || env.ACCESS_TOKEN || DEFAULTS.ACCESS_TOKEN,
    tmdbKey: user.tk || env.TMDB_KEY || '',
    enabledCatalogs: user.cats || DEFAULTS.ENABLED_CATALOGS,
    enabledFeatures: user.feats || DEFAULTS.ENABLED_FEATURES,
    lang: user.lang || DEFAULTS.LANG,

    // 字幕首选语言：'zh' | 'en' | 'zh-en'
    subtitleLang: user.subLang || DEFAULTS.SUBTITLE_LANG,

    // 剔除 IP 绑定 URL：布尔类，用户显式 false 优先，否则默认 true
    removeIdValidation: user.removeIdValidation !== false,

    // 调试模式：开启后该请求的 debug 级日志写入服务器，可在 /api/logs 实时查看
    debug: user.dbg === true || false,
  };
}

export function getConfigFromRequest(request, env = {}) {
  const url = new URL(request.url);
  const cfgParam = url.searchParams.get('cfg');
  const user = decodeCfg(cfgParam);
  return mergeConfig(user, env);
}
