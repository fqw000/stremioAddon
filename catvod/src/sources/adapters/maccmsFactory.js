// src/sources/adapters/maccmsFactory.js（新建）
import { maccmsSearch, maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../maccmsBase.js";
import { resolveShare } from "../shareResolver.js";

export function createMaccmsAdapter({ id, label, capabilities }) {
  return {
    id,
    label,
    capabilities,

    async search(cfg, keyword) {
      return maccmsSearch(cfg, keyword);
    },

    async resolveStream(cfg, vodId, { episode } = {}) {
      const item = await maccmsDetail(cfg, vodId);
      if (!item) return [];
      const lines = parsePlayUrl(item.vod_play_from, item.vod_play_url);
      const movie = isMovie(item.type_name, lines[0]?.episodes || []);
      const out = [];

      for (const line of lines) {
        const mode = cfg.lines?.[line.lineName]?.mode || "direct";
        const ep = selectEpisode(line.episodes, movie ? null : episode);
        if (!ep) continue;

        let finalUrl = ep.url;
        let nonDirect = false;

        if (mode === "share") {
          const r = await resolveShare(ep.url, {
            ua: cfg.ua, referer: cfg.referer, timeoutMs: cfg.timeoutMs, srcId: id,
          });
          if (r.ok) finalUrl = r.m3u8;
          else nonDirect = true;
        }

        out.push({
          lineName: line.lineName,
          title: ep.title,
          url: finalUrl,
          isDirect: !nonDirect,
          nonDirect,
          sourceLabel: `${label}｜${line.lineName}`,
        });
      }
      return out;
    },
  };
}

function selectEpisode(episodes, episode) {
  if (!episodes.length) return null;
  if (!episode) return episodes[0];
  return episodes.find((e) => parseEpisodeNumber(e.title) === episode) || null;
}