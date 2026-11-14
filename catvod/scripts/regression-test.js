// scripts/regression-test.js
// 用法：node scripts/regression-test.js [BASE_URL]
// 默认 BASE_URL = http://localhost:7001

const BASE = (process.argv[2] || "http://localhost:7001").replace(/\/$/, "");
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} ${detail}`); }
}

async function json(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
}

async function main() {
  console.log(`\n=== Regression Test @ ${BASE} ===\n`);

  // ---------- 1. 健康 & Manifest ----------
  console.log("[1] 健康 & Manifest");
  const health = await json("/health");
  ok("health.ok", health.ok === true);

  const manifest = await json("/manifest.json");
  ok("manifest.id", typeof manifest.id === "string" && manifest.id.length > 0);
  ok("manifest.version", typeof manifest.version === "string");
  ok("manifest.types 含 movie/series",
    Array.isArray(manifest.types) && manifest.types.includes("movie") && manifest.types.includes("series"));

  const resources = manifest.resources || [];
  const resourceNames = resources.map(r => typeof r === "string" ? r : r.name);
  ok("resources 含 catalog/meta/stream",
    resourceNames.includes("catalog") && resourceNames.includes("meta") && resourceNames.includes("stream"));

  const streamRes = resources.find(r => typeof r === "object" && r.name === "stream");
  ok("stream resource 带 idPrefixes 含 tt",
    streamRes && Array.isArray(streamRes.idPrefixes) && streamRes.idPrefixes.includes("tt"));

  ok("catalogs 数量 = 6（3源 × movie/series）", Array.isArray(manifest.catalogs) && manifest.catalogs.length === 6);
  ok("每个 catalog 都有 extra.search",
    manifest.catalogs.every(c => Array.isArray(c.extra) && c.extra.some(e => e.name === "search")));

  // ---------- 2. Catalog 搜索 ----------
  console.log("\n[2] Catalog 搜索（3源 × movie/series）");
  const keywordSeries = encodeURIComponent("庆余年");
  const keywordMovie = encodeURIComponent("流浪地球");
  const sources = ["bfzy", "ffzy", "lz"];

  for (const src of sources) {
    try {
      const r = await json(`/catalog/series/${src}-series/search=${keywordSeries}.json`);
      ok(`catalog series ${src} 返回 metas 数组`, Array.isArray(r.metas));
      if (r.metas.length > 0) {
        const m = r.metas[0];
        ok(`catalog ${src} meta.id 格式 ${src}:series:xxx`, /^[a-z0-9]+:series:\d+$/i.test(m.id));
        ok(`catalog ${src} meta.type=series`, m.type === "series");
        ok(`catalog ${src} meta.name 非空`, typeof m.name === "string" && m.name.length > 0);
      }
    } catch (e) { ok(`catalog series ${src}`, false, e.message); }
  }

  for (const src of sources) {
    try {
      const r = await json(`/catalog/movie/${src}-movie/search=${keywordMovie}.json`);
      ok(`catalog movie ${src} 返回 metas 数组`, Array.isArray(r.metas));
      if (r.metas.length > 0) {
        ok(`catalog movie ${src} meta.type=movie`, r.metas[0].type === "movie");
      }
    } catch (e) { ok(`catalog movie ${src}`, false, e.message); }
  }

  // ---------- 3. Meta（内部 id）----------
  console.log("\n[3] Meta（内部 id，movie + series）");
  // series: bfzy:series:27312（庆余年第一季，已知存在）
  try {
    const r = await json("/meta/series/bfzy:series:27312.json");
    ok("meta series bfzy 返回 meta", r.meta != null);
    if (r.meta) {
      ok("meta series bfzy type=series", r.meta.type === "series");
      ok("meta series bfzy videos 数组非空", Array.isArray(r.meta.videos) && r.meta.videos.length > 0);
      if (r.meta.videos?.length) {
        const v = r.meta.videos[0];
        ok("meta series video.id 格式 {metaId}:season:episode", /:\d+:\d+$/.test(v.id));
        ok("meta series video 有 season/episode 数字", Number.isInteger(v.season) && Number.isInteger(v.episode));
      }
    }
  } catch (e) { ok("meta series bfzy", false, e.message); }

  // movie: lz:movie:14547（流浪地球）
  try {
    const r = await json("/meta/movie/lz:movie:14547.json");
    ok("meta movie lz 返回 meta", r.meta != null);
    if (r.meta) {
      ok("meta movie lz type=movie", r.meta.type === "movie");
      ok("meta movie lz 不应有 videos 或为空", !r.meta.videos || r.meta.videos.length === 0);
    }
  } catch (e) { ok("meta movie lz", false, e.message); }

  // ---------- 4. Stream 路径 2：内部 id（movie + series）----------
  console.log("\n[4] Stream 路径 2（内部 id）");
  // series 第2集
  try {
    const r = await json("/stream/series/bfzy:series:27312:1:2.json");
    ok("stream series bfzy 返回 streams 数组", Array.isArray(r.streams));
    if (r.streams.length > 0) {
      const s = r.streams[0];
      ok("stream series bfzy 有 url", typeof s.url === "string" && s.url.length > 0);
      ok("stream series bfzy url 指向 /hls/clean", s.url.includes("/hls/clean"));
      ok("stream series bfzy url 带 src=bfzy", s.url.includes("src=bfzy"));
    }
  } catch (e) { ok("stream series bfzy", false, e.message); }

  // movie（ffzy 有直链线路，lz 有 share 线路，各测一个）
  try {
    const r = await json("/stream/movie/lz:movie:14547.json");
    ok("stream movie lz 返回 streams 数组", Array.isArray(r.streams));
    if (r.streams.length > 0) {
      ok("stream movie lz 至少一条可播放 url", r.streams.some(s => s.url && s.url.includes("/hls/clean")));
    }
  } catch (e) { ok("stream movie lz", false, e.message); }

  // ---------- 5. Stream 路径 1：外部 IMDB id（movie + series）----------
  console.log("\n[5] Stream 路径 1（IMDB id 触发）");
  // movie: tt0111161 肖申克
  try {
    const r = await json("/stream/movie/tt0111161.json");
    ok("stream imdb movie tt0111161 返回 streams 数组", Array.isArray(r.streams));
    if (r.streams.length > 0) {
      ok("stream imdb movie 至少一条 /hls/clean", r.streams.some(s => s.url && s.url.includes("/hls/clean")));
    } else {
      console.log("    ⚠️ tt0111161 无流（源中可能无此片，不判 fail）");
    }
  } catch (e) { ok("stream imdb movie tt0111161", false, e.message); }

  // series: 用一个真实的 imdb series id（这里用 tt0108778 = Friends，仅验证通路不崩）
  try {
    const r = await json("/stream/series/tt0108778:1:1.json");
    ok("stream imdb series tt0108778 返回 streams 数组（不崩）", Array.isArray(r.streams));
  } catch (e) { ok("stream imdb series tt0108778", false, e.message); }

  // ---------- 6. HLS 清洗（用 bfzy 直链）----------
  console.log("\n[6] HLS 清洗");
  const testM3u8 = "https://p.bvvvvvvvvv1f.com/video/qingyuniandiyiji/%E7%AC%AC02%E9%9B%86/index.m3u8";
  try {
    const r = await fetch(`${BASE}/hls/clean?url=${encodeURIComponent(testM3u8)}&src=bfzy`);
    const text = await r.text();
    ok("hls/clean HTTP 200", r.ok);
    ok("hls/clean 返回 #EXTM3U", text.startsWith("#EXTM3U"));
    ok("hls/clean 分片为绝对 URL", /^https?:\/\//m.test(text.split("\n").find(l => !l.startsWith("#") && l.trim()) || ""));
  } catch (e) { ok("hls/clean", false, e.message); }

  // ---------- 7. 调试接口 ----------
  console.log("\n[7] 调试接口");
  try {
    const r = await json("/debug/sources");
    ok("debug/sources 返回 sources 数组", Array.isArray(r.sources));
    ok("debug/sources 三源都在", r.sources.length === 3);
  } catch (e) { ok("debug/sources", false, e.message); }

  try {
    const r = await json("/debug/cache");
    ok("debug/cache 返回 backend", typeof r.backend === "string");
  } catch (e) { ok("debug/cache", false, e.message); }

  // ---------- 汇总 ----------
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) {
    console.log("失败项：");
    failures.forEach(f => console.log("  - " + f));
    process.exit(1);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });