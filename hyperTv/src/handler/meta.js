// Meta 详情：站内 ID / IMDb ttid 双格式；合并 Xtream 详情与 TMDB 中文元数据
import { getCatalogItems, getSeriesInfo, getVodInfo } from '../adapter.js';
import { buildId, findItem, isImdbId, parseId } from '../resolver.js';
import { safeExtension, tmdbImage, yearFromName } from '../helper.js';
import { toPreview } from './catalog.js';
import { fetchImdbMeta, resolveImdbToCatalog, searchByTitle } from '../tmdb.js';

function asList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function airDate(info) {
  if (!info || typeof info !== 'object') return '';
  return info.air_date || info.released || info.release_date || '';
}

// 站点详情字段 + TMDB 中文字段统一写入 meta
function mergeDetails(meta, details) {
  if (!details || typeof details !== 'object') return meta;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = details[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const name = pick('original_name', 'originalTitle', 'original_title');
  const desc = pick('overview', 'plot', 'description');
  const genres = pick('genres', 'genre');
  const cast = pick('cast');
  const director = pick('director');
  const runtime = pick('runtime', 'episode_run_time');
  const rating = pick('rating_5based', 'rating_10based', 'vote_average', 'rating');
  const poster = pick('poster', 'cover', 'stream_icon');
  const background = pick('background', 'backdrop_path', 'backdrop');

  if (name) meta.originalName = String(name);
  if (desc) meta.description = String(desc).slice(0, 1500);
  if (genres) meta.genres = asList(genres).slice(0, 8);
  if (cast) meta.cast = asList(cast).slice(0, 16);
  if (director) meta.director = asList(director).slice(0, 8);
  if (runtime) {
    const n = Number(String(runtime).split(',')[0].trim());
    if (Number.isFinite(n) && n > 0) meta.runtime = String(Math.round(n));
  }
  if (poster) meta.poster = tmdbImage(poster, 'w500');
  if (background) meta.background = tmdbImage(background, 'w780');
  if (rating) {
    const n = Number(rating);
    if (Number.isFinite(n) && n > 0) {
      // 站点的 rating_5based 为 5 分制，TMDB/Cinemeta 为 10 分制
      meta.imdbRating = Number((n <= 5 ? n * 2 : n > 10 ? n / 10 : n).toFixed(1));
    }
  }
  return meta;
}

async function applyTmdb(meta, item, kind, config) {
  if (config.language === 'original' || kind === 'live') return;
  const enriched = await searchByTitle(
    item.title || item.name,
    item.year || yearFromName(item.name),
    kind,
    config,
    true,
  );
  if (!enriched?.title) return;
  meta.name = enriched.title;
  if (enriched.originalTitle) meta.originalName = enriched.originalTitle;
  if (enriched.poster) meta.poster = enriched.poster;
  if (enriched.background) meta.background = enriched.background;
  if (enriched.overview) meta.description = enriched.overview;
  if (enriched.year) meta.releaseInfo = String(enriched.year);
  if (enriched.rating) meta.imdbRating = Number(enriched.rating.toFixed(1));
  if (enriched.genres?.length) meta.genres = enriched.genres;
  if (enriched.cast?.length) meta.cast = enriched.cast;
  if (enriched.director?.length) meta.director = enriched.director;
  if (enriched.runtime) meta.runtime = String(enriched.runtime);
  if (enriched.imdbId) {
    meta.imdb_id = enriched.imdbId;
    meta.links = [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${enriched.imdbId}/` }];
    meta.behaviorHints = { ...(meta.behaviorHints || {}), imdbId: enriched.imdbId };
  }
}

function seriesVideos(prefix, item, info) {
  const videos = [];
  for (const [seasonKey, episodes] of Object.entries(info?.episodes ?? {})) {
    for (const ep of episodes ?? []) {
      const ext = safeExtension(ep.container_extension);
      // 实测：container_extension 为空的分集在源站返回 nginx 欢迎页，跳过
      if (!ext && !ep.direct_source) continue;
      const season = Number(ep.season ?? seasonKey) || 1;
      const episode = Number(ep.episode_num) || 0;
      const released = airDate(ep.info);
      const thumb = ep.info?.movie || ep.thumbnail || ep.movie || '';
      videos.push({
        id: buildId(prefix, 'e', String(item.series_id ?? item.stream_id ?? item.key), `${ep.id}_${ext || 'mp4'}`),
        title: ep.title || `第 ${season} 季 第 ${episode} 集`,
        season,
        episode,
        ...(released ? { released } : {}),
        ...(thumb ? { thumbnail: tmdbImage(thumb) } : {}),
        overview: typeof ep.info === 'string' ? ep.info.slice(0, 500) : String(ep.info?.plot || '').slice(0, 500),
      });
    }
  }
  return videos.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

async function buildItemMeta(item, kind, config, prefix, requestedId) {
  const meta = toPreview(item, kind, prefix);
  meta.posterShape = 'poster';
  meta.background = meta.background || tmdbImage(item.backdrop_path || item.backdrop, 'w780');
  meta.description = item.plot || item.overview || meta.description || '';
  meta.genres = asList(item.genre).slice(0, 8);
  if (item.cast) meta.cast = asList(item.cast).slice(0, 16);
  if (item.director) meta.director = asList(item.director).slice(0, 8);
  if (item.episode_run_time) {
    const n = Number(String(item.episode_run_time).split(',')[0].trim());
    if (Number.isFinite(n) && n > 0) meta.runtime = String(Math.round(n));
  }
  if (!meta.releaseInfo) meta.releaseInfo = yearFromName(item.name) || '';

  if (kind === 'movie') {
    const detail = await getVodInfo(config.source, item.stream_id ?? item.key);
    mergeDetails(meta, { ...(detail?.movie_data || {}), ...(detail?.info || {}) });
  } else if (kind === 'series') {
    const info = await getSeriesInfo(config.source, item.series_id ?? item.stream_id);
    mergeDetails(meta, info?.info || {});
    const videos = seriesVideos(prefix, item, info);
    meta.videos = videos;
    if (videos.length) meta.behaviorHints = { ...(meta.behaviorHints || {}), defaultVideoId: videos[0].id };
    meta.seasonCount = Object.keys(info?.episodes ?? {}).length || undefined;
  } else if (kind === 'live') {
    meta.behaviorHints = { defaultVideoId: meta.id };
  }

  await applyTmdb(meta, item, kind, config);
  // ttid 请求保持 id 与请求一致，播放仍走本插件的 ttid 映射
  if (requestedId) meta.id = requestedId;
  return meta;
}

// ttid 未匹配到站内片源时，仍返回可用的标准详情
function imdbMetaObject(imdbId, type, data) {
  const metaType = type === 'series' ? 'series' : 'movie';
  const meta = {
    id: imdbId,
    type: metaType,
    name: data.title,
    originalName: data.originalTitle || '',
    description: data.overview || '',
    releaseInfo: data.year ? String(data.year) : '',
    poster: data.poster || '',
    background: data.background || '',
    imdbRating: data.rating || undefined,
    imdb_id: imdbId,
    posterShape: 'poster',
    links: [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${imdbId}/` }],
    behaviorHints: { imdbId: imdbId },
  };
  if (data.genres?.length) meta.genres = data.genres;
  if (data.cast?.length) meta.cast = data.cast;
  if (data.director?.length) meta.director = data.director;
  if (data.runtime) meta.runtime = String(data.runtime);
  return meta;
}

