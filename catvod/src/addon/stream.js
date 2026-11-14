import { parseItemId } from "./catalog.js";
import { resolveByImdb } from "../metadata/tmdb.js";
import { rankCandidates, DEFAULT_THRESHOLDS } from "../metadata/matcher.js";
import { cachedSearch, cachedDetail } from "../sources/cached.js";
import { parsePlayUrl, isMovie, parseEpisodeNumber } from "../sources/maccmsBase.js";
import { resolveShare } from "../sources/shareResolver.js";
import { log } from "../logger.js";

function parseStreamId(id) {
  const parts = String(id).split(":");
  if (parts.length >= 3) {
    const a = parts[parts.length - 2];
    const b = parts[parts.length - 1];
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      return { baseId: parts.slice(0, -2).join(":"), season: Number(a), episode: Number(b) };
    }
  }
  return { baseId: id, season: null, episode: null };
}

function addonBase(req) {
  if (process.env.ADDON_BASE_URL) return process.env.ADDON_BASE_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function buildCleanUrl(base, m3u8Url, srcId) {
  const p = new URLSearchParams({ url: m3u8Url });
  if (srcId) p.set("src", srcId);
  return `${base}/hls/clean?${p.toString()}`;
}

// 判断某条线路是否命中黑名单
function isBlacklisted(lineName, title, blacklist) {
  if (!Array.isArray(blacklist) || blacklist.length === 0) return false;
  const probe = `${lineName} ${title || ""}`;
  return blacklist.some((kw) => kw && probe.includes(kw));
}

async function resolveOneSource(entry, vodId, opts, addonBaseUrl, blacklist) {
  const { cfg } = entry;
  const srcId = cfg.id;
  const { episode } = opts;

  const item = await cachedDetail(entry, vodId);
  if (!item) return { streams: [], hadNonDirect: false };

  const lines = parsePlayUrl(item.vod_play_from, item.vod_play_url);
  const movie = isMovie(item.type_name, lines[0]?.episodes || []);

  const streams = [];
  let hadNonDirect = false;

  for (const line of lines) {
    // 黑名单过滤：命中就跳过整条线路
    if (isBlacklisted(line.lineName, item.vod_name, blacklist)) {
      log.info(`[stream] 过滤黑名单线路 ${cfg.id}/${line.lineName}`);
      continue;
    }

    const mode = cfg.lines?.[line.lineName]?.mode || "direct";
    const ep = selectEpisode(line.episodes, movie ? null : episode);
    if (!ep) continue;

    let finalUrl = ep.url;
    let nonDirect = false;

    if (mode === "share") {
      const r = await resolveShare(ep.url, {
        ua: cfg.ua, referer: cfg.referer, timeoutMs: cfg.timeoutMs, srcId,
      });
      if (r.ok) finalUrl = r.m3u8;
      else { nonDirect = true; hadNonDirect = true; }
    }

    const playable = !nonDirect && /\.m3u8(\?|$)/i.test(finalUrl);
    const url = playable ? buildCleanUrl(addonBaseUrl, finalUrl, srcId) : finalUrl;

    streams.push({
      name: `${cfg.label}｜${line.lineName}`,
      title: `${item.vod_name}${ep.title ? " " + ep.title : ""}${nonDirect ? " [non-direct]" : ""}`,
      url,
      behaviorHints: playable ? { notWebReady: false } : { notWebReady: true },
    });
  }
  return { streams, hadNonDirect };
}

function selectEpisode(episodes, episode) {
  if (!episodes.length) return null;
  if (!episode) return episodes[0];
  return episodes.find((e) => parseEpisodeNumber(e.title) === episode) || null;
}

async function streamFromInternalId(req, id, { season, episode }, { registry, userConfig }) {
  const parsed = parseItemId(id);
  if (!parsed) return { streams: [] };
  const entry = registry.get(parsed.srcId);
  if (!entry) return { streams: [] };

  const blacklist = userConfig?.blacklist || [];

  try {
    const { streams, hadNonDirect } = await resolveOneSource(
      entry, parsed.vodId, { season, episode }, addonBase(req), blacklist
    );
    log.info(`[stream] internal ${id} → ${streams.length} streams${hadNonDirect ? " (non-direct)" : ""}`);
    return { streams, hadNonDirect };
  } catch (e) {
    log.error(`[stream] internal ${id} failed: ${e.message}`);
    return { streams: [] };
  }
}

async function streamFromImdb(req, imdbId, type, { season, episode }, { registry, userConfig }) {
  const base = addonBase(req);
  const blacklist = userConfig?.blacklist || [];

  const meta = await resolveByImdb(imdbId, type, { season: season || 1, userConfig });
  if (!meta) {
    log.warn(`[stream] imdb ${imdbId} → TMDB unavailable`);
    return { streams: [] };
  }

  const entries = registry.enabled();
  const searches = await Promise.allSettled(
    entries.map(async (entry) => {
      const results = await cachedSearch(entry, meta.name);
      return { entry, results };
    })
  );

  const streams = [];
  const lowCandidates = [];
  let anyNonDirect = false;

  for (const r of searches) {
    if (r.status !== "fulfilled") continue;
    const { entry, results } = r.value;
    if (!results.length) continue;

    const ranked = rankCandidates(meta, results, { thresholds: DEFAULT_THRESHOLDS });
    const high = ranked.filter((x) => x.level === "high");

    if (!high.length) {
      lowCandidates.push(...ranked.slice(0, 3).map((x) => ({
        source: entry.cfg.id,
        vod_id: x.candidate.vod_id,
        vod_name: x.candidate.vod_name,
        score: x.score,
        level: x.level,
      })));
      continue;
    }

    const top = high[0];
    try {
      const one = await resolveOneSource(
        entry, String(top.candidate.vod_id), { season, episode }, base, blacklist
      );
      streams.push(...one.streams);
      if (one.hadNonDirect) anyNonDirect = true;
      log.info(`[stream] imdb ${imdbId} → ${entry.cfg.id} hit "${top.candidate.vod_name}" score=${top.score}`);
    } catch (e) {
      log.error(`[stream] ${entry.cfg.id} detail failed: ${e.message}`);
    }
  }

  if (lowCandidates.length) {
    log.warn(`[stream] imdb ${imdbId} low/medium candidates: ${JSON.stringify(lowCandidates)}`);
  }

  return { streams, anyNonDirect };
}

export async function handleStream({ type, id }, req, { registry, userConfig = {} }) {
  const { baseId, season, episode } = parseStreamId(id);

  let result;
  if (/^[a-z0-9]+:(movie|series):\d+/i.test(baseId)) {
    result = await streamFromInternalId(req, baseId, { season, episode }, { registry, userConfig });
  } else if (/^tt\d+$/.test(baseId)) {
    result = await streamFromImdb(req, baseId, type, { season, episode }, { registry, userConfig });
  } else {
    return { streams: [] };
  }

  return {
    ...result,
    cacheMaxAge: 180,
    staleRevalidate: 60,
    staleError: result.anyNonDirect ? 600 : 180,
  };
}