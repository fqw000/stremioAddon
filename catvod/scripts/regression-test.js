#!/usr/bin/env node
// // scripts/regression-test.js
// // 用法：
// //   node scripts/regression-test.js                          # 默认 http://127.0.0.1:3000, 简洁
// //   node scripts/regression-test.js --verbose                # 详细模式
// //   node scripts/regression-test.js -v http://localhost:3000
// //   node scripts/regression-test.js -v https://catvod.wangqifei.eu.org
// //   VERBOSE=true node scripts/regression-test.js

// const BASE = (
//   process.argv.find((a) => a.startsWith("http")) ||
//   process.env.BASE_URL ||
//   "http://127.0.0.1:3000"
// ).replace(/\/$/, "");

// const VERBOSE =
//   process.argv.includes("--verbose") ||
//   process.argv.includes("-v") ||
//   process.env.VERBOSE === "true";

// const UA =
//   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// const DEFAULT_TIMEOUT = 25000;

// const C = {
//   reset: "\x1b[0m", gray: "\x1b[90m", green: "\x1b[32m", yellow: "\x1b[33m",
//   red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
// };

// let pass = 0, fail = 0;
// const failures = [];

// function ok(name, cond, detail = "") {
//   if (cond) { pass++; console.log(`  ${C.green}✅${C.reset} ${name}`); return true; }
//   fail++; failures.push({ name, detail });
//   console.log(`  ${C.red}❌${C.reset} ${name} ${C.yellow}${detail || ""}${C.reset}`);
//   return false;
// }

// // ==========================================
// // HTTP 请求
// // ==========================================
// async function request(path, { method = "GET", timeoutMs = DEFAULT_TIMEOUT } = {}) {
//   const url = path.startsWith("http") ? path : BASE + path;
//   const t0 = Date.now();
//   const ctrl = new AbortController();
//   const timer = setTimeout(() => ctrl.abort(), timeoutMs);
//   try {
//     const r = await fetch(url, {
//       method,
//       headers: { "User-Agent": UA },
//       signal: ctrl.signal,
//       redirect: "follow",
//     });
//     const text = await r.text();
//     let json = null;
//     try { json = JSON.parse(text); } catch {}
//     const headers = {};
//     for (const [k, v] of r.headers.entries()) {
//       if (k.startsWith("x-hls-") || k === "cache-control" || k === "x-trace-id") headers[k] = v;
//     }
//     return {
//       url, path, method,
//       status: r.status, ok: r.ok, elapsed: Date.now() - t0,
//       text, json, headers,
//       cacheControl: r.headers.get("cache-control") || "",
//       traceId: r.headers.get("x-trace-id") || "",
//     };
//   } catch (e) {
//     return {
//       url, path, method,
//       status: 0, ok: false, elapsed: Date.now() - t0,
//       error: e.message, text: "", json: null, headers: {},
//     };
//   } finally {
//     clearTimeout(timer);
//   }
// }

// // ==========================================
// // 回显工具
// // ==========================================
// function shortUrl(url, max = 180) {
//   if (!url || url.length <= max) return url;
//   try {
//     const u = new URL(url);
//     if (u.pathname.includes("/hls/clean")) {
//       const inner = u.searchParams.get("url");
//       const src = u.searchParams.get("src");
//       if (inner) {
//         const s = `${u.origin}/hls/clean?url=${decodeURIComponent(inner)}&src=${src || ""}`;
//         return s.length > max ? s.slice(0, max) + "..." : s;
//       }
//     }
//   } catch {}
//   return url.slice(0, max) + "...";
// }

// function classifyStream(url) {
//   if (!url) return "UNKNOWN";
//   if (url.includes("/hls/clean")) return "HLS-CLEAN";
//   if (/\/share\//.test(url)) return "SHARE";
//   if (/\.m3u8(\?|$)/i.test(url)) return "DIRECT";
//   return "OTHER";
// }

// function tagColor(tag) {
//   switch (tag) {
//     case "HLS-CLEAN": return C.green;
//     case "SHARE": return C.yellow;
//     case "DIRECT": return C.cyan;
//     default: return C.gray;
//   }
// }

// function summarizeResponse(res) {
//   const j = res.json;
//   if (!j) {
//     return `${res.text.length} bytes${res.text ? ` "${res.text.slice(0, 80).replace(/\n/g, "\\n")}"` : ""}`;
//   }
//   const parts = [];
//   if (Array.isArray(j.metas)) parts.push(`metas=${j.metas.length}`);
//   if (Array.isArray(j.streams)) parts.push(`streams=${j.streams.length}`);
//   if (j.meta) parts.push(`meta=${j.meta.name || j.meta.id || "?"}`);
//   if (Array.isArray(j.sources)) parts.push(`sources=${j.sources.length}`);
//   if (j.ok !== undefined) parts.push(`ok=${j.ok}`);
//   if (j.backend) parts.push(`backend=${j.backend}`);
//   if (j.type && j.risk) parts.push(`hls:${j.type}/${j.risk}`);
//   return parts.length ? parts.join(", ") : "JSON " + JSON.stringify(j).slice(0, 60) + "...";
// }

// function printHeaders(res) {
//   const interesting = ["x-hls-error", "x-hls-status", "x-hls-degraded", "x-hls-reason"];
//   for (const k of interesting) {
//     if (res.headers?.[k]) {
//       console.log(`   ${C.red}  ${k}: ${res.headers[k]}${C.reset}`);
//     }
//   }
// }

