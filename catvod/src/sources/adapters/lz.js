import { maccmsSearch, maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../maccmsBase.js";
import { resolveShare } from "../shareResolver.js";

export const lz = {
  id: "lz",
  label: "量子",
  capabilities: { search: true, detail: true, shareResolve: true },

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

      if (mode === "share") {
        const r = await resolveShare(ep.url, { ua: cfg.ua, referer: cfg.referer, timeoutMs: cfg.timeoutMs });
        if (r.ok) {
          out.push({ lineName: line.lineName, title: ep.title, url: r.m3u8, isDirect: true, sourceLabel: `${this.label}｜${line.lineName}` });
        } else {
          out.push({ lineName: line.lineName, title: ep.title, url: ep.url, isDirect: false, nonDirect: true, error: r.error, sourceLabel: `${this.label}｜${line.lineName}` });
        }
      } else {
        out.push({ lineName: line.lineName, title: ep.title, url: ep.url, isDirect: true, sourceLabel: `${this.label}｜${line.lineName}` });
      }
    }
    return out;
  },
};

function selectEpisode(episodes, episode) {
  if (!episodes.length) return null;
  if (!episode) return episodes[0];
  return episodes.find((e) => parseEpisodeNumber(e.title) === episode) || episodes[0];
}