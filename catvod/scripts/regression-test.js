#!/usr/bin/env node
// scripts/regression-test.js
//
// ============================================================
// 用法
// ============================================================
//
//   node scripts/regression-test.js                              # 默认 127.0.0.1:3000，简洁
//   node scripts/regression-test.js --verbose                    # 详细模式
//   node scripts/regression-test.js -v https://your-app.com      # 详细 + 指定地址
//   VERBOSE=true node scripts/regression-test.js
//
// ============================================================
// 关键能力
// ============================================================
//
//   - 307 降级识别：(原/hls/clean，请求路径已修改为hls) /hls 用 manual 模式，拿到 307/308 视为"服务端 fetch 失败，
//     已降级让播放器直连源站"，不算失败
//   - fetchAttempts 展示：HLS 失败时展示服务端对源站的原始请求头/响应头/body-head，
//     用于判断是 IP 被屏蔽还是请求头缺失
//   - /debug/match 展示：stream 测试后自动附上每源 search 结果和打分明细
//
// ============================================================
// 测试分段
// ============================================================
//
//   [1]  健康 & Manifest
//   [2]  Catalog 搜索（3源 × movie/series）
//   [3]  Meta（内部 id + IMDb id）
//   [4]  Stream 路径 2（内部 id）
//   [5]  Stream 路径 1（IMDB id）—— 附 /debug/match
//   [5.5] Stream 专项 tt27995113:1:1 —— 附 /debug/match
//   [6]  HLS 清洗快检 —— 识别 307
//   [7]  调试接口
//   [8]  端到端播放验证 —— 识别 307 + fetchAttempts
//
// ============================================================

const BASE = (
  process.argv.find((a) => a.startsWith("http")) ||
  process.env.BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/$/, "");

const VERBOSE =
  process.argv.includes("--verbose") ||
  process.argv.includes("-v") ||
  process.env.VERBOSE === "true";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT = 25000;

const C = {
  reset: "\x1b[0m", gray: "\x1b[90m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ${C.green}✅${C.reset} ${name}`); return true; }
  fail++; failures.push({ name, detail });
  console.log(`  ${C.red}❌${C.reset} ${name} ${C.yellow}${detail || ""}${C.reset}`);
  return false;
}

