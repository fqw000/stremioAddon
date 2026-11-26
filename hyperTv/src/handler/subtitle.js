// Subtitles：仅返回中文与英文字幕，支持站内 ID 与 IMDb ttid
// 上游：OpenSubtitles v3 镜像（opensubtitles-v3.strem.io）
// 关键：剧集必须走 /subtitles/series/{ttid}:{S}:{E}.json 路径；
//       实测 ?season=1&episode=1 与不带季集的 /ttid.json 均返回 0 条
// 说明：Vidzee/rezesubs 的字幕链接实测一律 403（防盗链），已从上游移除
import { cached, peekCache } from '../cache.js';
import { getSeriesInfo, getVodInfo } from '../adapter.js';
import { parseId } from '../resolver.js';
import { hashId, yearFromName } from '../helper.js';
import { loggedFetch } from '../http-log.js';
import { fetchImdbIdByTmdbId, fetchTmdbIdByImdb, searchByTitle } from '../tmdb.js';

const OS_V3 = 'https://opensubtitles-v3.strem.io';
const NOOP = { debug() {}, info() {}, warn() {}, error() {} };

async function fetchJson(url, ms = 8000, L = NOOP, sourceLabel = 'OpenSubtitles') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const started = Date.now();
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // ignore
  }
  try {
    // 完整 URL / 状态 / 响应大小 / 耗时由 loggedFetch 统一记录，带 reqId 便于串联字幕链路
    const r = await loggedFetch(
      url,
      {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': 'curl/8.7.1' },
      },
      { L, tag: 'subtitle', label: sourceLabel },
    );
    if (!r.ok) {
      L.warn('subtitle', `上游 HTTP ${r.status} ${path} ${Date.now() - started}ms`);
      return null;
    }
    return await r.json();
  } catch (e) {
    L.warn('subtitle', `上游请求失败 ${path}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 语种识别 ---------------------------------------------------------------
// 中文写法五花八门：zho/zht/zhe/chi/zh、zh-Hans/zh-Hant、zh-CN/zh-TW/zh-HK/zh-SG、
// cn/hk/tw、Chinese (Traditional)、繁体/简体、chs/cht……全部归一到 BCP-47。
// 输出用 zh-CN / zh-TW / en：客户端（Nuvio 等）按 BCP-47 归一，用 zho/zht 时
// 与「简体中文(zh-CN)」偏好对不上，字幕会被过滤掉（表现为 CC 列表空白）。
const ZH_CODE_RE = /^(zho|zht|zhe|chi|zh|chs|cht|cn|hk|tw|zh[-_]?(hans|hant|cn|tw|hk|sg|mo))$/i;
const EN_CODE_RE = /^(en|eng|english|en[-_]?(us|gb|au))$/i;
const ZH_HANT_RE = /(繁体|繁體|traditional|hant|zh[-_]?(tw|hk|mo)|\bcht\b|chinese[-_ ]?trad|cantonese|粤语|粵語)/i;
const ZH_HANS_RE = /(简体|簡體|simplified|hans|zh[-_]?(cn|sg)|\bchs\b|chinese[-_ ]?simp|mandarin|国语|國語)/i;
// 中英双语：zhe（OpenSubtitles 的「简体+英文」）、中英/简英/繁英/双语、chs&eng 等
const ZH_EN_RE = /(中英|简英|繁英|双语|雙語|bilingual|chs[.\s_-]?eng|cht[.\s_-]?eng|chi[.\s_-]?eng|zh[.\s_-]?en|en[.\s_-]?zh|chinese[.\s_-]?english)/i;

// tier 越小越靠前：0 简英双语 → 1 繁英双语 → 2 简体 → 3 繁体 → 4 英文
function describe(rawCode, hint = '') {
  const code = String(rawCode || '').toLowerCase().trim();
  const text = `${code} ${String(hint || '')}`.toLowerCase();
  if (ZH_CODE_RE.test(code) || /chinese|mandarin|cantonese|中文|简体|繁体|繁體/.test(text)) {
    const hant = ZH_HANT_RE.test(code) || (!ZH_HANS_RE.test(code) && ZH_HANT_RE.test(String(hint || '')));
    const bilingual = code === 'zhe' || ZH_EN_RE.test(code) || ZH_EN_RE.test(String(hint || ''));
    if (bilingual) return { lang: hant ? 'zh-TW' : 'zh-CN', tier: hant ? 1 : 0, label: hant ? '繁英双语' : '简英双语' };
    if (hant) return { lang: 'zh-TW', tier: 3, label: '繁体中文' };
    return { lang: 'zh-CN', tier: 2, label: '简体中文' };
  }
  if (EN_CODE_RE.test(code) || /^english\b|英文/.test(text)) return { lang: 'en', tier: 4, label: 'English' };
  return null;
}

async function fromOpenSubtitles(type, imdbId, season, episode, L = NOOP) {
  // OpenSubtitles v3 剧集字幕用路径 :S:E，而不是查询参数
  const episodePath = type === 'series' && season && episode ? `:${season}:${episode}` : '';
  const url = `${OS_V3}/subtitles/${type}/${imdbId}${episodePath}.json`;
  L.debug('subtitle', `查询上游 ${url}`);
  const data = await fetchJson(url, 8000, L);
  const list = Array.isArray(data?.subtitles) ? data.subtitles : [];
  const mapped = list
    .map((s) => {
      // 文件名里常带「中英」「chs&eng」「traditional」等线索，用于判定双语/简繁
      const info = describe(s.lang || s.language, `${s.subtitleFileName || ''} ${s.movieReleaseName || ''}`);
      return info ? { url: s.url || '', ...info, source: 'OpenSubtitles' } : null;
    })
    .filter(Boolean);
  L.info(
    'subtitle',
    `[OpenSubtitles] 返回 ${list.length} 条，中英 ${mapped.length} 条${episodePath ? `（季集 ${episodePath}）` : '（无季集）'}`,
  );
  return mapped;
}

// 第二字幕源：vidzee（按 TMDB ID 索引，中文字幕更全，文件为 rezesubs 的 .vtt，需带 Referer）
const VIDZEE = 'https://core.vidzee.wtf';
async function fromVidzee(tmdbId, mediaType, season, episode, L = NOOP) {
  const id = Number(tmdbId) || 0;
  if (!id) return [];
  const parts =
    mediaType === 'series' && season && episode
      ? `${VIDZEE}/subs/tv/${id}/${season}/${episode}`
      : `${VIDZEE}/subs/movie/${id}`;
  L.debug('subtitle', `查询上游 ${parts}`);
  // vidzee 偶发抖动（0.5s ~ 超时都有可能）：单次给 9s，结果按 6h 缓存；失败时合并结果只缓存 10 分钟，会自动重试
  const data = await fetchJson(parts, 9000, L, 'Vidzee');
  if (!data) L.warn('subtitle', `Vidzee 未取到字幕（tmdb=${id}），10 分钟后随合并结果重试`);
  const list = Array.isArray(data) ? data : [];
  const mapped = list
    .map((s) => {
      const file = s.file || s.url || '';
      const info = describe(s.label || s.lang, file);
      return file && info ? { url: file, ...info, source: 'Vidzee' } : null;
    })
    .filter(Boolean);
  L.info('subtitle', `[Vidzee] 返回 ${list.length} 条，中英 ${mapped.length} 条（tmdb=${id}）`);
  return mapped;
}

// 只有「不带 Referer 就 403」的字幕文件才需要代理；OpenSubtitles 镜像可直连
const PROXY_HOST_RE = /(^|\.)rezesubs\.com$/i;
export function needsSubtitleProxy(url) {
  try {
    return PROXY_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// 语种白名单：both=中英，zh=仅中文（简+繁），en=仅英文
function allowedLangs(preference) {
  if (preference === 'zh') return new Set(['zh-CN', 'zh-TW']);
  if (preference === 'en') return new Set(['en']);
  return new Set(['zh-CN', 'zh-TW', 'en']);
}
function langsOf(preference) {
  return [...allowedLangs(preference)];
}

// 去重 + 白名单过滤 + 排序：中英双语 > 简体 > 繁体 > 英文
// 每个档位保留上限（旧版每语种 3 条，中文字幕稍多就被裁掉）
const TIER_CAP = { 0: 6, 1: 6, 2: 10, 3: 10, 4: 3 };
const TOTAL_CAP = 24;
function curate(list, preference) {
  const allowed = allowedLangs(preference);
  const seen = new Set();
  const kept = [];
  const perTier = {};
  for (const s of list.slice().sort((a, b) => a.tier - b.tier)) {
    if (!s.url || !allowed.has(s.lang) || seen.has(s.url)) continue;
    seen.add(s.url);
    perTier[s.tier] = (perTier[s.tier] || 0) + 1;
    if (perTier[s.tier] > (TIER_CAP[s.tier] ?? 3)) continue;
    kept.push(s);
    if (kept.length >= TOTAL_CAP) break;
  }
  return kept.map((s, i) => ({ id: `sub-${s.source || 'src'}-${i + 1}`, url: s.url, lang: s.lang, label: s.label }));
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
  // 季集来源优先级：ID 里的 :S:E > 客户端 extra（路径段 / ?season=&episode=）> 源站详情
  let season = split.season || Number(extra.season) || 0;
  let episode = split.episode || Number(extra.episode) || 0;

  if (/^tt\d{5,10}$/i.test(baseId)) {
    // 剧集不带季集时上游必然返回 0 条，兜底按第 1 季第 1 集查询
    if (type === 'series' && !season && !episode) {
      season = 1;
      episode = 1;
    }
    const via = split.hasSuffix ? 'ttid:S:E' : 'direct-ttid';
    L.info('subtitle', `ID 解析 imdbId=${baseId} via=${via} season=${season} episode=${episode}`);
    return { imdbId: baseId, tmdbId: 0, season, episode, via };
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
    season = split.season || Number(extra.season) || Number(ep?.season) || (parsed.kind === 's' ? 1 : 0);
    episode = split.episode || Number(extra.episode) || Number(ep?.episode_num) || (parsed.kind === 's' ? 1 : 0);
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

  const result = { imdbId: '', tmdbId: Number(item.tmdb_id) || 0, season, episode, via: '' };
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

// 字幕主流程（被 /subtitles 与 stream 内嵌字幕共用）
// 返回 { subtitles: [{id,url,lang,label}]（未加代理）, diag: {imdbId, upstream, kept, langs, cached} }
export async function collectSubtitles(ctx) {
  const { id, type, config, prefix, extra = {} } = ctx;
  const L = ctx.logger || NOOP;
  const preference = config.subtitleLang || 'both';
  const diag = {
    inputId: id,
    imdbId: '',
    tmdbId: 0,
    via: '',
    season: 0,
    episode: 0,
    upstream: 0,
    kept: 0,
    langs: [],
    cached: false,
    error: '',
  };

  L.section(`字幕 · ID 解析（${type} ${id}）`, {
    id,
    type,
    subtitleLang: preference,
    extra: JSON.stringify(extra).slice(0, 200),
  });
  const target = await resolveTarget(id, type, config, prefix, extra, L);
  if (!target?.imdbId) {
    diag.error = '未能解析 IMDb ID';
    L.warn('subtitle', '结束：未能解析 IMDb ID，返回 0 条字幕');
    return { subtitles: [], diag };
  }
  diag.imdbId = target.imdbId;
  diag.via = target.via || '';
  diag.season = target.season;
  diag.episode = target.episode;
  L.info('subtitle', `ID 解析完成 imdbId=${target.imdbId} via=${target.via} season=${target.season} episode=${target.episode}`);

  const key = `sub:${target.imdbId}:${target.season}:${target.episode}:${preference}`;
  const mediaType = type === 'series' ? 'series' : 'movie';
  const episodePath = mediaType === 'series' && target.season && target.episode ? `:${target.season}:${target.episode}` : '';
  // vidzee 按 TMDB ID 取字幕（中文字幕更全）；站内条目自带 tmdb_id，ttid 请求则反查一次（缓存 7 天）
  let tmdbId = Number(target.tmdbId) || 0;
  if (!tmdbId) {
    try {
      tmdbId = await fetchTmdbIdByImdb(target.imdbId, mediaType, config);
    } catch (e) {
      L.warn('subtitle', `TMDB ID 反查失败: ${e.message}`);
    }
  }
  diag.tmdbId = tmdbId;
  diag.cached = peekCache(key);
  if (diag.cached) {
    L.info('subtitle', `命中本地缓存（60 分钟），跳过上游 ${OS_V3}/subtitles/${mediaType}/${target.imdbId}${episodePath}.json`);
  } else {
    L.section(`字幕 · 上游查询（OpenSubtitles + Vidzee）`, {
      upstream: [
        `${OS_V3}/subtitles/${mediaType}/${target.imdbId}${episodePath}.json`,
        tmdbId ? `${VIDZEE}/subs/${mediaType === 'series' ? `tv/${tmdbId}/${target.season}/${target.episode}` : `movie/${tmdbId}`}` : '（无 TMDB ID，跳过 Vidzee）',
      ].join(' + '),
      imdbId: target.imdbId,
      tmdbId: tmdbId || '-',
      season: target.season,
      episode: target.episode,
      白名单: langsOf(preference).join('/'),
    });
  }

  // 合并结果缓存 10 分钟（源结果各自缓存更久）：vidzee 偶发慢/超时时，10 分钟后会自动重试补上中文
  const subtitles = await cached(
    key,
    600000,
    async () => {
      const osKey = `sub:os:${target.imdbId}:${target.season}:${target.episode}`;
      const vzKey = `sub:vz:${tmdbId}:${target.season}:${target.episode}`;
      // 两个字幕源并发查询，任一方失败不影响另一方；源结果分别长缓存（OS 1h / Vidzee 6h）
      const fetchOs = async () => {
        let list = await fromOpenSubtitles(mediaType, target.imdbId, target.season, target.episode, L);
        // 季集查询无中英字幕时回退到不带季集的查询（电影/旧版上游兼容）
        if (!list.length && (target.season || target.episode)) {
          L.debug('subtitle', '季集查询无中英，回退全季/无季集查询');
          list = await fromOpenSubtitles(mediaType, target.imdbId, 0, 0, L);
        }
        return list;
      };
      // 内嵌字幕（/stream）不能等 vidzee 的 9s：只在它已缓存时复用，冷启动由客户端随后的 /subtitles 补齐
      const vzAllowed = tmdbId && (!ctx.embed || peekCache(vzKey));
      const [osList, vzList] = await Promise.all([
        cached(osKey, 3600000, fetchOs, { negativeTtlMs: 900000 }).then((v) => v ?? []),
        vzAllowed
          ? cached(vzKey, 6 * 3600000, () => fromVidzee(tmdbId, mediaType, target.season, target.episode, L), {
              negativeTtlMs: 120000,
            }).then((v) => v ?? [])
          : [],
      ]);
      const list = [...osList, ...vzList];
      diag.upstream = list.length;
      const curated = curate(list, preference);
      const perLang = curated.reduce((acc, s) => {
        acc[s.lang] = (acc[s.lang] || 0) + 1;
        return acc;
      }, {});
      L.info(
        'subtitle',
        `过滤后 ${curated.length} 条 ${JSON.stringify(perLang)}（OpenSubtitles ${osList.length} + Vidzee ${vzList.length} 条，白名单 ${langsOf(preference).join('/')}）`,
      );
      return curated;
    },
    { negativeTtlMs: 180000 },
  );

  diag.kept = subtitles.length;
  diag.langs = [...new Set(subtitles.map((s) => s.lang))];
  if (!subtitles.length) diag.error = '上游无中英字幕，或全部被白名单过滤';
  return { subtitles, diag };
}

export async function handleSubtitle(ctx) {
  const { id, config, addonBase } = ctx;
  const L = ctx.logger || NOOP;
  L.info('subtitle', `开始 id=${id} subtitleLang=${config.subtitleLang || 'both'}`);

  const { subtitles, diag } = await collectSubtitles(ctx);
  // 仅对需要 Referer 的源（vidzee/rezesubs）走同源代理，其余直连；subtitleProxy=false 全部直连
  const useProxy = config.subtitleProxy !== false && !!addonBase;
  let proxied = 0;
  const output = subtitles.map((s) => {
    if (!useProxy || !needsSubtitleProxy(s.url)) return s;
    proxied += 1;
    return { ...s, url: `${addonBase}/api/subtitle?u=${encodeURIComponent(s.url)}` };
  });
  L.info(
    'subtitle',
    `完成 id=${id} 返回 ${output.length} 条字幕（${diag.langs.join(',') || '无'}），代理=${proxied} 条${diag.cached ? '，来自缓存' : ''}`,
  );
  return { subtitles: output, cacheMaxAge: 3600, diag };
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
    let tmdbId = Number(target.tmdbId) || 0;
    if (!tmdbId) tmdbId = await fetchTmdbIdByImdb(target.imdbId, mediaType, config).catch(() => 0);
    info.tmdbId = tmdbId;
    const [osList, vzList] = await Promise.all([
      fromOpenSubtitles(mediaType, target.imdbId, target.season, target.episode, logger),
      fromVidzee(tmdbId, mediaType, target.season, target.episode, logger),
    ]);
    const list = [...osList, ...vzList];
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
