import { maccmsSearch, maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../maccmsBase.js";

export const bfzy = {
  id: "bfzy",
  label: "暴风",
  capabilities: { search: true, detail: true, shareResolve: false },

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
      out.push({
        lineName: line.lineName,
        title: ep.title,
        url: ep.url,
        isDirect: mode === "direct",
        sourceLabel: `${this.label}｜${line.lineName}`,
      });
    }
    return out;
  },
};

function selectEpisode(episodes, episode) {
  if (!episodes.length) return null;
  if (!episode) return episodes[0];
  return episodes.find((e) => parseEpisodeNumber(e.title) === episode) || episodes[0];
}