// ==========================================
// HTTP 请求
// ==========================================
async function request(path, { method = "GET", timeoutMs = DEFAULT_TIMEOUT, redirect = "follow" } = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
      redirect,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      url, path, method,
      status: r.status, ok: r.ok, elapsed: Date.now() - t0,
      text, json,
      location: r.headers.get("location") || "",
      xhlsError: r.headers.get("x-hls-error") || "",
      xhlsDegraded: r.headers.get("x-hls-degraded") || "",
      cacheControl: r.headers.get("cache-control") || "",
      traceId: r.headers.get("x-trace-id") || "",
    };
  } catch (e) {
    return {
      url, path, method, status: 0, ok: false, elapsed: Date.now() - t0,
      error: e.message, text: "", json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ==========================================
// 回显工具
// ==========================================
function shortUrl(url, max = 180) {
  if (!url || url.length <= max) return url;
  try {
    const u = new URL(url);
    const inner = u.searchParams.get("url");
    if (u.pathname.includes("/hls") && inner) {
      const s = `${u.origin}/hls?url=${decodeURIComponent(inner)}&src=${u.searchParams.get("src") || ""}`;
      return s.length > max ? s.slice(0, max) + "..." : s;
    }
  } catch {}
  return url.slice(0, max) + "...";
}

function classifyStream(url) {
  if (!url) return "UNKNOWN";
  if (url.includes("/hls")) return "HLS-CLEAN";
  if (/\/share\//.test(url)) return "SHARE";
  if (/\.m3u8(\?|$)/i.test(url)) return "DIRECT";
  return "OTHER";
}

function tagColor(tag) {
  return { "HLS-CLEAN": C.green, SHARE: C.yellow, DIRECT: C.cyan }[tag] || C.gray;
}

function summarizeResponse(res) {
  const j = res.json;
  if (!j) return `${res.text.length}b`;
  const p = [];
  if (Array.isArray(j.metas)) p.push(`metas=${j.metas.length}`);
  if (Array.isArray(j.streams)) p.push(`streams=${j.streams.length}`);
  if (j.meta) p.push(`meta=${j.meta.name || j.meta.id}`);
  if (Array.isArray(j.sources)) p.push(`sources=${j.sources.length}`);
  if (j.ok !== undefined) p.push(`ok=${j.ok}`);
  if (j.type && j.risk) p.push(`hls:${j.type}/${j.risk}`);
  return p.length ? p.join(", ") : "JSON";
}

function printRequest(res, errorMsg) {
  const ind = "   ";
  console.log(`${ind}${C.gray}├─${C.reset} ${res.method} ${C.gray}${shortUrl(res.url, 200)}${C.reset}`);
  console.log(
    `${ind}${C.gray}├─${C.reset} ${res.ok ? C.green : C.red}${res.status || "ERR"}${C.reset} · ${C.gray}${res.elapsed}ms${C.reset}` +
    (res.traceId ? ` · trace ${C.magenta}${res.traceId.slice(0, 8)}${C.reset}` : "") +
    (res.cacheControl ? ` · ${C.gray}${res.cacheControl}${C.reset}` : "")
  );
  if (errorMsg) console.log(`${ind}${C.gray}├─${C.reset} ${C.yellow}问题: ${errorMsg}${C.reset}`);
  if (res.error) { console.log(`${ind}${C.gray}└─${C.reset} ${C.red}错误: ${res.error}${C.reset}`); return; }
  console.log(`${ind}${C.gray}└─${C.reset} 响应: ${summarizeResponse(res)}`);
}

function printStreams(streams) {
  const ind = "   ";
  if (!Array.isArray(streams) || streams.length === 0) {
    console.log(`${ind}  ${C.yellow}(streams 为空)${C.reset}`);
    return;
  }
  console.log(`${ind}  ${C.cyan}流列表 (${streams.length} 条):${C.reset}`);
  streams.forEach((s, idx) => {
    const tag = classifyStream(s.url);
    const notWeb = s.behaviorHints?.notWebReady ? ` ${C.yellow}[notWebReady]${C.reset}` : "";
    const longPress = /长按复制/.test(s.title || "") ? ` ${C.yellow}[长按复制]${C.reset}` : "";
    console.log(`${ind}  ${C.gray}[${idx + 1}]${C.reset} ${tagColor(tag)}[${tag}]${C.reset} ${C.blue}${s.name || "?"}${C.reset} - ${s.title || "?"}${notWeb}${longPress}`);
    console.log(`${ind}      ${C.gray}${shortUrl(s.url, 220)}${C.reset}`);
  });
}

function printDetail(res, errorMsg) {
  printRequest(res, errorMsg);
  const j = res.json;
  if (!j) return;
  if (Array.isArray(j.streams)) printStreams(j.streams);
  if (Array.isArray(j.metas) && j.metas.length > 0) {
    console.log(`   ${C.gray}  metas[0..1]:${C.reset}`);
    j.metas.slice(0, 2).forEach((m) => console.log(`   ${C.gray}    - ${m.id} · ${m.type} · ${m.name}${m.releaseInfo ? " (" + m.releaseInfo + ")" : ""}${C.reset}`));
    if (j.metas.length > 2) console.log(`   ${C.gray}    ... 共 ${j.metas.length} 条${C.reset}`);
  }
  if (j.meta?.videos?.length) {
    console.log(`   ${C.gray}  videos[0..2]: ${j.meta.videos.slice(0, 3).map((v) => v.id).join(", ")} (共 ${j.meta.videos.length})${C.reset}`);
  }
  if (Array.isArray(j.sources)) {
    console.log(`   ${C.gray}  sources:${C.reset}`);
    j.sources.forEach((s) => {
      const col = s.ok ? C.green : C.red;
      console.log(`   ${C.gray}    - ${col}${s.id}${C.reset} ${s.ok ? `ok ${s.ms}ms count=${s.count}` : `ERR ${s.error || ""}`}`);
    });
  }
}

// ==========================================
// 底层 search 结果（/debug/match）
// ==========================================
async function printMatchDebug(imdbid, type, season) {
  const q = `imdbid=${imdbid}&type=${type}${season ? "&season=" + season : ""}`;
  const r = await request(`/debug/match?${q}`);
  if (!r.json) {
    console.log(`   ${C.red}  ── /debug/match 失败: ${r.error || "HTTP " + r.status}${C.reset}`);
    return;
  }
  const j = r.json;
  console.log(`   ${C.cyan}  ── 底层 search 结果 (/debug/match) ──${C.reset}`);
  console.log(`   ${C.gray}  TMDB: ${j.meta ? `${j.meta.name} (${j.meta.year || "?"}) aliases=${(j.meta.aliases || []).length}` : "null"}${C.reset}`);
  if (!j.candidates || Object.keys(j.candidates).length === 0) {
    console.log(`   ${C.yellow}  candidates 为空${C.reset}`);
    return;
  }
  for (const [srcId, c] of Object.entries(j.candidates)) {
    if (c.error) { console.log(`   ${C.red}  ${srcId}: ERR ${c.error}${C.reset}`); continue; }
    console.log(`   ${C.gray}  ${srcId} (${c.ms}ms, total=${c.total}):${C.reset}`);
    (c.ranked || []).slice(0, 3).forEach((x) => {
      const lvl = x.level === "high" ? C.green : x.level === "medium" ? C.yellow : C.gray;
      const b = x.breakdown || {};
      console.log(`   ${C.gray}    - ${lvl}${x.level}${C.reset} score=${x.score} "${x.vod_name}"${x.vod_year ? ` (${x.vod_year})` : ""} [title=${b.title} year=${b.year} type=${b.type} season=${b.season}]`);
    });
  }
}

// ==========================================
// HLS 诊断（fetchAttempts 完整展示）
// ==========================================
async function printHlsDebug(innerUrl, srcId) {
  if (!innerUrl) return;
  const r = await request(`/debug/hls-clean?url=${encodeURIComponent(innerUrl)}&src=${srcId || ""}`);
  const j = r.json;
  if (!j) {
    console.log(`   ${C.red}  ── /debug/hls-clean 失败: ${r.error || "HTTP " + r.status}${C.reset}`);
    return;
  }

  console.log(`   ${C.cyan}  ── /debug/hls-clean ──${C.reset}`);
  console.log(`   ${C.gray}  type=${j.type} risk=${j.risk} degraded=${j.degraded || false}${j.reason ? ` reason=${j.reason}` : ""}${C.reset}`);
  console.log(`   ${C.gray}  originalLength=${j.originalLength}  cleanedLength=${j.cleanedLength}${C.reset}`);
  console.log(`   ${C.gray}  originalSegments=${j.originalSegments}  cleanedSegments=${j.cleanedSegments}${C.reset}`);

  if (Array.isArray(j.fetchAttempts) && j.fetchAttempts.length > 0) {
    console.log(`   ${C.cyan}  ── 源站原始请求/响应 ──${C.reset}`);
    j.fetchAttempts.forEach((a) => {
      console.log(`   ${C.gray}  [attempt ${a.attempt}] ${a.elapsed}ms${C.reset}`);
      const req = a.request || {};
      console.log(`   ${C.gray}    → ${req.method || "GET"} ${shortUrl(req.url || "", 200)}${C.reset}`);
      if (req.headers) {
        const h = Object.entries(req.headers).map(([k, v]) => `${k}=${String(v).slice(0, 100)}`).join(" | ");
        console.log(`   ${C.gray}      req-headers: ${h}${C.reset}`);
      }
      if (a.error) {
        console.log(`   ${C.red}    ✗ ${a.error.name}: ${a.error.message}${C.reset}`);
      } else if (a.response) {
        const resp = a.response;
        const col = resp.ok ? C.green : C.red;
        console.log(`   ${col}    ← HTTP ${resp.status}${C.reset}`);
        const interest = ["content-type", "content-length", "server", "via", "cf-cache-status", "location"];
        const rh = Object.entries(resp.headers || {})
          .filter(([k]) => interest.includes(k.toLowerCase()))
          .map(([k, v]) => `${k}=${String(v).slice(0, 120)}`).join(" | ");
        if (rh) console.log(`   ${C.gray}      resp-headers: ${rh}${C.reset}`);
        if (resp.bodyHead) {
          console.log(`   ${C.gray}      body-head: ${String(resp.bodyHead).slice(0, 240).replace(/\n/g, "\\n")}${C.reset}`);
        }
      }
    });

    if (j.type === "error") {
      const firstResp = j.fetchAttempts.find((a) => a.response)?.response;
      const status = firstResp?.status;
      if (status) {
        console.log(`\n   ${C.yellow}📌 源站对服务端返回 HTTP ${status}${C.reset}`);
        const reqH = j.fetchAttempts[0]?.request?.headers || {};
        const ua = reqH["User-Agent"] || reqH["user-agent"] || "";
        const ref = reqH["Referer"] || reqH["referer"] || "";
        console.log(`   ${C.yellow}  本地对比: curl -A "${String(ua).slice(0, 80)}" -e "${ref}" "<源站URL>"${C.reset}`);
        console.log(`   ${C.yellow}  本地 200 而服务端 ${status} → 出站 IP 被屏蔽${C.reset}`);
      }
    }
  }

  if (j.hits?.length) {
    console.log(`   ${C.gray}  hits=${j.hits.length}:${C.reset}`);
    j.hits.forEach((h) => console.log(`   ${C.gray}    - ${typeof h === "string" ? h : JSON.stringify(h).slice(0, 120)}${C.reset}`));
  }
  if (j.originalHead) console.log(`   ${C.gray}  originalHead: ${String(j.originalHead).slice(0, 200).replace(/\n/g, "\\n")}${C.reset}`);
  if (j.cleanedHead && j.cleanedHead !== j.originalHead) {
    console.log(`   ${C.gray}  cleanedHead: ${String(j.cleanedHead).slice(0, 200).replace(/\n/g, "\\n")}${C.reset}`);
  }
}

// ==========================================
// 测试执行器
// ==========================================
async function test(category, name, path, validateFn, { method = "GET", detail = false, redirect = "follow", debugAfter } = {}) {
  const res = await request(path, { method, redirect });
  let errorMsg = "", isValid = true;
  if (!res.ok) { isValid = false; errorMsg = res.error ? `请求失败: ${res.error}` : `HTTP ${res.status}`; }
  else if (validateFn) {
    try {
      const r = validateFn(res.json, res);
      if (r !== true) { isValid = false; errorMsg = String(r); }
    } catch (e) { isValid = false; errorMsg = `校验异常: ${e.message}`; }
  }
  if (isValid) {
    pass++;
    console.log(`  ${C.green}✅${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
    if (VERBOSE || detail) {
      printDetail(res);
      if (debugAfter) await debugAfter();
    }
  } else {
    fail++;
    failures.push({ category, name, path, errorMsg });
    console.log(`  ${C.red}❌${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
    printDetail(res, errorMsg);
    if (debugAfter) await debugAfter();
  }
  return { res, isValid };
}

// ==========================================
// m3u8 解析 + 分片探测
// ==========================================
function parsePlaylist(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  const segments = [], children = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF")) {
      if (lines[i + 1] && !lines[i + 1].startsWith("#")) children.push(lines[i + 1]);
    } else if (!l.startsWith("#")) {
      if (/\.m3u8(\?|$)/i.test(l)) { if (!children.includes(l)) children.push(l); }
      else if (!children.includes(l)) segments.push(l);
    }
  }
  return { isMaster, segments, children };
}

async function probeSegment(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Range: "bytes=0-1023" }, signal: ctrl.signal, redirect: "follow" });
    return { ok: r.ok, status: r.status, len: Number(r.headers.get("content-length") || 0) };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
  finally { clearTimeout(timer); }
}