// function printRequest(res, { errorMsg } = {}) {
//   const indent = "   ";
//   console.log(`${indent}${C.gray}├─${C.reset} ${res.method} ${C.gray}${shortUrl(res.url, 200)}${C.reset}`);
//   console.log(
//     `${indent}${C.gray}├─${C.reset} 状态 ${res.ok ? C.green : C.red}${res.status || "ERR"}${C.reset} · ${C.gray}${res.elapsed}ms${C.reset}` +
//     (res.traceId ? ` · trace ${C.magenta}${res.traceId.slice(0, 8)}${C.reset}` : "") +
//     (res.cacheControl ? ` · ${C.gray}${res.cacheControl}${C.reset}` : "")
//   );
//   printHeaders(res);
//   if (errorMsg) console.log(`${indent}${C.gray}├─${C.reset} ${C.yellow}问题: ${errorMsg}${C.reset}`);
//   if (res.error) {
//     console.log(`${indent}${C.gray}└─${C.reset} ${C.red}错误: ${res.error}${C.reset}`);
//     return;
//   }
//   console.log(`${indent}${C.gray}└─${C.reset} 响应: ${summarizeResponse(res)}`);
// }

// function printStreams(streams) {
//   const indent = "   ";
//   if (!Array.isArray(streams) || streams.length === 0) {
//     console.log(`${indent}  ${C.yellow}(streams 为空)${C.reset}`);
//     return;
//   }
//   console.log(`${indent}  ${C.cyan}流列表 (${streams.length} 条):${C.reset}`);
//   streams.forEach((s, i) => {
//     const tag = classifyStream(s.url);
//     const notWeb = s.behaviorHints?.notWebReady ? ` ${C.yellow}[notWebReady]${C.reset}` : "";
//     const nonDirect = /non-direct/i.test(s.title || "") ? ` ${C.yellow}[non-direct]${C.reset}` : "";
//     console.log(
//       `${indent}  ${C.gray}[${i + 1}]${C.reset} ${tagColor(tag)}[${tag}]${C.reset} ${C.blue}${s.name || "?"}${C.reset} - ${s.title || "?"}${notWeb}${nonDirect}`
//     );
//     console.log(`${indent}      ${C.gray}${shortUrl(s.url, 220)}${C.reset}`);
//   });
// }

// function printDetail(res, { errorMsg } = {}) {
//   printRequest(res, { errorMsg });
//   const j = res.json;
//   if (!j) return;
//   if (Array.isArray(j.streams)) printStreams(j.streams);
//   if (Array.isArray(j.metas) && j.metas.length > 0) {
//     console.log(`   ${C.gray}  metas[0..1]:${C.reset}`);
//     j.metas.slice(0, 2).forEach((m) => {
//       console.log(`   ${C.gray}    - ${m.id} · ${m.type} · ${m.name}${m.releaseInfo ? " (" + m.releaseInfo + ")" : ""}${C.reset}`);
//     });
//     if (j.metas.length > 2) console.log(`   ${C.gray}    ... 共 ${j.metas.length} 条${C.reset}`);
//   }
//   if (j.meta?.videos?.length) {
//     console.log(`   ${C.gray}  videos[0..2]: ${j.meta.videos.slice(0, 3).map((v) => v.id).join(", ")} (共 ${j.meta.videos.length})${C.reset}`);
//   }
//   if (Array.isArray(j.sources)) {
//     console.log(`   ${C.gray}  sources:${C.reset}`);
//     j.sources.forEach((s) => {
//       const col = s.ok ? C.green : C.red;
//       console.log(`   ${C.gray}    - ${col}${s.id}${C.reset} ${s.ok ? `ok ${s.ms}ms count=${s.count}` : `ERR ${s.error || ""}`}`);
//     });
//   }
// }

// // ==========================================
// // 服务端 HLS 诊断（重点新增）
// // ==========================================
// async function diagnoseHls(innerUrl, srcId) {
//   if (!innerUrl) {
//     console.log(`   ${C.yellow}  无法解析 inner url，跳过服务端诊断${C.reset}`);
//     return null;
//   }
//   const dbg = await request(`/debug/hls-clean?url=${encodeURIComponent(innerUrl)}&src=${srcId || ""}`);
//   const j = dbg.json;
//   if (!j) {
//     console.log(`   ${C.red}  ── 服务端诊断失败: ${dbg.error || "HTTP " + dbg.status}${C.reset}`);
//     return null;
//   }
//   console.log(`   ${C.cyan}  ── 服务端诊断 (/debug/hls-clean) ──${C.reset}`);
//   console.log(`   ${C.gray}  type=${j.type} risk=${j.risk} degraded=${j.degraded || false}${C.reset}`);
//   if (j.reason) console.log(`   ${C.red}  reason=${j.reason}${C.reset}`);
//   console.log(`   ${C.gray}  originalLength=${j.originalLength}  cleanedLength=${j.cleanedLength}${C.reset}`);
//   console.log(`   ${C.gray}  originalSegments=${j.originalSegments}  cleanedSegments=${j.cleanedSegments}${C.reset}`);
//   if (j.hits?.length) {
//     console.log(`   ${C.gray}  hits=${j.hits.length}:${C.reset}`);
//     j.hits.forEach((h) => console.log(`   ${C.gray}    - ${typeof h === "string" ? h : JSON.stringify(h).slice(0, 120)}${C.reset}`));
//   }
//   if (j.originalHead) {
//     console.log(`   ${C.gray}  originalHead(${String(j.originalHead).length}b): ${String(j.originalHead).slice(0, 240).replace(/\n/g, "\\n")}${C.reset}`);
//   }
//   if (j.cleanedHead && j.cleanedHead !== j.originalHead) {
//     console.log(`   ${C.gray}  cleanedHead(${String(j.cleanedHead).length}b): ${String(j.cleanedHead).slice(0, 240).replace(/\n/g, "\\n")}${C.reset}`);
//   }
//   return j;
// }

// // ==========================================
// // 测试执行器
// // ==========================================
// async function test(category, name, path, validateFn, { method = "GET", detail = false, timeoutMs } = {}) {
//   const res = await request(path, { method, timeoutMs });
//   let errorMsg = "";
//   let isValid = true;

