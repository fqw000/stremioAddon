import { parseItemId } from "./catalog.js";
import { parsePlayUrl, isMovie, parseEpisodeNumber } from "../sources/maccmsBase.js";
import { maccmsDetail } from "../sources/maccmsBase.js";
import { log } from "../logger.js";

export async function handleMeta({ type, id }, { registry }) {
  const parsed = parseItemId(id);
  if (!parsed) return { meta: null };

  const entry = registry.get(parsed.srcId);
  if (!entry) return { meta: null };

  try {
    const item = await maccmsDetail(entry.cfg, parsed.vodId);
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
      // 只用第一条线路的集列表（不同线路集数一致，避免重复）
      for (const ep of lines[0]?.episodes || []) {
        const n = parseEpisodeNumber(ep.title);
        if (!n) continue;
        videos.push({
          id: `${id}:1:${n}`,  // bfzy:series:27312:1:2
          title: ep.title,
          season: 1,
          episode: n,
        });
      }
      meta.videos = videos;
    }

    return { meta };
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