// ==========================================
// 端到端验证（识别 307）
// ==========================================
async function verifyStreamPlayable(stream, srcId) {
  const label = stream.name || "?";
  const tag = classifyStream(stream.url);
  console.log(`  ${C.cyan}▶${C.reset} 验证流 ${tagColor(tag)}[${tag}]${C.reset} ${C.blue}${label}${C.reset}`);

  if (tag !== "HLS-CLEAN") {
    console.log(`     ${C.yellow}⚠️  跳过（非 /hls 入口）${C.reset}`);
    return;
  }

  let inner = null, src = srcId;
  try {
    const u = new URL(stream.url);
    inner = u.searchParams.get("url");
    src = u.searchParams.get("src") || srcId;
    const streamOrigin = u.origin;
    const baseOrigin = new URL(BASE).origin;
    if (streamOrigin !== baseOrigin) {
      console.log(`     ${C.yellow}⚠️  origin 不一致: ${streamOrigin} ≠ ${baseOrigin}${C.reset}`);
    }
  } catch {}

  // manual 模式：识别 307
  const first = await request(stream.url, { redirect: "manual" });

  if (first.status === 307 || first.status === 308) {
    ok(`[${label}] /hls 降级重定向到原始 URL`, !!first.location, first.xhlsError || "");
    if (first.location) console.log(`   ${C.gray}  降级目标: ${shortUrl(first.location, 200)}${C.reset}`);
    console.log(`   ${C.yellow}  ℹ️  未过滤广告，播放器直连源站${C.reset}`);
    await printHlsDebug(inner, src);
    return;
  }

  if (!ok(`[${label}] /hls 可达`, first.ok, first.error || `HTTP ${first.status}`)) {
    if (VERBOSE) printDetail(first);
    await printHlsDebug(inner, src);
    return;
  }
  if (VERBOSE) printDetail(first);

  ok(`[${label}] 清单以 #EXTM3U 开头`, first.text.startsWith("#EXTM3U"));

  let playlist = parsePlaylist(first.text);
  let depth = 0;

  while (playlist.isMaster && playlist.children.length > 0 && depth < 2) {
    depth++;
    const childUrl = playlist.children[0];
    ok(`[${label}] master 子清单入口是 /hls`, childUrl.includes("/hls"), childUrl.slice(0, 120));

    const child = await request(childUrl, { redirect: "manual" });
    if (child.status === 307 || child.status === 308) {
      ok(`[${label}] master 子清单降级重定向`, !!child.location, child.xhlsError || "");
      console.log(`   ${C.yellow}  ℹ️  子清单 fetch 失败 → 降级直连${C.reset}`);
      return;
    }
    ok(`[${label}] master 子清单可达 (depth=${depth})`, child.ok, child.error);
    if (!child.ok) { await printHlsDebug(inner, src); return; }
    if (VERBOSE) console.log(`   ${C.gray}  子清单 ${child.text.length}b, 片段 ${(child.text.match(/^#EXTINF/gm) || []).length}${C.reset}`);
    playlist = parsePlaylist(child.text);
  }

  const segOk = ok(`[${label}] 清洗后分片数 > 0`, playlist.segments.length > 0, `实际 ${playlist.segments.length}`);
  if (!segOk) { await printHlsDebug(inner, src); return; }

  const firstSeg = playlist.segments[0];
  ok(`[${label}] 分片 URL 已绝对化`, /^https?:\/\//.test(firstSeg), firstSeg.slice(0, 80));
  if (VERBOSE) console.log(`   ${C.gray}  首分片: ${shortUrl(firstSeg, 200)}${C.reset}`);

  const probe = await probeSegment(firstSeg);
  ok(`[${label}] 首分片可访问`, probe.ok, probe.error || `HTTP ${probe.status} len=${probe.len}`);

  try {
    const dbg = await request(`/debug/hls-clean?url=${encodeURIComponent(inner)}&src=${src}`);
    if (dbg.json) {
      const j = dbg.json;
      const ratio = j.originalSegments > 0 ? j.cleanedSegments / j.originalSegments : 1;
      const info = `清洗 ${j.originalSegments} → ${j.cleanedSegments} (${(ratio * 100).toFixed(1)}%), type=${j.type}, hits=${j.hits?.length || 0}, risk=${j.risk}`;
      if (ratio < 0.2 && j.originalSegments > 0) console.log(`   ${C.yellow}  ⚠️  ${info} — 疑似误删${C.reset}`);
      else console.log(`   ${C.gray}  ℹ️  ${info}${C.reset}`);
    }
  } catch {}
}

// ==========================================
// 主流程
// ==========================================
async function main() {
  console.log(`\n${C.cyan}================================================${C.reset}`);
  console.log(`  🧪 CatVod Addon Regression Test`);
  console.log(`  🌐 ${BASE}`);
  console.log(`  📝 ${VERBOSE ? C.green + "详细模式" + C.reset : "简洁模式"}`);
  console.log(`${C.cyan}================================================${C.reset}\n`);

  // [1]
  console.log(`${C.cyan}[1]${C.reset} 健康 & Manifest`);
  await test("Base", "health.ok", "/health", (d) => d.ok === true);
  await test("Base", "manifest 结构", "/manifest.json", (d) => {
    if (!d.id) return "缺 id";
    if (!d.types?.includes("movie") || !d.types?.includes("series")) return "types 缺";
    const names = (d.resources || []).map((r) => (typeof r === "string" ? r : r.name));
    if (!names.includes("catalog") || !names.includes("meta") || !names.includes("stream")) return "resources 缺";
    if (d.catalogs?.length !== 6) return `catalogs 期望 6，实际 ${d.catalogs?.length}`;
    return true;
  }, { detail: VERBOSE });

  // [2]
  console.log(`\n${C.cyan}[2]${C.reset} Catalog 搜索`);
  const sources = ["bfzy", "ffzy", "lz"];
  const kwS = encodeURIComponent("庆余年"), kwM = encodeURIComponent("流浪地球");
  for (const src of sources) {
    await test("Catalog", `${src} series`, `/catalog/series/${src}-series/search=${kwS}.json`, (d) => {
      if (!Array.isArray(d.metas)) return "metas 非数组";
      if (d.metas.length === 0) return "未搜到";
      return true;
    }, { detail: VERBOSE });
  }
  for (const src of sources) {
    await test("Catalog", `${src} movie`, `/catalog/movie/${src}-movie/search=${kwM}.json`, (d) =>
      Array.isArray(d.metas) ? true : "metas 非数组", { detail: VERBOSE });
  }

  // [3]
  console.log(`\n${C.cyan}[3]${C.reset} Meta`);
  await test("Meta", "series 内部 id", "/meta/series/bfzy:series:27312.json", (d) => {
    if (!d.meta) return "meta 为空";
    if (d.meta.type !== "series") return "type 错";
    if (!d.meta.videos?.length) return "videos 为空";
    return true;
  }, { detail: VERBOSE });
  await test("Meta", "movie 内部 id", "/meta/movie/lz:movie:14547.json", (d) => {
    if (!d.meta) return "meta 为空";
    if (d.meta.type !== "movie") return "type 错";
    return true;
  }, { detail: VERBOSE });
  await test("Meta", "IMDb 映射", "/meta/movie/tt0111161.json", (d) =>
    d.meta ? true : "meta 为空");

  // [4]
  console.log(`\n${C.cyan}[4]${C.reset} Stream 路径 2（内部 id）`);
  const collected = [];
  const r4a = await test("Stream", "series bfzy", "/stream/series/bfzy:series:27312:1:2.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
    if (!d.streams[0].url?.includes("/hls")) return "未指向 /hls";
    if (!d.streams[0].url?.includes("src=bfzy")) return "缺 src=bfzy";
    return true;
  }, { detail: VERBOSE });
  if (r4a.res.json?.streams?.[0]) collected.push({ srcId: "bfzy", stream: r4a.res.json.streams[0] });

  const r4b = await test("Stream", "movie lz", "/stream/movie/lz:movie:14547.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
    return true;
  }, { detail: VERBOSE });
  if (r4b.res.json?.streams?.length) {
    const hls = r4b.res.json.streams.find((s) => s.url?.includes("/hls")) || r4b.res.json.streams[0];
    collected.push({ srcId: "lz", stream: hls });
  }

  // [5]
  console.log(`\n${C.cyan}[5]${C.reset} Stream 路径 1（IMDB id）`);
  const r5 = await test("Stream", "IMDB movie tt0111161", "/stream/movie/tt0111161.json", (d) => {
    if (!Array.isArray(d.streams)) return "streams 非数组";
    if (d.streams.length === 0) return "无流";
    return true;
  }, {
    detail: VERBOSE,
    debugAfter: async () => { await printMatchDebug("tt0111161", "movie"); },
  });
  if (r5.res.json?.streams?.length) {
    const s = r5.res.json.streams.find((x) => x.url?.includes("/hls"));
    if (s) { const m = s.url.match(/[?&]src=([^&]+)/); collected.push({ srcId: m ? m[1] : "unknown", stream: s }); }
  }

  // [5.5]
  console.log(`\n${C.cyan}[5.5]${C.reset} Stream 专项 tt27995113:1:1`);
  const r55 = await test("Stream", "tt27995113:1:1", "/stream/series/tt27995113:1:1.json", (d) => {
    if (!Array.isArray(d.streams)) return "streams 非数组";
    if (d.streams.length === 0) return "无流";
    return true;
  }, {
    detail: true,
    debugAfter: async () => { await printMatchDebug("tt27995113", "series", 1); },
  });
  if (r55.res.json?.streams?.length) {
    const stats = { "HLS-CLEAN": 0, SHARE: 0, DIRECT: 0, OTHER: 0 };
    r55.res.json.streams.forEach((s) => { stats[classifyStream(s.url)]++; });
    console.log(`   ${C.gray}分类: HLS-CLEAN=${stats["HLS-CLEAN"]} SHARE=${stats.SHARE} DIRECT=${stats.DIRECT}${C.reset}`);
    r55.res.json.streams.filter((s) => s.url?.includes("/hls")).forEach((s) => {
      const m = s.url.match(/[?&]src=([^&]+)/);
      collected.push({ srcId: m ? m[1] : "unknown", stream: s });
    });
  }

  // [6] HLS 快检（识别 307）
  console.log(`\n${C.cyan}[6]${C.reset} HLS 清洗单条快检`);
  const testM3u8 = "https://p.bvvvvvvvvv1f.com/video/qingyuniandiyiji/%E7%AC%AC02%E9%9B%86/index.m3u8";
  const r6 = await request(`/hls?url=${encodeURIComponent(testM3u8)}&src=bfzy`, { redirect: "manual" });
  if (r6.status === 307 || r6.status === 308) {
    pass++;
    console.log(`  ${C.green}✅${C.reset} HLS | bfzy 清洗 ${C.yellow}(降级 307 → 直连原始 URL)${C.reset}`);
    if (r6.xhlsError) console.log(`   ${C.red}${r6.xhlsError}${C.reset}`);
    if (r6.location) console.log(`   ${C.gray}目标: ${shortUrl(r6.location, 180)}${C.reset}`);
    await printHlsDebug(testM3u8, "bfzy");
  } else {
    const isValid = ok("HLS | bfzy 清洗 + 绝对化", (() => {
      if (!r6.text.startsWith("#EXTM3U")) return false;
      const first = r6.text.split("\n").find((l) => l.trim() && !l.startsWith("#"));
      return /^https?:\/\//.test(first || "");
    })(), r6.text.slice(0, 60));
    if (!isValid) await printHlsDebug(testM3u8, "bfzy");
  }

  // [7]
  console.log(`\n${C.cyan}[7]${C.reset} 调试接口`);
  await test("Debug", "sources", "/debug/sources", (d) =>
    Array.isArray(d.sources) ? true : "sources 非数组", { detail: VERBOSE });
  await test("Debug", "cache", "/debug/cache", (d) => typeof d.backend === "string");
  await test("Debug", "reload-rules", "/debug/reload-rules", (d) => d.ok === true, { method: "POST", detail: VERBOSE });

  // [8]
  console.log(`\n${C.cyan}[8]${C.reset} 端到端播放验证`);
  if (collected.length === 0) {
    console.log(`  ${C.yellow}⚠️  无可用流${C.reset}`);
  } else {
    const seen = new Set();
    const toVerify = [];
    for (const item of collected) {
      if (seen.has(item.stream.url)) continue;
      seen.add(item.stream.url);
      toVerify.push(item);
      if (toVerify.length >= 4) break;
    }
    for (const item of toVerify) await verifyStreamPlayable(item.stream, item.srcId);
  }

  // 汇总
  console.log(`\n${C.cyan}================================================${C.reset}`);
  console.log(`  总计 ${pass + fail} | ${C.green}通过 ${pass}${C.reset} | ${fail > 0 ? C.red : C.gray}失败 ${fail}${C.reset}`);
  console.log(`${C.cyan}================================================${C.reset}`);
  if (fail > 0) {
    console.log(`\n${C.red}!!! 失败详情 !!!${C.reset}`);
    failures.forEach((f, i) => {
      console.log(`\n[${i + 1}] ${f.category || ""} | ${f.name}`);
      if (f.path) console.log(`    路径: ${f.path}`);
      console.log(`    原因: ${f.errorMsg || "未捕获"}`);
    });
    process.exit(1);
  }
  console.log(`\n${C.green}🎉 全部通过${C.reset}\n`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });