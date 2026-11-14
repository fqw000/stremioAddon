import { rankCandidates } from "../src/metadata/matcher.js";

const meta = {
  name: "庆余年",
  aliases: ["庆余年 第二季", "Joy of Life"],
  year: "2024",
  type: "series",
  season: 2,
};

const candidates = [
  { vod_id: 79613, vod_name: "庆余年第二季粤语", vod_year: "", type_name: "国产剧" },
  { vod_id: 27312, vod_name: "庆余年第一季", vod_year: "2019", type_name: "国产剧" },
  { vod_id: 99999, vod_name: "庆余年之大夏战狼", vod_year: "2024", type_name: "短剧" },
  { vod_id: 88888, vod_name: "流浪地球", vod_year: "2019", type_name: "科幻片" },
];

const ranked = rankCandidates(meta, candidates);
for (const r of ranked) {
  console.log(`[${r.level}] ${r.score.toFixed(3)} ${r.candidate.vod_name}`, JSON.stringify(r.breakdown));
}