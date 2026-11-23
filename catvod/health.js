#!/usr/bin/env node
// health.js — CatVod Addon 全量健康检查
//
// ============================================================
// 用法
// ============================================================
//
//   node health.js                               # 默认 http://127.0.0.1:3000，简洁模式
//   node health.js --verbose                     # 详细模式
//   node health.js -v https://your-app.com       # 详细 + 指定地址
//   VERBOSE=true node health.js                  # 环境变量方式
//   BASE_URL=https://your-app.com node health.js # 环境变量方式
//
// ============================================================
// 输出说明
// ============================================================
//
//   简洁模式（默认）：
//     - ✅/❌ 每项结果
//     - 失败时打印请求详情 + 服务端 fetchAttempts（出站原始请求/响应）
//
//   详细模式（--verbose / -v）：
//     - 每项都打印请求详情
//     - 失败的 HLS 测试自动展示 fetchAttempts 完整信息
//
// ============================================================
// 测试分段
// ============================================================
//
//   [0]  服务端出站诊断（重点！展示源站原始请求头/响应头/body-head）
//   [1]  健康 & Manifest
//   [2]  Catalog 搜索（3源 × movie/series）
//   [3]  Meta（内部 id + IMDb id）
//   [4]  Stream 路径 2（内部 id）
//   [5]  Stream 路径 1（IMDB id）
//   [5.5] Stream 专项 tt27995113:1:1（黑鸽第一季）
//   [6]  HLS 清洗（通过 /debug/hls-clean 直接看底层）
//   [7]  调试接口
//   [8]  端到端播放验证（识别 307 降级）
//
// ============================================================
// 退出码
// ============================================================
//
//   0  全部通过
//   1  有失败项
//
// ============================================================

const BASE_URL = (
  process.argv.find((a) => a.startsWith("http")) ||
  process.env.BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/$/, "");

const VERBOSE =
  process.argv.includes("--verbose") ||
  process.argv.includes("-v") ||
  process.env.VERBOSE === "true";

const TIMEOUT = 25000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const C = {
  reset: "\x1b[0m", gray: "\x1b[90m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

const results = { total: 0, pass: 0, fail: 0, details: [] };

// ==========================================
// 统一请求封装
// ==========================================
async function request(path, { method = "GET", timeoutMs = TIMEOUT, redirect = "follow" } = {}) {
  const url = path.startsWith("http") ? path : BASE_URL + path;
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
      ok: r.ok, status: r.status, elapsed: Date.now() - t0,
      text, json, url, method,
      location: r.headers.get("location") || "",
      xhlsError: r.headers.get("x-hls-error") || "",
      xhlsDegraded: r.headers.get("x-hls-degraded") || "",
      cacheControl: r.headers.get("cache-control") || "",
      traceId: r.headers.get("x-trace-id") || "",
    };
  } catch (err) {
    return { ok: false, status: 0, elapsed: Date.now() - t0, error: err.message, text: "", json: null, url, method };
  } finally {
    clearTimeout(timer);
  }
}