//   if (!res.ok) {
//     isValid = false;
//     errorMsg = res.error ? `请求失败: ${res.error}` : `HTTP ${res.status}`;
//   } else if (validateFn) {
//     try {
//       const r = validateFn(res.json, res);
//       if (r !== true) { isValid = false; errorMsg = String(r); }
//     } catch (e) {
//       isValid = false; errorMsg = `校验异常: ${e.message}`;
//     }
//   }

//   if (isValid) {
//     pass++;
//     console.log(`  ${C.green}✅${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
//     if (VERBOSE || detail) printDetail(res);
//   } else {
//     fail++;
//     failures.push({ category, name, path, errorMsg });
//     console.log(`  ${C.red}❌${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
//     printDetail(res, { errorMsg });
//   }
//   return { res, isValid };
// }

// // ==========================================
// // m3u8 解析
// // ==========================================
// function parsePlaylist(text) {
//   const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
//   const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
//   const segments = [];
//   const children = [];
//   for (let i = 0; i < lines.length; i++) {
//     const l = lines[i];
//     if (l.startsWith("#EXT-X-STREAM-INF")) {
//       if (lines[i + 1] && !lines[i + 1].startsWith("#")) children.push(lines[i + 1]);
//     } else if (!l.startsWith("#")) {
//       if (/\.m3u8(\?|$)/i.test(l)) {
//         if (!children.includes(l)) children.push(l);
//       } else if (!children.includes(l)) {
//         segments.push(l);
//       }
//     }
//   }
//   return { isMaster, segments, children };
// }

// async function probeSegment(url, timeoutMs = 8000) {
//   const ctrl = new AbortController();
//   const timer = setTimeout(() => ctrl.abort(), timeoutMs);
//   try {
//     const r = await fetch(url, {
//       headers: { "User-Agent": UA, Range: "bytes=0-1023" },
//       signal: ctrl.signal, redirect: "follow",
//     });
//     return { ok: r.ok, status: r.status, len: Number(r.headers.get("content-length") || 0) };
//   } catch (e) {
//     return { ok: false, status: 0, error: e.message };
//   } finally {
//     clearTimeout(timer);
//   }
// }

// // ==========================================
// // 端到端验证（重点增强）
// // ==========================================
// async function verifyStreamPlayable(stream, srcId) {
//   const label = stream.name || "?";
//   const tag = classifyStream(stream.url);

//   console.log(`  ${C.cyan}▶${C.reset} 验证流 ${tagColor(tag)}[${tag}]${C.reset} ${C.blue}${label}${C.reset}`);

//   if (tag !== "HLS-CLEAN") {
//     console.log(`     ${C.yellow}⚠️  跳过（非 /hls/clean 入口）${C.reset}`);
//     return;
//   }

//   // 解析 inner url 和 src（用于后续诊断）
//   let inner = null, src = srcId;
//   try {
//     const u = new URL(stream.url);
//     inner = u.searchParams.get("url");
//     src = u.searchParams.get("src") || srcId;
//     const streamOrigin = u.origin;
//     const baseOrigin = new URL(BASE).origin;
//     if (streamOrigin !== baseOrigin) {
//       console.log(`     ${C.yellow}⚠️  origin 不一致: ${streamOrigin} ≠ ${baseOrigin}${C.reset}`);
//     }
//   } catch {}

//   const first = await request(stream.url);
//   if (!ok(`[${label}] /hls/clean 可达`, first.ok, first.error || `HTTP ${first.status}`)) {
//     printDetail(first);
//     await diagnoseHls(inner, src);
//     return;
//   }
//   if (VERBOSE) printDetail(first);
//   else printHeaders(first);

//   ok(`[${label}] 清单以 #EXTM3U 开头`, first.text.startsWith("#EXTM3U"));
//   if (VERBOSE) {
//     console.log(`   ${C.gray}  清单头部(${first.text.length}b): ${first.text.slice(0, 160).replace(/\n/g, "\\n")}${C.reset}`);
//   }

//   let playlist = parsePlaylist(first.text);
//   let depth = 0;

//   while (playlist.isMaster && playlist.children.length > 0 && depth < 2) {
//     depth++;
//     const childUrl = playlist.children[0];
//     ok(`[${label}] master 子清单入口是 /hls/clean`, childUrl.includes("/hls/clean"), childUrl.slice(0, 120));
//     if (VERBOSE) console.log(`   ${C.gray}  子清单: ${shortUrl(childUrl, 200)}${C.reset}`);

//     const child = await request(childUrl);
//     ok(`[${label}] master 子清单可达 (depth=${depth})`, child.ok, child.error);
//     if (!child.ok) { printDetail(child); return; }
//     if (VERBOSE) {
//       console.log(`   ${C.gray}  子清单 ${child.text.length} bytes, 片段 ${(child.text.match(/^#EXTINF/gm) || []).length}${C.reset}`);
//     }
//     playlist = parsePlaylist(child.text);
//   }

//   // 片段数为 0 → 服务端诊断
//   const segOk = ok(`[${label}] 清洗后分片数 > 0`, playlist.segments.length > 0, `实际 ${playlist.segments.length}`);
//   if (!segOk) {
//     console.log(`   ${C.yellow}  触发失败诊断，调用 /debug/hls-clean 拉取服务端处理过程...${C.reset}`);
//     await diagnoseHls(inner, src);
//     return;
//   }

//   const firstSeg = playlist.segments[0];
//   ok(`[${label}] 分片 URL 已绝对化`, /^https?:\/\//.test(firstSeg), firstSeg.slice(0, 80));
//   if (VERBOSE) console.log(`   ${C.gray}  首分片: ${shortUrl(firstSeg, 200)}${C.reset}`);

//   const probe = await probeSegment(firstSeg);
//   ok(`[${label}] 首分片可访问`, probe.ok, probe.error || `HTTP ${probe.status} len=${probe.len}`);

