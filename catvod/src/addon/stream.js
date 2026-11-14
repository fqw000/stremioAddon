import { parseItemId } from "./catalog.js";
import { resolveByImdb } from "../metadata/tmdb.js";
import { rankCandidates, DEFAULT_THRESHOLDS } from "../metadata/matcher.js";
import { maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../sources/maccmsBase.js";
import { resolveShare } from "../sources/shareResolver.js";
import { log } from "../logger.js";

/** Stremio 的 series stream id 格式：baseId:season:episode */
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

/** 单源解析 → [{ name, title, url, behaviorHints }] */
async function resolveOneSource(entry, vodId, opts, addonBaseUrl) {
  const { srcId, adapter, cfg } = entry;
  const { season, episode } = opts;

  const item = await maccmsDetail(cfg, vodId);
  if (!item) return [];

  const lines = parsePlayUrl(item.vod_play_from, item.vod_play_url);
  const movie = isMovie(item.type_name, lines[0]?.episodes || []);

  const streams = [];
  for (const line of lines) {
    const mode = cfg.lines?.[line.lineName]?.mode || "direct";
    const ep = selectEpisode(line.episodes, movie ? null : episode);
    if (!ep) continue;

    let finalUrl = ep.url;
    let nonDirect = false;

    if (mode === "share") {
      const r = await resolveShare(ep.url, { ua: cfg.ua, referer: cfg.referer, timeoutMs: cfg.timeoutMs });
      if (r.ok) finalUrl = r.m3u8;
      else nonDirect = true;
    }

    const playable = !nonDirect && /\.m3u8(\?|$)/i.test(finalUrl);
    const url = playable
      ? buildCleanUrl(addonBaseUrl, finalUrl, srcId)
      : finalUrl;

    streams.push({
      name: `${cfg.label}｜${line.lineName}`,
      title: `${item.vod_name}${ep.title ? " " + ep.title : ""}${nonDirect ? " [non-direct]" : ""}`,
      url,
      behaviorHints: playable ? { notWebReady: false } : { notWebReady: true },
    });
  }
  return streams;
}

function selectEpisode(episodes, episode) {
  if (!episodes.length) return null;
  if (!episode) return episodes[0];
  return episodes.find((e) => parseEpisodeNumber(e.title) === episode) || null;
}

/** 通路 1：内部 id 直接命中单源 */
async function streamFromInternalId(req, id, { season, episode }, { registry }) {
  const parsed = parseItemId(id);
  if (!parsed) return { streams: [] };
  const entry = registry.get(parsed.srcId);
  if (!entry) return { streams: [] };

  try {
    const streams = await resolveOneSource(entry, parsed.vodId, { season, episode }, addonBase(req));
    log.info(`[stream] internal ${id} → ${streams.length} streams`);
    return { streams };
  } catch (e) {
    log.error(`[stream] internal ${id} failed: ${e.message}`);
    return { streams: [] };
  }
}

/** 通路 2：imdbid → TMDB → 各源 search → 打分 → 高置信 detail */
async function streamFromImdb(req, imdbId, type, { season, episode }, { registry }) {
  const base = addonBase(req);

  const meta = await resolveByImdb(imdbId, type, { season: season || 1 });
  if (!meta) {
    log.warn(`[stream] imdb ${imdbId} → TMDB unavailable (no key or not found)`);
    return { streams: [] };
  }

  // 并行各源 search
  const entries = registry.enabled();
  const searches = await Promise.allSettled(
    entries.map(async (entry) => {
      const results = await entry.adapter.search(entry.cfg, meta.name);
      return { entry, results };
    })
  );

  const streams = [];
  const lowCandidates = [];

  for (const r of searches) {
    if (r.status !== "fulfilled") continue;
    const { entry, results } = r.value;
    if (!results.length) continue;

    const ranked = rankCandidates(meta, results, { thresholds: DEFAULT_THRESHOLDS });
    const high = ranked.filter((x) => x.level === "high");

    if (!high.length) {
      // 记录中/低候选，便于 /debug/match
      const top = ranked.slice(0, 3).map((x) => ({
        source: entry.cfg.id,
        vod_id: x.candidate.vod_id,
        vod_name: x.candidate.vod_name,
        score: x.score,
        level: x.level,
        breakdown: x.breakdown,
      }));
      lowCandidates.push(...top);
      continue;
    }

    // 高置信：取最高分那条 detail
    const top = high[0];
    try {
      const one = await resolveOneSource(
        entry,
        String(top.candidate.vod_id),
        { season, episode },
        base
      );
      streams.push(...one);
      log.info(`[stream] imdb ${imdbId} → ${entry.cfg.id} hit "${top.candidate.vod_name}" score=${top.score}`);
    } catch (e) {
      log.error(`[stream] ${entry.cfg.id} detail failed: ${e.message}`);
    }
  }

  if (lowCandidates.length) {
    log.warn(`[stream] imdb ${imdbId} low/medium candidates: ${JSON.stringify(lowCandidates)}`);
  }

  return { streams, lowCandidates };
}

export async function handleStream({ type, id }, req, { registry }) {
  const { baseId, season, episode } = parseStreamId(id);

  // 内部 id：bfzy:movie:27312 或 bfzy:series:27312
  if (/^[a-z0-9]+:(movie|series):\d+/i.test(baseId)) {
    return streamFromInternalId(req, baseId, { season, episode }, { registry });
  }

  // imdb id
  if (/^tt\d+$/.test(baseId)) {
    return streamFromImdb(req, baseId, type, { season, episode }, { registry });
  }

  return { streams: [] };
}