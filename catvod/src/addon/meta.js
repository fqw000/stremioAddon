import { parseItemId } from "./catalog.js";
import { cachedDetail } from "../sources/cached.js";
import { parsePlayUrl, isMovie, parseEpisodeNumber } from "../sources/maccmsBase.js";
import { resolveByImdb } from "../metadata/tmdb.js";
import { log } from "../logger.js";

export async function handleMeta({ type, id }, { registry, userConfig = {} }) {
  // 1. 外部 IMDb ID → TMDB
  if (/^tt\d+$/.test(id)) {
    try {
      const tmdbMeta = await resolveByImdb(id, type, { season: 1, userConfig });
      if (!tmdbMeta) return { meta: null };

      const meta = {
        id,
        type,
        name: tmdbMeta.name,
        poster: tmdbMeta.poster || undefined,
        description: tmdbMeta.overview || undefined,
        releaseInfo: tmdbMeta.year || undefined,
        background: tmdbMeta.poster || undefined,
      };

      if (type === "series") {
        meta.videos = [{ id: `${id}:1:1`, title: "第1集", season: 1, episode: 1 }];
      }
      log.info(`[meta] IMDB ${id} → TMDB 映射成功`);
      return {
        meta,
        cacheMaxAge: 86400,
        staleRevalidate: 3600,
      };
    } catch (e) {
      log.error(`[meta] IMDB ${id} TMDB 映射失败: ${e.message}`);
      return { meta: null };
    }
  }

  // 2. 内部 ID
  const parsed = parseItemId(id);
  if (!parsed) return { meta: null };

  const entry = registry.get(parsed.srcId);
  if (!entry) return { meta: null };

  try {
    const item = await cachedDetail(entry, parsed.vodId);
    if (!item) return { meta: null };

    const lines = parsePlayUrl(item.vod_play_from, item.vod_play_url);
    const movie = isMovie(item.type_name, lines[0]?.episodes || []);
    const metaType = movie ? "movie" : "series";

    const meta = {
      id,
      type: metaType,
      name: item.vod_name || "",
      poster: item.vod_pic || undefined,
      background: item.vod_pic_slide || item.vod_pic || undefined,
      description: stripHtml(item.vod_content || item.vod_blurb || ""),
      releaseInfo: item.vod_year || undefined,
      cast: splitActors(item.vod_actor),
      director: item.vod_director ? [item.vod_director] : undefined,
      genres: item.type_name ? [item.type_name] : undefined,
    };

    if (metaType === "series") {
      const videos = [];
      for (const ep of lines[0]?.episodes || []) {
        const n = parseEpisodeNumber(ep.title);
        if (!n) continue;
        videos.push({ id: `${id}:1:${n}`, title: ep.title, season: 1, episode: n });
      }
      meta.videos = videos;
    }

    return {
      meta,
      cacheMaxAge: 900,
      staleRevalidate: 300,
      staleError: 1800,
    };
  } catch (e) {
    log.error(`[meta] ${id} failed: ${e.message}`);
    return { meta: null };
  }
}

function stripHtml(s) { return String(s || "").replace(/<[^>]+>/g, "").trim(); }
function splitActors(s) {
  if (!s) return undefined;
  const arr = String(s).split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}