//   // 对比清洗比例
//   try {
//     const dbg = await request(`/debug/hls-clean?url=${encodeURIComponent(inner)}&src=${src}`);
//     if (dbg.json) {
//       const j = dbg.json;
//       const ratio = j.originalSegments > 0 ? j.cleanedSegments / j.originalSegments : 1;
//       const info = `清洗 ${j.originalSegments} → ${j.cleanedSegments} (${(ratio * 100).toFixed(1)}%), type=${j.type}, hits=${j.hits?.length || 0}, risk=${j.risk}`;
//       if (ratio < 0.2 && j.originalSegments > 0) {
//         console.log(`   ${C.yellow}  ⚠️  ${info} — 疑似误删${C.reset}`);
//       } else {
//         console.log(`   ${C.gray}  ℹ️  ${info}${C.reset}`);
//       }
//       if (VERBOSE && j.hits?.length) {
//         j.hits.forEach((h) => console.log(`   ${C.gray}     hit: ${typeof h === "string" ? h : JSON.stringify(h).slice(0, 100)}${C.reset}`));
//       }
//     }
//   } catch (e) {
//     console.log(`   ${C.yellow}  ⚠️  对比清洗比例失败: ${e.message}${C.reset}`);
//   }
// }

// // ==========================================
// // 主流程
// // ==========================================
// async function main() {
//   console.log(`\n${C.cyan}================================================${C.reset}`);
//   console.log(`  🧪 CatVod Addon Regression Test`);
//   console.log(`  🌐 ${BASE}`);
//   console.log(`  📝 ${VERBOSE ? C.green + "详细模式" + C.reset : "简洁模式"}`);
//   console.log(`${C.cyan}================================================${C.reset}\n`);

//   // ==========================================
//   // [0] 服务端出站网络预检（新增）
//   // ==========================================
//   console.log(`${C.cyan}[0]${C.reset} 服务端出站网络预检（关键：区分服务端/客户端网络问题）`);
//   const probeM3u8 = "https://p.bvvvvvvvvv1f.com/video/qingyuniandiyiji/%E7%AC%AC02%E9%9B%86/index.m3u8";
//   const r0 = await test("Preflight", "服务端能拉到 bfzy m3u8", 
//     `/debug/hls-clean?url=${encodeURIComponent(probeM3u8)}&src=bfzy`, 
//     (d) => {
//       if (d.type === "error") return `服务端拉取失败: ${d.reason || "unknown"}（Vercel 出站网络问题，非客户端）`;
//       if (!d.originalLength || d.originalLength === 0) return "originalLength=0，服务端拉到了空内容";
//       if (d.originalSegments === 0 && d.type === "media") return `media 清单但 0 片段（originalLength=${d.originalLength}）`;
//       return true;
//     },
//     { detail: true }
//   );

//   if (r0.res.json?.type === "error") {
//     console.log(`\n  ${C.red}⚠️  服务端出站网络异常！${C.reset}`);
//     console.log(`  ${C.yellow}  这意味着后续所有 HLS 相关测试都会失败，且与你的客户端网络无关。${C.reset}`);
//     console.log(`  ${C.yellow}  修复方案：在 vercel.json 中设置 "regions": ["hkg1"]（香港节点）。${C.reset}\n`);
//   }

//   // ==========================================
//   // [1] 健康 & Manifest
//   // ==========================================
//   console.log(`${C.cyan}[1]${C.reset} 健康 & Manifest`);
//   await test("Base", "health.ok", "/health", (d) => d.ok === true);
//   await test("Base", "manifest 结构完整", "/manifest.json", (d) => {
//     if (!d.id) return "缺 id";
//     if (!d.types?.includes("movie") || !d.types?.includes("series")) return "types 缺 movie/series";
//     const names = (d.resources || []).map((r) => (typeof r === "string" ? r : r.name));
//     if (!names.includes("catalog") || !names.includes("meta") || !names.includes("stream")) return "resources 缺 catalog/meta/stream";
//     if (d.catalogs?.length !== 6) return `catalogs 期望 6，实际 ${d.catalogs?.length}`;
//     return true;
//   }, { detail: VERBOSE });

//   // ==========================================
//   // [2] Catalog
//   // ==========================================
//   console.log(`\n${C.cyan}[2]${C.reset} Catalog 搜索`);
//   const sources = ["bfzy", "ffzy", "lz"];
//   const kwS = encodeURIComponent("庆余年");
//   const kwM = encodeURIComponent("流浪地球");
//   for (const src of sources) {
//     await test("Catalog", `${src} series 搜索`, `/catalog/series/${src}-series/search=${kwS}.json`, (d) => {
//       if (!Array.isArray(d.metas)) return "metas 非数组";
//       if (d.metas.length === 0) return "未搜到";
//       if (!new RegExp(`^${src}:series:\\d+$`, "i").test(d.metas[0].id)) return `id 格式错: ${d.metas[0].id}`;
//       return true;
//     }, { detail: VERBOSE });
//   }
//   for (const src of sources) {
//     await test("Catalog", `${src} movie 搜索`, `/catalog/movie/${src}-movie/search=${kwM}.json`, (d) => {
//       if (!Array.isArray(d.metas)) return "metas 非数组";
//       return true;
//     }, { detail: VERBOSE });
//   }

//   // ==========================================
//   // [3] Meta
//   // ==========================================
//   console.log(`\n${C.cyan}[3]${C.reset} Meta`);
//   await test("Meta", "series 内部 id", "/meta/series/bfzy:series:27312.json", (d) => {
//     if (!d.meta) return "meta 为空";
//     if (d.meta.type !== "series") return "type 错";
//     if (!d.meta.videos?.length) return "videos 为空";
//     return true;
//   }, { detail: VERBOSE });
//   await test("Meta", "movie 内部 id", "/meta/movie/lz:movie:14547.json", (d) => {
//     if (!d.meta) return "meta 为空";
//     if (d.meta.type !== "movie") return "type 错";
//     return true;
//   }, { detail: VERBOSE });
//   await test("Meta", "IMDb id 映射", "/meta/movie/tt0111161.json", (d) => {
//     if (!d.meta) return "meta 为空（TMDB 网络或 key 问题）";
//     return true;
//   });

