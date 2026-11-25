// Subtitles：仅返回中文与英文字幕，支持站内 ID 与 IMDb ttid
// 上游：OpenSubtitles v3 镜像（opensubtitles-v3.strem.io）
// 关键：剧集必须走 /subtitles/series/{ttid}:{S}:{E}.json 路径；
//       实测 ?season=1&episode=1 与不带季集的 /ttid.json 均返回 0 条
// 说明：Vidzee/rezesubs 的字幕链接实测一律 403（防盗链），已从上游移除
import { cached } from '../cache.js';
import { getSeriesInfo, getVodInfo } from '../adapter.js';
import { parseId } from '../resolver.js';
import { hashId, yearFromName } from '../helper.js';
import { fetchImdbIdByTmdbId, searchByTitle } from '../tmdb.js';

const OS_V3 = 'https://opensubtitles-v3.strem.io';
const NOOP = { debug() {}, info() {}, warn() {}, error() {} };

async function fetchJson(url, ms = 8000, L = NOOP) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const started = Date.now();
  let label = url;
  try {
    label = new URL(url).pathname;
  } catch {
    // ignore
  }
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'curl/8.7.1' },
    });
    if (!r.ok) {
      L.warn('subtitle', `上游 HTTP ${r.status} ${label} ${Date.now() - started}ms`);
      return null;
    }
    const data = await r.json();
    L.debug('subtitle', `上游 HTTP ${r.status} ${label} ${Date.now() - started}ms`);
    return data;
  } catch (e) {
    L.warn('subtitle', `上游请求失败 ${label}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function langOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  if (/zht|zh-tw|zh_hant|traditional|繁体|chinese-traditional/.test(s)) return 'zht';
  // 词边界匹配，避免把其他语种里偶然出现的 "zh"/"chi" 当成中文；
  // zhe 是 OpenSubtitles 的「简体+英文双语」代码，仍属中文
  if (/(^|[^a-z])(zho|zhe|chi|zh|chinese)([^a-z]|$)|中文|简体|simplified/.test(s)) return 'zho';
  // 不能用宽松 /eng/：Bengali 含 "eng" 会被误判；但需兼容 en-US / English (US)
  if (/^(en|eng|english)([^a-z]|$)|^\s*english\b|英文/.test(s)) return 'eng';
  return '';
}

function labelOf(lang) {
  return lang === 'eng' ? 'English' : lang === 'zht' ? '繁体中文' : '简体中文';
}

async function fromOpenSubtitles(type, imdbId, season, episode, L = NOOP) {
  // OpenSubtitles v3 剧集字幕用路径 :S:E，而不是查询参数
  const episodePath = type === 'series' && season && episode ? `:${season}:${episode}` : '';
  const url = `${OS_V3}/subtitles/${type}/${imdbId}${episodePath}.json`;
  L.debug('subtitle', `查询上游 ${url}`);
  const data = await fetchJson(url, 8000, L);
  const list = Array.isArray(data?.subtitles) ? data.subtitles : [];
  const mapped = list.map((s) => ({
    url: s.url || '',
    lang: langOf(s.lang || s.language),
    source: 'OpenSubtitles',
  }));
  const zhEn = mapped.filter((s) => s.lang).length;
  L.info('subtitle', `上游返回 ${list.length} 条，中英 ${zhEn} 条${episodePath ? `（季集 ${episodePath}）` : '（无季集）'}`);
  return mapped;
}

// 语种白名单：both=中文+英文，zh=仅中文（简+繁），en=仅英文
// 注意：非中英语种在 langOf() 就已被置空，这里再按配置做二次过滤（旧版只排序不过滤）
function langsOf(preference) {
  if (preference === 'zh') return ['zho', 'zht'];
  if (preference === 'en') return ['eng'];
  return ['zho', 'zht', 'eng'];
}

// 同 URL 去重；每种语言最多 3 条；按配置白名单过滤
function curate(list, preference) {
  const allowed = new Set(langsOf(preference));
  const byLang = new Map();
  const seen = new Set();
  for (const s of list) {
    if (!s.url || !allowed.has(s.lang) || seen.has(s.url)) continue;
    seen.add(s.url);
    const bucket = byLang.get(s.lang) || [];
    if (bucket.length < 3) bucket.push(s);
    byLang.set(s.lang, bucket);
  }
  const output = [];
  const order = preference === 'en' ? ['eng'] : preference === 'zh' ? ['zho', 'zht'] : ['zho', 'zht', 'eng'];
  for (const lang of order) {
    for (const s of byLang.get(lang) || []) {
      output.push({
        id: `sub-${lang}-${output.length + 1}`,
        url: s.url,
        lang,
        label: labelOf(lang),
      });
    }
  }
  return output;
}

function imdbIdInText(value) {
  const m = /tt\d{5,10}/i.exec(String(value || ''));
  return m ? m[0] : '';
}

function titleFromFilename(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/[\[\(](?:19|20)\d{2}[\]\)]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stremio / Nuvio 剧集字幕请求 ID 形如 tt0903747:1:1 或 htvb1s16829:1:1
function splitSeasonEpisode(id) {
  const raw = String(id || '');
  const m = /^(.*?):(\d{1,3}):(\d{1,4})$/.exec(raw);
  return {
    base: m ? m[1] : raw,
    season: m ? Number(m[2]) : 0,
    episode: m ? Number(m[3]) : 0,
    hasSuffix: !!m,
  };
}

// 源站 get_vod_info / get_series_info 本身带片名、年份、tmdb_id，无需为了一个条目
// 去拉整个片库（剧集列表首次冷启动实测 15s，客户端字幕请求会直接超时）
function itemFromInfo(data, key) {
  const i = data?.info || {};
  const d = data?.movie_data || {};
  const name = i.name || i.title || d.name || d.title || '';
  return {
    name,
    title: i.title || i.name || d.title || d.name || '',
    year: i.year || String(i.release_date || '').slice(0, 4) || '',
    o_name: i.o_name || d.o_name || '',
    tmdb_id: i.tmdb_id || d.tmdb_id || '',
    imdb_id: i.imdb_id || d.imdb_id || '',
    stream_id: key,
    series_id: key,
    key,
  };
}

// 站内 ID -> IMDb ID：优先用源站详情里的 tmdb_id（葡语片名匹配经常失败）
async function resolveTarget(id, type, config, prefix, extra = {}, L = NOOP) {
  const split = splitSeasonEpisode(id);
  const baseId = split.base;
  let season = split.season;
  let episode = split.episode;

  if (/^tt\d{5,10}$/i.test(baseId)) {
    // 剧集不带季集时上游必然返回 0 条，兜底按第 1 季第 1 集查询
    if (type === 'series' && !season && !episode) {
      season = 1;
      episode = 1;
    }
    const via = split.hasSuffix ? 'ttid:S:E' : 'direct-ttid';
    L.info('subtitle', `ID 解析 imdbId=${baseId} via=${via} season=${season} episode=${episode}`);
    return { imdbId: baseId, season, episode, via };
  }

  const parsed = parseId(baseId);
  if (!parsed || parsed.prefix !== prefix || parsed.kind === 'l') {
    L.warn('subtitle', `ID 解析失败：既不是 ttid 也不是合法站内 ID（${baseId}）`);
    return null;
  }
  L.debug(
    'subtitle',
    `站内 ID 解析 kind=${parsed.kind} key=${parsed.key} seriesId=${parsed.seriesId} episodeId=${parsed.episodeId} extra=${JSON.stringify(extra).slice(0, 160)}`,
  );

  let item;
  let sourceInfo = null;
  if (parsed.kind === 'e' || parsed.kind === 's') {
    const seriesKey = parsed.kind === 'e' ? parsed.seriesId : parsed.key;
    sourceInfo = await getSeriesInfo(config.source, seriesKey);
    const eps = Object.values(sourceInfo?.episodes ?? {}).flat();
    const ep = parsed.kind === 'e' ? eps.find((e) => String(e.id) === String(parsed.episodeId)) : eps[0];
    // 剧集本体没有季集信息：取首集，否则 OpenSubtitles 会返回 0 条
    season = split.season || Number(ep?.season) || (parsed.kind === 's' ? 1 : 0);
    episode = split.episode || Number(ep?.episode_num) || (parsed.kind === 's' ? 1 : 0);
    item = itemFromInfo(sourceInfo, seriesKey);
  } else {
    sourceInfo = await getVodInfo(config.source, parsed.key);
    item = itemFromInfo(sourceInfo, parsed.key);
  }
  if (!item.name && !item.imdb_id && !item.tmdb_id) {
    L.warn('subtitle', `源站详情未返回片名/ID（key=${parsed.key}），无法解析 IMDb ID`);
    return null;
  }
  L.debug('subtitle', `源站详情片名="${item.name}" tmdb_id=${item.tmdb_id || '-'} o_name=${item.o_name || '-'}（未拉取片库列表）`);
  // 剧集必须有季集，否则上游返回 0 条
  if (type === 'series' && (!season || !episode)) {
    season = season || 1;
    episode = episode || 1;
  }

  const result = { imdbId: '', season, episode, via: '' };
  const title = item.title || item.name || '';
  const year = item.year || yearFromName(item.name);
  const kindForLookup = type === 'series' || parsed.kind === 's' || parsed.kind === 'e' ? 'series' : 'movie';
  L.debug('subtitle', `条目片名=${title} 年份=${year} kind=${kindForLookup} season=${season} episode=${episode}`);

  // 站内条目 -> IMDb ID 结果缓存 7 天：详情页与字幕接口共享，避免葡语片名
  // 每次都走「TMDB API + 网页兜底」的冷启动（实测可达 15s，客户端会超时放弃）
  const itemKey = String(item.stream_id ?? item.series_id ?? item.key ?? parsed.key);
  const cacheKey = `sub:imdb:${prefix}:${kindForLookup}:${itemKey}:${hashId(title)}:${config.language}`;
  const resolved = await cached(
    cacheKey,
    7 * 86400000,
    async () => {
      // 1) 条目自带 imdb_id
      const builtin = String(item.imdb_id || item.imdbId || '');
      if (/^tt\d{5,10}$/i.test(builtin)) return { imdbId: builtin, via: 'item-imdb_id' };

      // 2) get_vod_info 的 tmdb_id / 英文原名（电影专用，最可靠）
      if (kindForLookup === 'movie' && config.source.type !== 'm3u') {
        try {
          const vod = sourceInfo || {};
          const tmdbId = item.tmdb_id || vod?.info?.tmdb_id || vod?.movie_data?.tmdb_id;
          if (tmdbId) {
            const fromTmdb = await fetchImdbIdByTmdbId(tmdbId, 'movie', config);
            if (fromTmdb) return { imdbId: fromTmdb, via: `vod-tmdb_id(${tmdbId})` };
          }
          const original = String(item.o_name || vod?.info?.o_name || vod?.movie_data?.o_name || '');
          if (original) {
            const byOriginal = await searchByTitle(original, year, 'movie', config, true);
            if (byOriginal?.imdbId) return { imdbId: String(byOriginal.imdbId), via: `vod-o_name(${original})` };
          }
        } catch (e) {
          L.warn('subtitle', `vod info 兜底失败: ${e.message}`);
        }
      }

      // 3) 葡语片名 / 年份匹配
      const detail = await searchByTitle(title, year, kindForLookup, config, true);
      if (detail?.imdbId) return { imdbId: String(detail.imdbId), via: 'title-search' };

      // 4) 客户端 extra.filename：先取其中的 ttid，再按文件名片名搜索
      if (extra.filename) {
        const fromText = imdbIdInText(extra.filename);
        if (fromText) return { imdbId: fromText, via: 'filename-ttid' };
        const fallbackTitle = titleFromFilename(extra.filename);
        if (fallbackTitle) {
          const byFile = await searchByTitle(fallbackTitle, 0, kindForLookup, config, true);
          if (byFile?.imdbId) return { imdbId: String(byFile.imdbId), via: `filename-title(${fallbackTitle})` };
        }
      }
      return { imdbId: '', via: '' };
    },
    { negativeTtlMs: 3600000 },
  );

  if (!resolved?.imdbId) {
    L.warn('subtitle', `ID 解析未得到 IMDb ID：片名=${title} 年份=${year}（tmdb_id / o_name / 片名 / filename 均未命中）`);
    return result;
  }
  L.info('subtitle', `ID 解析命中 imdbId=${resolved.imdbId} via=${resolved.via}`);
  return { ...result, imdbId: resolved.imdbId, via: resolved.via };
}

export async function handleSubtitle(ctx) {
  const { id, type, config, prefix, addonBase, extra = {} } = ctx;
  const L = ctx.logger || NOOP;
  const preference = config.subtitleLang || 'both';
  L.info(
    'subtitle',
    `开始 type=${type} id=${id} subtitleLang=${preference} extra=${JSON.stringify(extra).slice(0, 160)}`,
  );

  const target = await resolveTarget(id, type, config, prefix, extra, L);
  if (!target?.imdbId) {
    L.warn('subtitle', `结束：未能解析 IMDb ID，返回 0 条字幕`);
    return { subtitles: [], cacheMaxAge: 300 };
  }
  L.info('subtitle', `ID 解析完成 imdbId=${target.imdbId} via=${target.via} season=${target.season} episode=${target.episode}`);

  const key = `sub:${target.imdbId}:${target.season}:${target.episode}:${preference}`;
  const subtitles = await cached(
    key,
    3600000,
    async () => {
      const mediaType = type === 'series' ? 'series' : 'movie';
      let list = await fromOpenSubtitles(mediaType, target.imdbId, target.season, target.episode, L);
      // 季集查询无中英字幕时回退到不带季集的查询（电影/旧版上游兼容）
      if (!list.some((s) => s.lang) && (target.season || target.episode)) {
        L.debug('subtitle', '季集查询无中英，回退全季/无季集查询');
        const fallback = await fromOpenSubtitles(mediaType, target.imdbId, 0, 0, L);
        if (fallback.some((s) => s.lang)) list = fallback;
      }
      const curated = curate(list, preference);
      L.info(
        'subtitle',
        `过滤后 ${curated.length} 条 [${[...new Set(curated.map((s) => s.lang))].join(',') || '无'}]（白名单 ${langsOf(preference).join('/')}）`,
      );
      return curated;
    },
    { negativeTtlMs: 900000 },
  );

  // 默认走 addon 同源代理，规避客户端 UA / 防盗链；可用 subtitleProxy=false 关闭
  const useProxy = config.subtitleProxy !== false && !!addonBase;
  const output = useProxy
    ? subtitles.map((s) => ({
        ...s,
        url: `${addonBase}/api/subtitle?u=${encodeURIComponent(s.url)}`,
      }))
    : subtitles;
  L.info('subtitle', `完成 id=${id} 返回 ${output.length} 条字幕，代理=${useProxy}`);
  return { subtitles: output, cacheMaxAge: 3600 };
}

// 调试模式专用：汇总字幕链路每一步，写入诊断 URL
export async function diagnoseSubtitle(id, type, config, prefix, extra = {}, logger = NOOP) {
  const info = {
    inputId: id,
    imdbId: '',
    season: 0,
    episode: 0,
    upstream: 0,
    kept: 0,
    langs: [],
    usedProxy: config.subtitleProxy !== false,
    subtitleLang: config.subtitleLang || 'both',
    via: '',
    error: '',
  };
  try {
    const target = await resolveTarget(id, type, config, prefix, extra, logger);
    if (!target?.imdbId) {
      info.error = '未能把 ID 解析为 IMDb ID（tmdb_id / 片名 / filename 均未命中）';
      return info;
    }
    info.imdbId = target.imdbId;
    info.via = target.via || '';
    info.season = target.season;
    info.episode = target.episode;
    const mediaType = type === 'series' ? 'series' : 'movie';
    const list = await fromOpenSubtitles(mediaType, target.imdbId, target.season, target.episode, logger);
    info.upstream = list.length;
    const curated = curate(list, config.subtitleLang || 'both');
    info.kept = curated.length;
    info.langs = [...new Set(curated.map((s) => s.lang))];
    if (!curated.length) info.error = '上游有结果但过滤后无中英字幕，或上游本身无中英字幕';
  } catch (e) {
    info.error = e?.message || 'unknown';
  }
  return info;
}
