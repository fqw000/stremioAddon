// scripts/probe.js — 仅探针，不写业务解析
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SOURCES = [
  { id: "bfzy", base: "https://bfzyapi.com/api.php/provide/vod", referer: "https://bfzyapi.com/" },
  { id: "ffzy", base: "http://cj.ffzyapi.com/api.php/provide/vod", referer: "http://cj.ffzyapi.com/" },
  { id: "lz",   base: "https://cj.lziapi.com/api.php/provide/vod", referer: "https://cj.lziapi.com/" },
];

const KEYWORD = process.argv[2] || "庆余年"; // 可用剧集名试，便于看季集字段
const TIMEOUT_MS = 12000;

async function fetchProbe(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: referer, Accept: "application/json, text/plain, */*" },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body: text };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: `ERR: ${e.name} ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeBody(body) {
  if (typeof body !== "string" || body.startsWith("ERR:")) return { rawType: typeof body, note: body.slice(0, 120) };
  let json;
  try { json = JSON.parse(body); } catch { return { parse: "not-json", head: body.slice(0, 200) }; }

  const out = { topKeys: Object.keys(json), code: json.code, total: json.total, listLen: Array.isArray(json.list) ? json.list.length : "no-list" };
  if (Array.isArray(json.list) && json.list.length) {
    const item = json.list[0];
    out.itemKeys = Object.keys(item);
    // 只记录播放相关字段是否存在及样本，不解析
    out.has_vod_play_from = "vod_play_from" in item ? String(item.vod_play_from).slice(0, 100) : "MISSING";
    out.has_vod_play_url = "vod_play_url" in item ? String(item.vod_play_url).slice(0, 300) : "MISSING";
    out.vod_name = item.vod_name;
    out.vod_id = item.vod_id;
  }
  return out;
}

(async () => {
  const report = { keyword: KEYWORD, generatedAt: new Date().toISOString(), sources: {} };
  for (const s of SOURCES) {
    const searchUrl = `${s.base}/?ac=search&wd=${encodeURIComponent(KEYWORD)}`;
    const search = await fetchProbe(searchUrl, s.referer);
    const searchSummary = summarizeBody(search.body);

    let detailSummary = null;
    // 如果搜索返回了 vod_id，顺带探详情
    try {
      const parsed = JSON.parse(search.body);
      if (parsed.list?.[0]?.vod_id) {
        const detailUrl = `${s.base}/?ac=detail&ids=${parsed.list[0].vod_id}`;
        const detail = await fetchProbe(detailUrl, s.referer);
        detailSummary = summarizeBody(detail.body);
        detailSummary.ms = detail.ms;
        detailSummary.status = detail.status;
      }
    } catch { /* 搜索不是 JSON，跳过详情 */ }

    report.sources[s.id] = {
      searchUrl,
      search: { status: search.status, ms: search.ms, ...searchSummary },
      detail: detailSummary,
    };
  }
  console.log(JSON.stringify(report, null, 2));
})();