export async function handleMeta(ctx) {
  const { type, id, config, prefix } = ctx;
  const L = ctx.logger;
  const options = { cacheMaxAge: 300, staleRevalidate: 600, staleError: 300 };

  if (isImdbId(id)) {
    L?.debug('meta', `ttid 请求 ${id}，开始匹配站内片源`);
    const resolved = await resolveImdbToCatalog(id, type, config, prefix);
    L?.info('meta', `ttid ${id} ${resolved ? `命中站内 ${resolved.kind}` : '未命中，返回 TMDB 标准详情'}`);
    if (resolved) {
      return { meta: await buildItemMeta(resolved.item, resolved.kind, config, prefix, id), ...options };
    }
    const data = await fetchImdbMeta(id, type, config, true);
    return { meta: data?.title ? imdbMetaObject(id, type, data) : null, ...options };
  }

  const parsed = parseId(id);
  if (!parsed || parsed.prefix !== prefix) return { meta: null, cacheMaxAge: 120 };

  // 剧集视频 ID 请求 meta 时，回退到所属剧集本体
  const kind = parsed.kind === 'l' ? 'live' : parsed.kind === 'v' ? 'movie' : 'series';
  const key = parsed.kind === 'e' ? parsed.seriesId : parsed.key;
  if (!key) return { meta: null, cacheMaxAge: 120 };

  const items = await getCatalogItems(config.source, kind);
  const item = findItem(items, key, kind);
  if (!item) return { meta: null, cacheMaxAge: 120 };

  return { meta: await buildItemMeta(item, kind, config, prefix, id), ...options };
}