// ==========================================
// 回显工具
// ==========================================
function printHlsAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return;
  console.log(`   ${C.cyan}── 源站原始请求/响应 (fetchAttempts) ──${C.reset}`);
  attempts.forEach((a) => {
    console.log(`   ${C.gray}[attempt ${a.attempt}] ${a.elapsed}ms${C.reset}`);
    const req = a.request || {};
    console.log(`   ${C.gray}  → ${req.method || "GET"} ${req.url}${C.reset}`);
    if (req.headers) {
      const h = Object.entries(req.headers).map(([k, v]) => `${k}=${String(v).slice(0, 100)}`).join(" | ");
      console.log(`   ${C.gray}    req-headers: ${h}${C.reset}`);
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
}

function printDetail(res, errorMsg) {
  const ind = "   ";
  console.log(`${ind}${C.gray}├─${C.reset} ${res.method} ${C.gray}${res.url}${C.reset}`);
  console.log(
    `${ind}${C.gray}├─${C.reset} 状态 ${res.ok ? C.green : C.red}${res.status || "ERR"}${C.reset} · ${C.gray}${res.elapsed}ms${C.reset}` +
    (res.traceId ? ` · trace ${C.magenta}${res.traceId.slice(0, 8)}${C.reset}` : "") +
    (res.cacheControl ? ` · ${C.gray}${res.cacheControl}${C.reset}` : "")
  );
  if (res.error) {
    console.log(`${ind}${C.gray}└─${C.reset} ${C.red}${res.error}${C.reset}`);
    return;
  }
  if (errorMsg) console.log(`${ind}${C.gray}├─${C.reset} ${C.yellow}问题: ${errorMsg}${C.reset}`);

  // 特殊处理 /debug/hls-clean 的 fetchAttempts
  if (res.json?.fetchAttempts) {
    console.log(`${ind}${C.gray}└─${C.reset} 响应: ${res.text.length}b, type=${res.json.type}, reason=${res.json.reason || "-"}`);
    printHlsAttempts(res.json.fetchAttempts);
    return;
  }

  // 普通 JSON
  if (res.json) {
    const parts = [];
    if (Array.isArray(res.json.metas)) parts.push(`metas=${res.json.metas.length}`);
    if (Array.isArray(res.json.streams)) parts.push(`streams=${res.json.streams.length}`);
    if (res.json.meta) parts.push(`meta=${res.json.meta.name || res.json.meta.id}`);
    if (Array.isArray(res.json.sources)) parts.push(`sources=${res.json.sources.length}`);
    if (res.json.ok !== undefined) parts.push(`ok=${res.json.ok}`);
    if (res.json.type) parts.push(`hls:${res.json.type}/${res.json.risk}`);
    console.log(`${ind}${C.gray}└─${C.reset} 响应: ${parts.join(", ") || "JSON"}`);
    return;
  }

  // 文本
  const head = res.text.slice(0, 200).replace(/\n/g, "\\n");
  console.log(`${ind}${C.gray}└─${C.reset} 响应: ${res.text.length}b "${head}"`);
}

// ==========================================
// 测试执行器
// ==========================================
async function test(category, name, path, validateFn, opts = {}) {
  const { method = "GET", detail = false, redirect = "follow" } = opts;
  results.total++;
  const res = await request(path, { method, redirect });

  let errorMsg = "", isValid = true;
  if (!res.ok) {
    isValid = false;
    errorMsg = res.error ? `请求失败: ${res.error}` : `HTTP ${res.status}`;
  } else if (validateFn) {
    try {
      const r = validateFn(res.json, res);
      if (r !== true) { isValid = false; errorMsg = String(r); }
    } catch (e) {
      isValid = false; errorMsg = `校验异常: ${e.message}`;
    }
  }

  if (isValid) {
    results.pass++;
    console.log(`  ${C.green}✅${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
    if (VERBOSE || detail) printDetail(res);
  } else {
    results.fail++;
    results.details.push({ category, name, path, errorMsg, response: res.text?.slice(0, 800) });
    console.log(`  ${C.red}❌${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
    printDetail(res, errorMsg);
  }
  return { res, isValid };
}

// ==========================================
// 主流程
// ==========================================
async function run() {
  console.log(`\n${C.cyan}================================================${C.reset}`);
  console.log(`  🔍 CatVod Addon 全量健康检查`);
  console.log(`  🌐 ${BASE_URL}`);
  console.log(`  🕒 ${new Date().toLocaleString()}`);
  console.log(`  📝 ${VERBOSE ? C.green + "详细模式" + C.reset : "简洁模式（失败才打印详情）"}`);
  if (!VERBOSE) console.log(`     ${C.gray}(--verbose 开启所有细节)${C.reset}`);
  console.log(`${C.cyan}================================================${C.reset}\n`);

  // ==========================================
  // [0] 服务端出站诊断
  // ==========================================
  console.log(`${C.cyan}[0]${C.reset} 服务端出站诊断（重点：源站原始请求/响应）`);
  const probeM3u8 = "https://p.bvvvvvvvvv1f.com/video/qingyuniandiyiji/%E7%AC%AC02%E9%9B%86/index.m3u8";
  const r0 = await test(
    "Preflight",
    "服务端能拉到 bfzy m3u8",
    `/debug/hls-clean?url=${encodeURIComponent(probeM3u8)}&src=bfzy`,
    (d) => {
      if (d.type === "error") return `${d.reason || "fetch-failed"}（出站请求失败）`;
      if (!d.originalLength) return "originalLength=0";
      return true;
    },
    { detail: true }
  );

  // 如果失败，从 fetchAttempts 里提取结论
  if (!r0.isValid && r0.res.json?.fetchAttempts) {
    const firstResp = r0.res.json.fetchAttempts.find((a) => a.response)?.response;
    const status = firstResp?.status;
    if (status) {
      console.log(`\n  ${C.yellow}📌 源站对服务端请求返回 HTTP ${status}${C.reset}`);
      const reqH = r0.res.json.fetchAttempts[0]?.request?.headers || {};
      const ua = reqH["User-Agent"] || reqH["user-agent"] || "";
      const ref = reqH["Referer"] || reqH["referer"] || "";
      console.log(`  ${C.yellow}  复现命令（本地执行对比）:${C.reset}`);
      console.log(`  ${C.gray}  curl -A "${String(ua).slice(0, 100)}" -e "${ref}" "${probeM3u8}"${C.reset}`);
      console.log(`  ${C.yellow}  如果本地 200、服务端 ${status} → 结论是【出站 IP 被屏蔽】${C.reset}\n`);
    }
  }

  // ==========================================
  // [1] 健康 & Manifest
  // ==========================================
  console.log(`\n${C.cyan}[1]${C.reset} 健康 & Manifest`);
  await test("Base", "health.ok", "/health", (d) => d.ok === true);
  await test("Base", "manifest 结构", "/manifest.json", (d) => {
    if (!d.id) return "缺 id";
    if (!d.types?.includes("movie") || !d.types?.includes("series")) return "types 缺 movie/series";
    const names = (d.resources || []).map((r) => (typeof r === "string" ? r : r.name));
    if (!names.includes("catalog") || !names.includes("meta") || !names.includes("stream")) return "resources 缺";
    if (d.catalogs?.length !== 6) return `catalogs 期望 6，实际 ${d.catalogs?.length}`;
    return true;
  }, { detail: VERBOSE });

  // ==========================================
  // [2] Catalog 搜索
  // ==========================================
  console.log(`\n${C.cyan}[2]${C.reset} Catalog 搜索（3源 × movie/series）`);
  const sources = ["bfzy", "ffzy", "lz"];
  const kwS = encodeURIComponent("庆余年");
  const kwM = encodeURIComponent("流浪地球");
  for (const src of sources) {
    await test("Catalog", `${src} series 搜索`, `/catalog/series/${src}-series/search=${kwS}.json`, (d) => {
      if (!Array.isArray(d.metas)) return "metas 非数组";
      if (d.metas.length === 0) return "未搜到";
      return true;
    }, { detail: VERBOSE });
  }
  for (const src of sources) {
    await test("Catalog", `${src} movie 搜索`, `/catalog/movie/${src}-movie/search=${kwM}.json`, (d) =>
      Array.isArray(d.metas) ? true : "metas 非数组", { detail: VERBOSE });
  }

  // ==========================================
  // [3] Meta
  // ==========================================
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
    d.meta ? true : "meta 为空（TMDB 网络/key 问题）");

  // ==========================================
  // [4] Stream 内部 id
  // ==========================================
  console.log(`\n${C.cyan}[4]${C.reset} Stream 路径 2（内部 id）`);
  const collected = [];

  const r4a = await test("Stream", "series bfzy", "/stream/series/bfzy:series:27312:1:2.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无流";
    if (!d.streams[0].url?.includes("/hls")) return "未指向 /hls";
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

  // ==========================================
  // [5] Stream IMDB
  // ==========================================
  console.log(`\n${C.cyan}[5]${C.reset} Stream 路径 1（IMDB id）`);
  const r5 = await test("Stream", "IMDB movie tt0111161", "/stream/movie/tt0111161.json", (d) => {
    if (!Array.isArray(d.streams)) return "streams 非数组";
    if (d.streams.length === 0) return "无流";
    return true;
  }, { detail: VERBOSE });
  if (r5.res.json?.streams?.length) {
    const s = r5.res.json.streams.find((x) => x.url?.includes("/hls"));
    if (s) {
      const m = s.url.match(/[?&]src=([^&]+)/);
      collected.push({ srcId: m ? m[1] : "unknown", stream: s });
    }
  }

  // ==========================================
  // [5.5] tt27995113 专项
  // ==========================================
  console.log(`\n${C.cyan}[5.5]${C.reset} Stream 专项 tt27995113:1:1`);
  const r55 = await test("Stream", "tt27995113:1:1", "/stream/series/tt27995113:1:1.json", (d) => {
    if (!Array.isArray(d.streams)) return "streams 非数组";
    if (d.streams.length === 0) return "无流";
    return true;
  }, { detail: true });
  if (r55.res.json?.streams?.length) {
    const stats = { "HLS-CLEAN": 0, SHARE: 0, DIRECT: 0 };
    r55.res.json.streams.forEach((s) => {
      if (s.url?.includes("/hls")) stats["HLS-CLEAN"]++;
      else if (/\/share\//.test(s.url || "")) stats.SHARE++;
      else if (/\.m3u8(\?|$)/i.test(s.url || "")) stats.DIRECT++;
    });
    console.log(`   ${C.gray}分类: HLS-CLEAN=${stats["HLS-CLEAN"]} SHARE=${stats.SHARE} DIRECT=${stats.DIRECT}${C.reset}`);
    r55.res.json.streams.filter((s) => s.url?.includes("/hls")).forEach((s) => {
      const m = s.url.match(/[?&]src=([^&]+)/);
      collected.push({ srcId: m ? m[1] : "unknown", stream: s });
    });
  }

  // ==========================================
  // [6] HLS 清洗（直接看底层）
  // ==========================================
  console.log(`\n${C.cyan}[6]${C.reset} HLS 清洗（/debug/hls-clean 看底层）`);
  await test("HLS", "bfzy /debug/hls-clean", `/debug/hls-clean?url=${encodeURIComponent(probeM3u8)}&src=bfzy`, (d) => {
    if (d.type === "error") return `${d.reason}（fetch 阶段失败）`;
    if (!d.originalLength) return "originalLength=0";
    if (d.type === "media" && d.originalSegments === 0) return "media 但 0 片段";
    return true;
  }, { detail: true });

  // ==========================================
  // [7] 调试接口
  // ==========================================
  console.log(`\n${C.cyan}[7]${C.reset} 调试接口`);
  await test("Debug", "sources", "/debug/sources", (d) =>
    Array.isArray(d.sources) && d.sources.length === 3 ? true : "sources 异常", { detail: VERBOSE });
  await test("Debug", "cache", "/debug/cache", (d) => typeof d.backend === "string");
  await test("Debug", "reload-rules", "/debug/reload-rules", (d) => d.ok === true, { method: "POST", detail: VERBOSE });

  // ==========================================
  // [8] 端到端（识别 307）
  // ==========================================
  console.log(`\n${C.cyan}[8]${C.reset} 端到端播放验证（识别 307 降级）`);
  if (collected.length === 0) {
    console.log(`  ${C.yellow}⚠️  无可用流${C.reset}`);
  } else {
    const seen = new Set();
    const toVerify = [];
    for (const item of collected) {
      if (seen.has(item.stream.url)) continue;
      seen.add(item.stream.url);
      toVerify.push(item);
      if (toVerify.length >= 3) break;
    }
    for (const item of toVerify) {
      const tag = item.stream.url.includes("/hls") ? "HLS-CLEAN" : "OTHER";
      const label = item.stream.name || "?";
      console.log(`  ${C.cyan}▶${C.reset} 验证流 ${C.green}[${tag}]${C.reset} ${C.blue}${label}${C.reset}`);

      let inner = null, src = item.srcId;
      try {
        const u = new URL(item.stream.url);
        inner = u.searchParams.get("url");
        src = u.searchParams.get("src") || item.srcId;
      } catch {}

      // manual 模式检测 307
      const first = await request(item.stream.url, { redirect: "manual" });
      if (first.status === 307 || first.status === 308) {
        results.pass++;
        results.total++;
        console.log(`  ${C.green}✅${C.reset} [${label}] /hls 降级重定向`);
        console.log(`   ${C.yellow}ℹ️  未过滤广告，播放器将直连源站${C.reset}`);
        if (first.location) console.log(`   ${C.gray}目标: ${first.location.slice(0, 200)}${C.reset}`);
        if (first.xhlsError) console.log(`   ${C.red}原因: ${first.xhlsError}${C.reset}`);
        if (inner) {
          const dbg = await request(`/debug/hls-clean?url=${encodeURIComponent(inner)}&src=${src}`);
          if (dbg.json?.fetchAttempts) printHlsAttempts(dbg.json.fetchAttempts);
        }
        continue;
      }

      // 正常清洗
      results.total++;
      const cleanOk = first.ok && first.text.startsWith("#EXTM3U");
      const isMaster = first.text.includes("#EXT-X-STREAM-INF");
      const firstUri = first.text.split("\n").find((l) => l.trim() && !l.startsWith("#"));

      if (!cleanOk) {
        results.fail++;
        results.details.push({ category: "E2E", name: label, errorMsg: `清洗返回异常 (HTTP ${first.status})` });
        console.log(`  ${C.red}❌${C.reset} [${label}] /hls 异常`);
        printDetail(first, `HTTP ${first.status}`);
        continue;
      }

      if (isMaster) {
        const childIsCleanEntry = (firstUri || "").includes("/hls");
        if (childIsCleanEntry) {
          results.pass++;
          console.log(`  ${C.green}✅${C.reset} [${label}] master 子清单入口正确 (${firstUri.slice(0, 80)}...)`);
        } else {
          results.fail++;
          results.details.push({ category: "E2E", name: label, errorMsg: "master 子清单入口不是 /hls" });
          console.log(`  ${C.red}❌${C.reset} [${label}] master 子清单入口错: ${firstUri}`);
        }
      } else {
        // media
        const seg = firstUri;
        if (!seg) {
          results.fail++;
          results.details.push({ category: "E2E", name: label, errorMsg: "media 无片段" });
          console.log(`  ${C.red}❌${C.reset} [${label}] media 无片段`);
        } else if (!/^https?:\/\//.test(seg)) {
          results.fail++;
          results.details.push({ category: "E2E", name: label, errorMsg: `分片未绝对化: ${seg.slice(0, 80)}` });
          console.log(`  ${C.red}❌${C.reset} [${label}] 分片未绝对化: ${seg.slice(0, 80)}`);
        } else {
          results.pass++;
          console.log(`  ${C.green}✅${C.reset} [${label}] 分片已绝对化`);
          console.log(`   ${C.gray}首分片: ${seg.slice(0, 120)}${C.reset}`);
        }
      }
    }
  }

  // ==========================================
  // 汇总
  // ==========================================
  console.log(`\n${C.cyan}====================== 汇总 ======================${C.reset}`);
  console.log(`  总计: ${results.total} | ${C.green}通过: ${results.pass}${C.reset} | ${results.fail > 0 ? C.red : C.gray}失败: ${results.fail}${C.reset}`);

  if (results.fail > 0) {
    console.log(`\n${C.red}!!! 失败详情 !!!${C.reset}`);
    results.details.forEach((d, i) => {
      console.log(`\n[${i + 1}] ${d.category} | ${d.name}`);
      if (d.path) console.log(`    路径: ${d.path}`);
      console.log(`    原因: ${d.errorMsg}`);
      if (d.response) console.log(`    响应片段: ${d.response.slice(0, 300)}`);
    });
    process.exit(1);
  }
  console.log(`\n${C.green}🎉 全部通过${C.reset}\n`);
}

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });