// MacCMS v10 通用 search / detail / play_url 解析
import { fetchWithRetry } from "../utils/http.js";

function buildHeaders(cfg, accept = "application/json, text/plain, */*") {
  return { "User-Agent": cfg.ua, Referer: cfg.referer, Accept: accept };
}

/** search 只用于候选定位，返回精简字段 */
export async function maccmsSearch(cfg, keyword) {
  const url = `${cfg.baseUrl}/?ac=search&wd=${encodeURIComponent(keyword)}`;
  const text = await fetchWithRetry(url, {
    headers: buildHeaders(cfg),
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
  });
  const json = JSON.parse(text);
  return (json.list || []).map((it) => ({
    vod_id: it.vod_id,
    vod_name: it.vod_name || "",
    vod_year: it.vod_year || "",
    vod_remarks: it.vod_remarks || "",
    vod_pic: it.vod_pic || "",
    type_name: it.type_name || "",
    vod_play_from: it.vod_play_from || "",
  }));
}

export async function maccmsDetail(cfg, vodId) {
  const url = `${cfg.baseUrl}/?ac=detail&ids=${vodId}`;
  const text = await fetchWithRetry(url, {
    headers: buildHeaders(cfg),
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
  });
  const json = JSON.parse(text);
  return json.list?.[0] || null;
}

/**
 * 解析 vod_play_from / vod_play_url
 * 规则（社区共识，探针已确认）：$$$ 分线路，# 分集，$ 分标题/URL
 * @returns {{ lineName:string, episodes:{ title:string, url:string }[] }[]}
 */
export function parsePlayUrl(vod_play_from, vod_play_url) {
  const froms = (vod_play_from || "").split("$$$");
  const urls = (vod_play_url || "").split("$$$");
  const out = [];
  for (let i = 0; i < froms.length; i++) {
    const lineName = froms[i];
    if (!lineName) continue;
    const segments = (urls[i] || "").split("#").filter(Boolean);
    const episodes = segments.map((seg) => {
      const idx = seg.indexOf("$");
      if (idx === -1) return { title: "", url: seg };
      return { title: seg.slice(0, idx), url: seg.slice(idx + 1) };
    }).filter((e) => e.url);
    out.push({ lineName, episodes });
  }
  return out;
}

/** 是否电影：type_name 含"电影" 或 单集标题以 HD/BD/TC 开头 */
export function isMovie(type_name, episodes) {
  if (type_name && /电影|片/.test(type_name)) return true;
  if (episodes.length === 1 && /^(HD|BD|TC|抢先|清晰)/i.test(episodes[0].title)) return true;
  return false;
}

/** 从「第01集」/「第1集」提取数字 */
export function parseEpisodeNumber(title) {
  const m = title.match(/第\s*(\d+)\s*集/);
  return m ? parseInt(m[1], 10) : null;
}