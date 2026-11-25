// Catalog / Search：统一分页 100，按配置返回直播/电影/剧集
import { getCatalogItems } from '../adapter.js';
import { normalizeText, yearFromName, tmdbImage } from '../helper.js';
import { buildId } from '../resolver.js';
import { matchInCatalog, resolveImdbToCatalog, searchByTitle, searchTmdbMulti, tmdbEnabled } from '../tmdb.js';
import { chineseEnabled } from '../tmdb-web.js';

const KIND_BY_TYPE = { channel: 'live', movie: 'movie', series: 'series' };
const PAGE_SIZE = 100;

function rating10(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Number((n * 2).toFixed(1)) : undefined;
}

export function toPreview(item, kind, prefix) {
  if (kind === 'live') {
    return {
      id: buildId(prefix, 'l', String(item.stream_id ?? item.key)),
      type: 'channel',
      name: item.name || item.title || 'Sem nome',
      poster: item.stream_icon || item.stream_icon_url || '',
      description: item.group || item.category_name || '',
      releaseInfo: item.epg_channel_id || '',
    };
  }
  if (kind === 'movie') {
    return {
      id: buildId(prefix, 'v', String(item.stream_id ?? item.key)),
      type: 'movie',
      posterShape: 'poster',
      name: item.title || item.name || 'Sem nome',
      poster: item.stream_icon || '',
      description: item.plot ? String(item.plot).slice(0, 300) : '',
      releaseInfo: item.year || yearFromName(item.name) || '',
      imdbRating: rating10(item.rating_5based ?? item.rating),
    };
  }
  return {
    id: buildId(prefix, 's', String(item.series_id ?? item.key)),
    type: 'series',
    posterShape: 'poster',
    name: item.title || item.name || 'Sem nome',
    poster: item.cover || item.stream_icon || '',
    description: item.plot ? String(item.plot).slice(0, 300) : '',
    releaseInfo: item.year || item.release_date?.slice(0, 4) || yearFromName(item.name) || '',
    imdbRating: rating10(item.rating_5based ?? item.rating),
    background: tmdbImage(item.backdrop_path || item.backdrop, 'w780'),
  };
}

export async function handleCatalog(ctx) {
  const { type, catalogId, extra = {}, config, prefix } = ctx;
  const L = ctx.logger;
  const kind = KIND_BY_TYPE[type];
  const configKey = kind === 'movie' ? 'vod' : kind;
  if (!kind || !config.catalogs[configKey] || catalogId !== `htv_${kind}`) {
    L?.debug('catalog', `跳过 type=${type} catalogId=${catalogId}（目录未启用或 id 不匹配）`);
    return { metas: [], cacheMaxAge: 60 };
  }

  const items = await getCatalogItems(config.source, kind);
  const rawQuery = String(extra.search || '').trim();
  const query = normalizeText(rawQuery);
  const matched = query ? await searchItems(rawQuery, query, items, kind, config, prefix) : items;

  const skip = Math.max(0, Number.parseInt(extra.skip, 10) || 0);
  const slice = matched.slice(skip, skip + PAGE_SIZE);
  const metas = slice.map((item) => toPreview(item, kind, prefix));
  L?.debug('catalog', `源站 ${items.length} 条，搜索词="${rawQuery || '-'}"，命中 ${matched.length} 条，返回 ${slice.length} 条`);
  await enrichMetas(metas, slice, kind, config, L);
  L?.info('catalog', `type=${type} 返回 ${metas.length} 条${rawQuery ? `（搜索：${rawQuery}）` : ''}`);

  return { metas, cacheMaxAge: 300, staleRevalidate: 600, staleError: 300 };
}

// 搜索：站内原名 -> IMDb ID -> TMDB 中文/原名反查，三路结果合并去重
async function searchItems(rawQuery, normalizedQuery, items, kind, config, prefix) {
  const found = new Map();
  const put = (item) => {
    if (!item) return;
    const key = String(item.stream_id ?? item.series_id ?? item.key);
    if (key && !found.has(key)) found.set(key, item);
  };

  for (const item of items) {
    const hay = normalizeText(
      [item.name, item.title, item.group, item.category_name, item.stream_id, item.series_id]
        .filter(Boolean)
        .join(' '),
    );
    if (hay.includes(normalizedQuery) || normalizeText(item.year || '').includes(normalizedQuery)) put(item);
  }

  if (/^tt\d{5,10}$/i.test(rawQuery)) {
    const resolved = await resolveImdbToCatalog(
      rawQuery,
      kind === 'series' ? 'series' : 'movie',
      config,
      prefix,
    );
    if (resolved?.kind === kind) put(resolved.item);
  }

  if ((tmdbEnabled(config) || chineseEnabled(config)) && kind !== 'live') {
    const candidates = await searchTmdbMulti(rawQuery, kind, config, 8);
    const indexKey = `${prefix}:${kind}:${items.length}`;
    for (const candidate of candidates) {
      put(await matchInCatalog(items, candidate, kind, indexKey));
    }
  }
  return [...found.values()];
}

// 中文标题/简介/海报补齐：TMDB API 或网页版（免密）均可；并行 + 总超时，失败保留原站数据
const ENRICH_LIMIT = 30;
const ENRICH_DEADLINE_MS = 15000;
// 并发 6 会在短时间内对 TMDB 网页兜底发出大量请求并触发 403 限流，降到 3
const ENRICH_CONCURRENCY = 3;

function applyEnrichment(meta, enriched) {
  meta.name = enriched.title;
  // 中文页面取到的海报/背景，替换站点原有的非中文海报
  if (enriched.poster) meta.poster = enriched.poster;
  if (enriched.background) meta.background = enriched.background;
  if (enriched.overview) meta.description = enriched.overview.slice(0, 300);
  if (enriched.year) meta.releaseInfo = String(enriched.year);
  if (enriched.rating) meta.imdbRating = Number(enriched.rating.toFixed(1));
  if (enriched.imdbId) meta.behaviorHints = { ...(meta.behaviorHints || {}), imdbId: enriched.imdbId };
}

async function enrichMetas(metas, items, kind, config, L) {
  if (!chineseEnabled(config) || !config.enrichCatalog || config.language === 'original' || kind === 'live') return;
  const deadline = Date.now() + ENRICH_DEADLINE_MS;
  const total = Math.min(metas.length, items.length, ENRICH_LIMIT);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (Date.now() < deadline) {
      const i = cursor++;
      if (i >= total) return;
      const item = items[i];
      try {
        const enriched = await searchByTitle(
          item.title || item.name,
          item.year || yearFromName(item.name),
          kind,
          config,
          false,
        );
        if (enriched?.title) {
          applyEnrichment(metas[i], enriched);
          done += 1;
        }
      } catch {
        // 单条失败不影响整页
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, total) }, worker));
  L?.info('catalog', `中文元数据补强 ${done}/${total} 条`);
}
