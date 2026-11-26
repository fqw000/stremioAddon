// 底层 API 适配：原生 fetch + 超时 + inflight 去重 + 缓存（SOP 阶段一/五）
import { HYPETV_BASE, HYPETV_KEY, hashId, cleanUrl, log } from './helper.js';
import { cached } from './cache.js';
import { loggedFetch } from './http-log.js';

const DEFAULT_TIMEOUT = 25000;

async function request(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeout ?? DEFAULT_TIMEOUT);
  try {
    const r = await loggedFetch(
      url,
      {
        method: options.method ?? 'GET',
        headers: { accept: '*/*', ...(options.headers ?? {}) },
        body: options.body,
        signal: ctrl.signal,
      },
      { tag: 'upstream', label: '源站 API' },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options) {
  const r = await request(url, options);
  return r.json();
}

async function fetchText(url, options) {
  const r = await request(url, options);
  return r.text();
}

export function getJson(url, ttlMs = 300000, options = {}) {
  const key = `http:${hashId(url)}`;
  return cached(key, ttlMs, () => fetchJson(url, options.fetchOptions), { l2: !!options.l2 });
}

export function getText(url, ttlMs = 300000, options = {}) {
  const key = `http:${hashId(url)}`;
  return cached(key, ttlMs, () => fetchText(url, options.fetchOptions), { l2: !!options.l2 });
}

export function getBuiltinLists() {
  return getJson(`${HYPETV_BASE}/api/lists`, 600000, { l2: true }).catch(() => [
    { id: '1', name: 'Minha lista' },
  ]);
}

export function xtreamBase(source) {
  // 新版站点：内置列表统一走 /api/x/k/{key}/{listId}，旧 /api/x/{id} 已 404
  if (source.type === 'hypetv') {
    const key = encodeURIComponent(source.key || HYPETV_KEY);
    const listId = encodeURIComponent(source.listId || '1');
    return `${HYPETV_BASE}/api/x/k/${key}/${listId}`;
  }
  return String(source.server).replace(/\/+$/, '');
}

function credentials(source) {
  if (source.type === 'hypetv') return { username: '-', password: '-' };
  return { username: source.username, password: source.password };
}

export function playerApiUrl(source, action, extra = {}) {
  const { username, password } = credentials(source);
  const params = new URLSearchParams({
    username,
    password,
    ...(action ? { action } : {}),
    ...extra,
  });
  return `${xtreamBase(source)}/player_api.php?${params.toString()}`;
}

export function xtreamApi(source, action, extra = {}, ttlMs = 600000, useL2 = false) {
  return getJson(playerApiUrl(source, action, extra), ttlMs, { l2: useL2 });
}

export function getAccountInfo(source) {
  return xtreamApi(source, null, {}, 3600000, false);
}

export async function getVodInfo(source, vodId) {
  try {
    const data = await xtreamApi(source, 'get_vod_info', { vod_id: String(vodId) }, 600000, true);
    return data && typeof data === 'object' ? data : { info: {}, movie_data: {} };
  } catch (e) {
    log('adapter', `vod info ${vodId} failed: ${e.message}`);
    return { info: {}, movie_data: {} };
  }
}

export async function getSeriesInfo(source, seriesId) {
  try {
    const data = await xtreamApi(source, 'get_series_info', { series_id: String(seriesId) }, 600000, true);
    return data && typeof data === 'object' ? data : { episodes: {} };
  } catch (e) {
    log('adapter', `series info ${seriesId} failed: ${e.message}`);
    return { episodes: {} };
  }
}

// M3U 解析：#EXTINF 属性 -> 名称/台标/分组/请求头
export function parseM3U(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  let current = null;

  const commit = (url) => {
    if (!current || !url || !/^https?:\/\//i.test(url)) {
      current = null;
      return;
    }
    items.push({
      key: hashId(url),
      stream_id: hashId(url),
      name: current.name || url.split('/').pop(),
      group: current.group || 'Sem categoria',
      category_name: current.group || 'Sem categoria',
      stream_icon: current.logo || '',
      headers: current.headers || {},
      playUrl: cleanUrl(url),
    });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice(8);
      const comma = rest.lastIndexOf(',');
      const attrPart = comma >= 0 ? rest.slice(0, comma) : rest;
      const namePart = comma >= 0 ? rest.slice(comma + 1).trim() : '';
      const attrs = {};
      for (const m of attrPart.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      current = {
        name: namePart || attrs['tvg-name'] || '',
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
        tvgId: attrs['tvg-id'] || '',
        headers: {},
      };
      continue;
    }
    if (line.startsWith('#EXTGRP:') && current) {
      current.group = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:') && current) {
      const [k, ...rest] = line.slice(11).split('=');
      const v = rest.join('=').trim();
      if (/http-user-agent/i.test(k)) current.headers.ua = v;
      if (/http-referrer/i.test(k)) current.headers.ref = v;
      continue;
    }
    if (line && !line.startsWith('#')) commit(line);
  }
  return items;
}

export async function getCatalogItems(source, kind) {
  if (source.type === 'm3u') {
    const target = `${HYPETV_BASE}/api/fetch?u=${encodeURIComponent(source.url)}`;
    const text = await getText(target, 600000);
    log.info(`🌐 [请求 路径]： `,target);

    return parseM3U(text || '');
  }
  const action =
    kind === 'live' ? 'get_live_streams' : kind === 'movie' ? 'get_vod_streams' : 'get_series';
  const ttl = kind === 'live' ? 600000 : 1800000;
  try {
    const data = await xtreamApi(source, action, {}, ttl, false);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log('adapter', `${action} failed: ${e.message}`);
    return [];
  }
}

// 生成播放地址（前端 Vl()/Da.url() 的服务端等价实现）
export async function buildPlayUrl(source, kind, item, extras = {}) {
  if (source.type === 'm3u') {
    return { url: cleanUrl(item.playUrl ?? item.url ?? ''), alt: [], headers: item.headers ?? {}, ext: '' };
  }

  const { username, password } = credentials(source);
  const base = xtreamBase(source);
  const u = encodeURIComponent(username);
  const p = encodeURIComponent(password);
  const id = item.stream_id ?? item.id;

  if (kind === 'live') {
    let fmt = 'm3u8';
    let altFmt = 'ts';
    if (source.type === 'xtream') {
      try {
        const info = await getAccountInfo(source);
        const formats = info?.user_info?.allowed_output_formats;
        if (Array.isArray(formats) && formats.length) {
          fmt = formats.includes('m3u8') ? 'm3u8' : formats[0];
          altFmt = formats.find((f) => f !== fmt && /^(m3u8|ts)$/.test(f)) || 'ts';
        }
      } catch {
        // 账号信息获取失败时保持默认 m3u8
      }
    }
    return {
      url: `${base}/live/${u}/${p}/${id}.${fmt}`,
      alt: [`${base}/live/${u}/${p}/${id}.${altFmt}`],
      headers: {},
      ext: fmt,
    };
  }

  if (kind === 'movie') {
    const ext = item.container_extension || 'mp4';
    return { url: `${base}/movie/${u}/${p}/${id}.${ext}`, alt: [], headers: {}, ext };
  }

  // series 分集
  const ext = extras.ext || item.container_extension || 'mp4';
  return {
    url: `${base}/series/${u}/${p}/${extras.episodeId ?? id}.${ext}`,
    alt: [],
    headers: {},
    ext,
  };
}

// 通过 HypeTv 同源代理转发，解决 HTTPS/CORS 与请求头透传
export function proxyUrl(target, headers = {}) {
  if (!target || !/^https?:\/\//i.test(target)) return '';
  const params = new URLSearchParams({ u: cleanUrl(target) });
  if (headers.ua) params.set('ua', String(headers.ua));
  if (headers.ref) params.set('ref', String(headers.ref));
  return `${HYPETV_BASE}/api/stream?${params.toString()}`;
}