//   // ==========================================
//   // [4] Stream 内部 id
//   // ==========================================
//   console.log(`\n${C.cyan}[4]${C.reset} Stream 路径 2（内部 id）`);
//   const collectedStreams = [];
//   const r4a = await test("Stream", "series bfzy", "/stream/series/bfzy:series:27312:1:2.json", (d) => {
//     if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
//     if (!d.streams[0].url?.includes("/hls/clean")) return "未指向 /hls/clean";
//     if (!d.streams[0].url?.includes("src=bfzy")) return "缺 src=bfzy";
//     return true;
//   }, { detail: VERBOSE });
//   if (r4a.res.json?.streams?.[0]) collectedStreams.push({ srcId: "bfzy", stream: r4a.res.json.streams[0] });

//   const r4b = await test("Stream", "movie lz", "/stream/movie/lz:movie:14547.json", (d) => {
//     if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
//     return true;
//   }, { detail: VERBOSE });
//   if (r4b.res.json?.streams?.length) {
//     const hls = r4b.res.json.streams.find((s) => s.url?.includes("/hls/clean")) || r4b.res.json.streams[0];
//     collectedStreams.push({ srcId: "lz", stream: hls });
//   }

//   // ==========================================
//   // [5] Stream IMDB
//   // ==========================================
//   console.log(`\n${C.cyan}[5]${C.reset} Stream 路径 1（IMDB id）`);
//   const r5 = await test("Stream", "IMDB movie tt0111161", "/stream/movie/tt0111161.json", (d) => {
//     if (!Array.isArray(d.streams)) return "streams 非数组";
//     return true;
//   }, { detail: VERBOSE });
//   if (r5.res.json?.streams?.length) {
//     const s = r5.res.json.streams.find((x) => x.url?.includes("/hls/clean"));
//     if (s) {
//       const m = s.url.match(/[?&]src=([^&]+)/);
//       collectedStreams.push({ srcId: m ? m[1] : "unknown", stream: s });
//     }
//   }

//   // ==========================================
//   // [5.5] tt27995113 专项
//   // ==========================================
//   console.log(`\n${C.cyan}[5.5]${C.reset} Stream 专项：tt27995113:1:1（黑鸽第一季）`);
//   const r55 = await test("Stream", "tt27995113:1:1", "/stream/series/tt27995113:1:1.json", (d) => {
//     if (!Array.isArray(d.streams)) return "streams 非数组";
//     if (d.streams.length === 0) return "无流";
//     return true;
//   }, { detail: true });

//   if (r55.res.json?.streams?.length) {
//     const stats = { "HLS-CLEAN": 0, SHARE: 0, DIRECT: 0, OTHER: 0 };
//     r55.res.json.streams.forEach((s) => { stats[classifyStream(s.url)]++; });
//     console.log(`   ${C.gray}分类: HLS-CLEAN=${stats["HLS-CLEAN"]} SHARE=${stats.SHARE} DIRECT=${stats.DIRECT} OTHER=${stats.OTHER}${C.reset}`);
//     r55.res.json.streams.filter((s) => s.url?.includes("/hls/clean")).forEach((s) => {
//       const m = s.url.match(/[?&]src=([^&]+)/);
//       collectedStreams.push({ srcId: m ? m[1] : "unknown", stream: s, tag: "tt27995113" });
//     });
//   }

//   // ==========================================
//   // [6] HLS 快检（失败自动诊断）
//   // ==========================================
//   console.log(`\n${C.cyan}[6]${C.reset} HLS 清洗单条快检`);
//   const r6 = await test("HLS", "bfzy 清洗 + 绝对化", 
//     `/hls/clean?url=${encodeURIComponent(probeM3u8)}&src=bfzy`,
//     (d, res) => {
//       if (!res.text.startsWith("#EXTM3U")) return `未返回 m3u8（${res.text.length}b: ${res.text.slice(0, 80).replace(/\n/g, "\\n")}）`;
//       const firstUri = res.text.split("\n").find((l) => l.trim() && !l.startsWith("#"));
//       if (!firstUri) return `清单里没有分片（${res.text.length}b）`;
//       if (!/^https?:\/\//.test(firstUri)) return `分片未绝对化: ${firstUri}`;
//       return true;
//     }, 
//     { detail: VERBOSE }
//   );
//   if (!r6.isValid) {
//     await diagnoseHls(probeM3u8, "bfzy");
//   }

//   // ==========================================
//   // [7] Debug
//   // ==========================================
//   console.log(`\n${C.cyan}[7]${C.reset} 调试接口`);
//   await test("Debug", "sources", "/debug/sources", (d) => Array.isArray(d.sources) ? true : "sources 非数组", { detail: VERBOSE });
//   await test("Debug", "cache", "/debug/cache", (d) => typeof d.backend === "string");
//   await test("Debug", "reload-rules", "/debug/reload-rules", (d) => d.ok === true, { method: "POST", detail: VERBOSE });

//   // ==========================================
//   // [8] 端到端
//   // ==========================================
//   console.log(`\n${C.cyan}[8]${C.reset} 端到端播放验证`);
//   if (collectedStreams.length === 0) {
//     console.log(`  ${C.yellow}⚠️  无可用流${C.reset}`);
//   } else {
//     const seen = new Set();
//     const toVerify = [];
//     for (const item of collectedStreams) {
//       if (seen.has(item.stream.url)) continue;
//       seen.add(item.stream.url);
//       toVerify.push(item);
//       if (toVerify.length >= 4) break;
//     }
//     for (const item of toVerify) {
//       await verifyStreamPlayable(item.stream, item.srcId);
//     }
//   }

