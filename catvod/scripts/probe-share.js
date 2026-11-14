// scripts/probe-share.js — 专挖 share 页面 + 防盗链 + ffzy 完整 play_url
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

const SHARE_SAMPLES = [
  { source: "ffzy", url: "https://vip.ffzy-online2.com/share/116b896114ff71245852cace1f9f69c5", referer: "http://cj.ffzyapi.com/" },
  { source: "lz",   url: "https://vip.lzcdn2.com/share/15b3342aa0abd5176b93d68ddf95e3ce", referer: "https://cj.lziapi.com/" },
];

const DIRECT_SAMPLES = [
  { source: "bfzy", url: "https://p.bvvvvvvvvv1f.com/video/qingyuniandiyiji/第01集/index.m3u8", referer: "https://bfzyapi.com/" },
  { source: "lz",   url: "https://vip.lzcdn2.com/20220507/5834_3349bde2/index.m3u8", referer: "https://cj.lziapi.com/" },
];

async function probe(url, { referer, withHeaders = true } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  const headers = { Accept: "*/*" };
  if (withHeaders) { headers["User-Agent"] = UA; if (referer) headers["Referer"] = referer; }
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, len: text.length, body: text };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: `${e.name} ${e.message}` };
  } finally { clearTimeout(timer); }
}

function extractM3u8(text) {
  const found = new Set();
  for (const p of [/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi, /["'](\/[^"']*?\.m3u8[^"']*)["']/gi]) {
    let m; while ((m = p.exec(text)) !== null) found.add(m[1] || m[0]);
  }
  return [...found].slice(0, 10);
}

(async () => {
  const report = { generatedAt: new Date().toISOString(), share: {}, direct: {}, ffzyPlayUrl: null };

  for (const s of SHARE_SAMPLES) {
    const r = await probe(s.url, { referer: s.referer });
    report.share[s.source] = {
      url: s.url, status: r.status, ms: r.ms, len: r.len,
      isHtml: r.body?.includes("<html") || r.body?.includes("<!DOCTYPE"),
      isJson: (() => { try { JSON.parse(r.body); return true; } catch { return false; } })(),
      m3u8Candidates: r.body ? extractM3u8(r.body) : [],
      head: r.body ? r.body.slice(0, 800) : null, // 人工看结构
    };
  }

  for (const s of DIRECT_SAMPLES) {
    const withH = await probe(s.url, { referer: s.referer, withHeaders: true });
    const bare  = await probe(s.url, { withHeaders: false });
    report.direct[s.source] = {
      url: s.url,
      withHeaders: { status: withH.status, ms: withH.ms, len: withH.len },
      bare: { status: bare.status, ms: bare.ms, len: bare.len },
    };
  }

  try {
    const r = await probe("http://cj.ffzyapi.com/api.php/provide/vod/?ac=detail&ids=79613", { referer: "http://cj.ffzyapi.com/" });
    if (r.ok) {
      const item = JSON.parse(r.body).list?.[0];
      report.ffzyPlayUrl = { playFrom: item?.vod_play_from, playUrlFull: item?.vod_play_url };
    }
  } catch (e) { report.ffzyPlayUrl = { err: String(e) }; }

  console.log(JSON.stringify(report, null, 2));
})();