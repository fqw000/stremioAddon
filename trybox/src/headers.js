// packages/src/headers.js

/**
 * 构建 API 请求头（无认证字段，用于 catalog/search/meta/subtitle）
 * 严格遵循探针验证的最轻请求头
 */
export function buildApiHeaders(lang = 'zh-CN') {
  const h = {};
  h['accept'] = 'application/x-tss-framed, application/x-ndjson, application/json';
  h['accept-language'] = 'en-CN,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,en-GB;q=0.6,en-US;q=0.5';
  h['cache-control'] = 'no-cache';
  h['pragma'] = 'no-cache';
  h['referer'] = 'https://trybox.app/';
  h['user-agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  h['x-trybox-lang'] = lang;
  return h;
}

/**
 * 构建 Stream 请求头（含认证字段，严格按 curl 顺序）
 */
export function buildStreamHeaders(accessToken, lang = 'zh-CN') {
  const h = {};
  h['accept'] = 'application/x-tss-framed, application/x-ndjson, application/json';
  h['accept-language'] = 'en-CN,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,en-GB;q=0.6,en-US;q=0.5';
  if (accessToken) h['authorization'] = `Bearer ${accessToken}`;
  h['cache-control'] = 'no-cache';
  h['dnt'] = '1';
  h['pragma'] = 'no-cache';
  h['priority'] = 'u=1, i';
  h['referer'] = 'https://trybox.app/';
  h['sec-ch-ua'] = '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"';
  h['sec-ch-ua-mobile'] = '?0';
  h['sec-ch-ua-platform'] = '"macOS"';
  h['sec-fetch-dest'] = 'empty';
  h['sec-fetch-mode'] = 'cors';
  h['sec-fetch-site'] = 'same-origin';
  h['user-agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  h['x-trybox-lang'] = lang;
  if (accessToken) h['x-tsr-serverfn'] = 'true';
  return h;
}