//   // ==========================================
//   // 汇总
//   // ==========================================
//   console.log(`\n${C.cyan}================================================${C.reset}`);
//   console.log(`  总计 ${pass + fail} | ${C.green}通过 ${pass}${C.reset} | ${fail > 0 ? C.red : C.gray}失败 ${fail}${C.reset}`);
//   console.log(`${C.cyan}================================================${C.reset}`);

//   if (fail > 0) {
//     console.log(`\n${C.red}!!! 失败详情 !!!${C.reset}`);
//     failures.forEach((f, i) => {
//       console.log(`\n[${i + 1}] ${f.category ? f.category + " | " : ""}${f.name}`);
//       if (f.path) console.log(`    路径: ${f.path}`);
//       console.log(`    原因: ${f.errorMsg || "未捕获"}`);
//     });
//     process.exit(1);
//   }
//   console.log(`\n${C.green}🎉 全部通过${C.reset}\n`);
// }

// main().catch((e) => { console.error("FATAL:", e); process.exit(1); });



// #!/usr/bin/env node
// scripts/regression-test.js
//
// ============================================================
// 用法
// ============================================================
//
//   node scripts/regression-test.js                            # 默认 http://127.0.0.1:3000
//   node scripts/regression-test.js --verbose                  # 详细模式
//   node scripts/regression-test.js -v https://your-app.com    # 详细 + 指定地址
//   VERBOSE=true node scripts/regression-test.js               # 环境变量方式
//
// ============================================================
// 输出说明
// ============================================================
//
//   简洁模式（默认）：
//     - ✅/❌ 每项结果
//     - 失败时才打印请求/响应详情 + 底层调试接口数据
//
//   详细模式（--verbose / -v）：
//     - 每项都打印请求/响应详情
//     - stream 测试同时打印 /debug/match 底层 search 结果
//     - HLS 测试同时打印 /debug/hls-clean 原始/命中/清洗后
//
// ============================================================
// 测试分段
// ============================================================
//
//   [1]  健康 & Manifest
//   [2]  Catalog 搜索（3源 × movie/series）
//   [3]  Meta（内部 id + IMDb id）
//   [4]  Stream 路径 2（内部 id）  ─┐
//   [5]  Stream 路径 1（IMDB id）   ├─ 自动附 /debug/match 底层数据
//   [5.5] Stream 专项 tt27995113   ─┘
//   [6]  HLS 清洗单条快检          ── 自动附 /debug/hls-clean
//   [7]  调试接口
//   [8]  端到端播放验证（拉清单 + 递归 master + 拉首分片）
//
// ============================================================
// 退出码
// ============================================================
//
//   0  全部通过
//   1  有失败项
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
const TIMEOUT = 25000;

const C = {
  reset: "\x1b[0m", gray: "\x1b[90m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ${C.green}✅${C.reset} ${name}`); return true; }
  fail++; failures.push({ name, detail });
  console.log(`  ${C.red}❌${C.reset} ${name} ${C.yellow}${detail || ""}${C.reset}`);
  return false;
}

async function request(path, method = "GET") {
  const url = path.startsWith("http") ? path : BASE + path;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method, headers: { "User-Agent": UA }, signal: ctrl.signal, redirect: "follow" });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      url, method, status: r.status, ok: r.ok, elapsed: Date.now() - t0,
      text, json,
      cacheControl: r.headers.get("cache-control") || "",
      traceId: r.headers.get("x-trace-id") || "",
    };
  } catch (e) {
    return { url, method, status: 0, ok: false, elapsed: Date.now() - t0, error: e.message, text: "", json: null };
  } finally {
    clearTimeout(timer);
  }
}

// ==========================================
// 回显
// ==========================================
function shortUrl(url, max = 180) {
  if (!url || url.length <= max) return url;
  try {
    const u = new URL(url);
    const inner = u.searchParams.get("url");
    if (u.pathname.includes("/hls/clean") && inner) {
      const s = `${u.origin}/hls/clean?url=${decodeURIComponent(inner)}&src=${u.searchParams.get("src") || ""}`;
      return s.length > max ? s.slice(0, max) + "..." : s;
    }
  } catch {}
  return url.slice(0, max) + "...";
}

function classifyStream(url) {
  if (!url) return "UNKNOWN";
  if (url.includes("/hls/clean")) return "HLS-CLEAN";
  if (/\/share\//.test(url)) return "SHARE";
  if (/\.m3u8(\?|$)/i.test(url)) return "DIRECT";
  return "OTHER";
}

function tagColor(tag) {
  return { "HLS-CLEAN": C.green, SHARE: C.yellow, DIRECT: C.cyan }[tag] || C.gray;
}

function summarize(res) {
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

function printReq(res, errorMsg) {
  const i = "   ";
  console.log(`${i}${C.gray}├─${C.reset} ${res.method} ${C.gray}${shortUrl(res.url, 200)}${C.reset}`);
  console.log(`${i}${C.gray}├─${C.reset} ${res.ok ? C.green : C.red}${res.status || "ERR"}${C.reset} · ${C.gray}${res.elapsed}ms${C.reset}${res.traceId ? ` · trace ${C.magenta}${res.traceId.slice(0, 8)}${C.reset}` : ""}${res.cacheControl ? ` · ${C.gray}${res.cacheControl}${C.reset}` : ""}`);
  if (errorMsg) console.log(`${i}${C.gray}├─${C.reset} ${C.yellow}问题: ${errorMsg}${C.reset}`);
  if (res.error) { console.log(`${i}${C.gray}└─${C.reset} ${C.red}错误: ${res.error}${C.reset}`); return; }
  console.log(`${i}${C.gray}└─${C.reset} 响应: ${summarize(res)}`);
}

function printStreams(streams) {
  const i = "   ";
  if (!Array.isArray(streams) || streams.length === 0) {
    console.log(`${i}  ${C.yellow}(streams 为空)${C.reset}`);
    return;
  }
  console.log(`${i}  ${C.cyan}流列表 (${streams.length} 条):${C.reset}`);
  streams.forEach((s, idx) => {
    const tag = classifyStream(s.url);
    const notWeb = s.behaviorHints?.notWebReady ? ` ${C.yellow}[notWebReady]${C.reset}` : "";
    console.log(`${i}  ${C.gray}[${idx + 1}]${C.reset} ${tagColor(tag)}[${tag}]${C.reset} ${C.blue}${s.name || "?"}${C.reset} - ${s.title || "?"}${notWeb}`);
    console.log(`${i}      ${C.gray}${shortUrl(s.url, 220)}${C.reset}`);
  });
}

function printDetail(res, errorMsg) {
  printReq(res, errorMsg);
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
// 底层数据：调 /debug/match 展示源站 search 结果
// ============================================================
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
    console.log(`   ${C.yellow}  candidates 为空（TMDB 未匹配或所有源都无结果）${C.reset}`);
    return;
  }
  for (const [srcId, c] of Object.entries(j.candidates)) {
    if (c.error) {
      console.log(`   ${C.red}  ${srcId}: ERR ${c.error}${C.reset}`);
      continue;
    }
    console.log(`   ${C.gray}  ${srcId} (${c.ms}ms, total=${c.total}):${C.reset}`);
    (c.ranked || []).slice(0, 3).forEach((x) => {
      const lvl = x.level === "high" ? C.green : x.level === "medium" ? C.yellow : C.gray;
      const b = x.breakdown || {};
      console.log(`   ${C.gray}    - ${lvl}${x.level}${C.reset} score=${x.score} "${x.vod_name}"${x.vod_year ? ` (${x.vod_year})` : ""} [title=${b.title} year=${b.year} type=${b.type} season=${b.season}]`);
    });
  }
}

// ==========================================
// 底层数据：调 /debug/hls-clean 展示原始/命中/清洗后
// ==========================================
async function printHlsDebug(innerUrl, srcId) {
  if (!innerUrl) return;
  const r = await request(`/debug/hls-clean?url=${encodeURIComponent(innerUrl)}&src=${srcId || ""}`);
  const j = r.json;
  if (!j) {
    console.log(`   ${C.red}  ── /debug/hls-clean 失败: ${r.error || "HTTP " + r.status}${C.reset}`);
    return;
  }
  console.log(`   ${C.cyan}  ── HLS 清洗详情 (/debug/hls-clean) ──${C.reset}`);
  console.log(`   ${C.gray}  type=${j.type} risk=${j.risk} degraded=${j.degraded || false}${j.reason ? ` reason=${j.reason}` : ""}${C.reset}`);
  console.log(`   ${C.gray}  originalLength=${j.originalLength} cleanedLength=${j.cleanedLength}${C.reset}`);
  console.log(`   ${C.gray}  originalSegments=${j.originalSegments} cleanedSegments=${j.cleanedSegments}${C.reset}`);
  if (j.hits?.length) {
    console.log(`   ${C.gray}  hits:${C.reset}`);
    j.hits.forEach((h) => console.log(`   ${C.gray}    - ${typeof h === "string" ? h : JSON.stringify(h).slice(0, 120)}${C.reset}`));
  }
  if (j.originalHead) {
    console.log(`   ${C.gray}  originalHead: ${String(j.originalHead).slice(0, 200).replace(/\n/g, "\\n")}${C.reset}`);
  }
}

// ==========================================
// 测试执行器
// ==========================================
async function test(category, name, path, validateFn, { method = "GET", detail = false, debugAfter } = {}) {
  const res = await request(path, method);
  let errorMsg = "", isValid = true;
  if (!res.ok) { isValid = false; errorMsg = res.error ? `请求失败: ${res.error}` : `HTTP ${res.status}`; }
  else if (validateFn) {
    try { const r = validateFn(res.json, res); if (r !== true) { isValid = false; errorMsg = String(r); } }
    catch (e) { isValid = false; errorMsg = `校验异常: ${e.message}`; }
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
    if (debugAfter) await debugAfter();  // 失败时无论是否 verbose 都拉底层
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
// 端到端验证一条流
// ==========================================
async function verifyStreamPlayable(stream, srcId) {
  const label = stream.name || "?";
  const tag = classifyStream(stream.url);
  console.log(`  ${C.cyan}▶${C.reset} 验证流 ${tagColor(tag)}[${tag}]${C.reset} ${C.blue}${label}${C.reset}`);

  if (tag !== "HLS-CLEAN") {
    console.log(`     ${C.yellow}⚠️  跳过（非 /hls/clean 入口）${C.reset}`);
    return;
  }

  let inner = null, src = srcId;
  try {
    const u = new URL(stream.url);
    inner = u.searchParams.get("url");
    src = u.searchParams.get("src") || srcId;
  } catch {}

  const first = await request(stream.url);
  if (!ok(`[${label}] /hls/clean 可达`, first.ok, first.error || `HTTP ${first.status}`)) {
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
    ok(`[${label}] master 子清单入口是 /hls/clean`, childUrl.includes("/hls/clean"), childUrl.slice(0, 120));
    const child = await request(childUrl);
    ok(`[${label}] master 子清单可达 (depth=${depth})`, child.ok, child.error);
    if (!child.ok) { await printHlsDebug(inner, src); return; }
    if (VERBOSE) console.log(`   ${C.gray}  子清单 ${child.text.length}b, 片段 ${(child.text.match(/^#EXTINF/gm) || []).length}${C.reset}`);
    playlist = parsePlaylist(child.text);
  }

  const segOk = ok(`[${label}] 清洗后分片数 > 0`, playlist.segments.length > 0, `实际 ${playlist.segments.length}`);
  if (!segOk) {
    // 失败必拉底层
    await printHlsDebug(inner, src);
    return;
  }

  const firstSeg = playlist.segments[0];
  ok(`[${label}] 分片 URL 已绝对化`, /^https?:\/\//.test(firstSeg), firstSeg.slice(0, 80));
  if (VERBOSE) console.log(`   ${C.gray}  首分片: ${shortUrl(firstSeg, 200)}${C.reset}`);

  const probe = await probeSegment(firstSeg);
  ok(`[${label}] 首分片可访问`, probe.ok, probe.error || `HTTP ${probe.status} len=${probe.len}`);

  // 清洗比例
  try {
    const dbg = await request(`/debug/hls-clean?url=${encodeURIComponent(inner)}&src=${src}`);
    if (dbg.json) {
      const j = dbg.json;
      const ratio = j.originalSegments > 0 ? j.cleanedSegments / j.originalSegments : 1;
      const info = `清洗 ${j.originalSegments} → ${j.cleanedSegments} (${(ratio * 100).toFixed(1)}%), type=${j.type}, hits=${j.hits?.length || 0}, risk=${j.risk}`;
      if (ratio < 0.2 && j.originalSegments > 0) console.log(`   ${C.yellow}  ⚠️  ${info} — 疑似误删${C.reset}`);
      else console.log(`   ${C.gray}  ℹ️  ${info}${C.reset}`);
      if (VERBOSE && j.hits?.length) j.hits.forEach((h) => console.log(`   ${C.gray}     hit: ${typeof h === "string" ? h : JSON.stringify(h).slice(0, 100)}${C.reset}`));
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
  await test("Base", "manifest 结构完整", "/manifest.json", (d) => {
    if (!d.id) return "缺 id";
    if (!d.types?.includes("movie") || !d.types?.includes("series")) return "types 缺 movie/series";
    const names = (d.resources || []).map((r) => (typeof r === "string" ? r : r.name));
    if (!names.includes("catalog") || !names.includes("meta") || !names.includes("stream")) return "resources 缺 catalog/meta/stream";
    if (d.catalogs?.length !== 6) return `catalogs 期望 6，实际 ${d.catalogs?.length}`;
    return true;
  }, { detail: VERBOSE });

  // [2]
  console.log(`\n${C.cyan}[2]${C.reset} Catalog 搜索`);
  const sources = ["bfzy", "ffzy", "lz"];
  const kwS = encodeURIComponent("庆余年"), kwM = encodeURIComponent("流浪地球");
  for (const src of sources) {
    await test("Catalog", `${src} series 搜索`, `/catalog/series/${src}-series/search=${kwS}.json`, (d) => {
      if (!Array.isArray(d.metas)) return "metas 非数组";
      if (d.metas.length === 0) return "未搜到";
      return true;
    }, { detail: VERBOSE });
  }
  for (const src of sources) {
    await test("Catalog", `${src} movie 搜索`, `/catalog/movie/${src}-movie/search=${kwM}.json`, (d) => Array.isArray(d.metas) ? true : "metas 非数组", { detail: VERBOSE });
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
  await test("Meta", "IMDb 映射", "/meta/movie/tt0111161.json", (d) => d.meta ? true : "meta 为空（TMDB 网络/key 问题）");

  // [4]
  console.log(`\n${C.cyan}[4]${C.reset} Stream 路径 2（内部 id）`);
  const collected = [];
  const r4a = await test("Stream", "series bfzy", "/stream/series/bfzy:series:27312:1:2.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
    if (!d.streams[0].url?.includes("/hls/clean")) return "未指向 /hls/clean";
    if (!d.streams[0].url?.includes("src=bfzy")) return "缺 src=bfzy";
    return true;
  }, { detail: VERBOSE });
  if (r4a.res.json?.streams?.[0]) collected.push({ srcId: "bfzy", stream: r4a.res.json.streams[0] });

  const r4b = await test("Stream", "movie lz", "/stream/movie/lz:movie:14547.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
    return true;
  }, { detail: VERBOSE });
  if (r4b.res.json?.streams?.length) {
    const hls = r4b.res.json.streams.find((s) => s.url?.includes("/hls/clean")) || r4b.res.json.streams[0];
    collected.push({ srcId: "lz", stream: hls });
  }

  // [5] —— 成功后主动拉底层 search 结果
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
    const s = r5.res.json.streams.find((x) => x.url?.includes("/hls/clean"));
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
    r55.res.json.streams.filter((s) => s.url?.includes("/hls/clean")).forEach((s) => {
      const m = s.url.match(/[?&]src=([^&]+)/);
      collected.push({ srcId: m ? m[1] : "unknown", stream: s });
    });
  }

  // [6] —— 失败自动拉 /debug/hls-clean
  console.log(`\n${C.cyan}[6]${C.reset} HLS 清洗单条快检`);
  const testM3u8 = "https://p.bvvvvvvvvv1f.com/video/qingyuniandiyiji/%E7%AC%AC02%E9%9B%86/index.m3u8";
  const r6 = await test("HLS", "bfzy 清洗 + 绝对化", `/hls/clean?url=${encodeURIComponent(testM3u8)}&src=bfzy`, (d, res) => {
    if (!res.text.startsWith("#EXTM3U")) return `未返回 m3u8（${res.text.length}b）`;
    const first = res.text.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    if (!first) return `清单里无分片（${res.text.length}b）`;
    if (!/^https?:\/\//.test(first)) return `分片未绝对化`;
    return true;
  }, { detail: VERBOSE });
  if (!r6.isValid) await printHlsDebug(testM3u8, "bfzy");

  // [7]
  console.log(`\n${C.cyan}[7]${C.reset} 调试接口`);
  await test("Debug", "sources", "/debug/sources", (d) => Array.isArray(d.sources) ? true : "sources 非数组", { detail: VERBOSE });
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