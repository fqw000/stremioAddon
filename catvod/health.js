#!/usr/bin/env node
// health.js
// 用法：
//   node health.js                          # 默认 http://127.0.0.1:3000, 简洁模式
//   node health.js http://localhost:3000    # 指定地址
//   node health.js --verbose                # 详细模式
//   node health.js -v http://localhost:3000 # 详细模式 + 指定地址
//   VERBOSE=true node health.js             # 通过环境变量开启详细模式

const BASE_URL = (
  process.argv.find(a => a.startsWith("http")) ||
  process.env.BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/$/, "");

// 解析详细模式开关
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v") || process.env.VERBOSE === "true";
const TIMEOUT = 15000;

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };

const results = { total: 0, pass: 0, fail: 0, details: [] };

// ==========================================
// 1. 统一请求封装
// ==========================================
async function request(path) {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "HealthCheck/1.0" } });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    
    return { ok: res.ok, status: res.status, elapsed, text, json, url };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, elapsed: Date.now() - start, error: err.message, url };
  }
}

// ==========================================
// 2. 详细日志打印器
// ==========================================
function printDetail(res, errorMsg = null) {
  const ind = C.gray;
  console.log(`   ${ind}├─ 请求: GET ${res.url}${C.reset}`);
  console.log(`   ${ind}├─ 状态: ${res.status || "N/A"}${C.reset}`);
  console.log(`   ${ind}├─ 耗时: ${res.elapsed}ms${C.reset}`);
  
  if (errorMsg) {
    console.log(`   ${C.yellow}├─ 表现: ${errorMsg}${C.reset}`);
  }
  
  if (res.error) {
    console.log(`   ${ind}└─ 错误: ${C.red}${res.error}${C.reset}`);
    return;
  }
  
  if (res.json) {
    // 提取关键摘要，便于直接看出是否正常
    const summary = [];
    if (Array.isArray(res.json.metas)) summary.push(`metas.length=${res.json.metas.length}`);
    if (Array.isArray(res.json.streams)) summary.push(`streams.length=${res.json.streams.length}`);
    if (res.json.meta) summary.push(`meta=${res.json.meta.name || res.json.meta.id || "(null)"}`);
    if (res.json.ok !== undefined) summary.push(`ok=${res.json.ok}`);
    if (Array.isArray(res.json.sources)) summary.push(`sources.length=${res.json.sources.length}`);
    
    const summaryStr = summary.length > 0 ? ` [${summary.join(", ")}]` : "";
    const str = JSON.stringify(res.json);
    const snippet = str.length > 300 ? str.slice(0, 300) + "..." : str;
    console.log(`   ${ind}└─ 响应:${summaryStr} ${ind}${snippet}${C.reset}`);
  } else if (res.text) {
    // 非 JSON 文本（例如 HLS m3u8）
    const lines = res.text.split("\n");
    const preview = lines.slice(0, 5).join("\n      ");
    const more = lines.length > 5 ? `\n      ... (共 ${lines.length} 行, ${res.text.length} 字节)` : "";
    console.log(`   ${ind}└─ 文本响应 (${res.text.length} 字节):${C.reset}`);
    console.log(`      ${ind}${preview}${more}${C.reset}`);
  } else {
    console.log(`   ${ind}└─ 空响应${C.reset}`);
  }
}

// ==========================================
// 3. 测试执行器
// ==========================================
async function test(category, name, path, validateFn) {
  results.total++;
  const res = await request(path);

  let errorMsg = "";
  let isValid = true;

  if (!res.ok) {
    isValid = false;
    errorMsg = res.error ? `请求失败: ${res.error}` : `HTTP 状态码 ${res.status}`;
  } else {
    try {
      const validateResult = validateFn(res.json, res);
      if (validateResult !== true) {
        isValid = false;
        errorMsg = validateResult;
      }
    } catch (err) {
      isValid = false;
      errorMsg = `校验逻辑异常: ${err.message}`;
    }
  }

  if (isValid) {
    results.pass++;
    console.log(`${C.green}✅ [PASS]${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
    // 详细模式：成功也打印详情
    if (VERBOSE) printDetail(res);
  } else {
    results.fail++;
    console.error(`${C.red}❌ [FAIL]${C.reset} ${category} | ${name} ${C.gray}(${res.elapsed}ms)${C.reset}`);
    // 失败时：无论是否详细模式，都打印详情
    printDetail(res, errorMsg);
    
    results.details.push({
      category, name,
      url: res.url,
      errorMsg,
      status: res.status,
      response: res.text ? res.text.slice(0, 1000) : null
    });
  }
}

// ==========================================
// 4. 主流程
// ==========================================
async function run() {
  console.log(`\n${C.cyan}======================================================${C.reset}`);
  console.log(`  🔍 CatVod Addon 全面健康检查报告`);
  console.log(`  🌐 目标环境: ${BASE_URL}`);
  console.log(`  🕒 测试时间: ${new Date().toLocaleString()}`);
  console.log(`  📝 日志模式: ${VERBOSE ? C.green + "详细模式 (verbose)" + C.reset : "简洁模式 (仅异常打印详情)"}`);
  if (!VERBOSE) {
    console.log(`     ${C.gray}(使用 --verbose 或 VERBOSE=true 可开启所有细节输出)${C.reset}`);
  }
  console.log(`${C.cyan}======================================================${C.reset}\n`);

  // 1. 基础信息
  await test("Base", "Manifest 结构", "/manifest.json", (d) => {
    if (!d.id) return "缺少 id";
    if (!d.catalogs || d.catalogs.length !== 6) return `期望 6 个 catalog，实际 ${d.catalogs?.length}`;
    // 兼容 stream 是对象或字符串
    if (!d.resources.some(r => (typeof r === "string" ? r : r.name) === "stream")) return "resources 缺少 stream";
    return true;
  });

  // 2. Catalog 搜索（3源 × 电影/剧集）
  const sources = ["bfzy", "ffzy", "lz"];
  const keywordSeries = encodeURIComponent("庆余年");
  const keywordMovie = encodeURIComponent("流浪地球");

  for (const src of sources) {
    await test("Catalog", `${src} 剧集搜索`, `/catalog/series/${src}-series/search=${keywordSeries}.json`, (d) => {
      if (!Array.isArray(d.metas)) return "metas 非数组";
      if (d.metas.length === 0) return "未搜到剧集";
      return true;
    });

    await test("Catalog", `${src} 电影搜索`, `/catalog/movie/${src}-movie/search=${keywordMovie}.json`, (d) => {
      if (!Array.isArray(d.metas)) return "metas 非数组";
      if (d.metas.length === 0) return "未搜到电影";
      return true;
    });
  }

  // 3. Meta 详情
  await test("Meta", "内部 ID (剧集)", "/meta/series/bfzy:series:27312.json", (d) => {
    if (!d.meta) return "meta 为空";
    if (d.meta.type !== "series") return "type 错误";
    if (!d.meta.videos || d.meta.videos.length === 0) return "缺少 videos";
    return true;
  });

  await test("Meta", "内部 ID (电影)", "/meta/movie/lz:movie:14547.json", (d) => {
    if (!d.meta) return "meta 为空";
    if (d.meta.type !== "movie") return "type 错误";
    return true;
  });

  await test("Meta", "IMDb ID 映射 (tt0111161)", "/meta/movie/tt0111161.json", (d) => {
    if (!d.meta) return "meta 为空 (TMDB 可能网络不通或 meta.js 未支持 tt)";
    return true;
  });

  // 4. Stream 播放流
  await test("Stream", "内部 ID (剧集第2集)", "/stream/series/bfzy:series:27312:1:2.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无返回流";
    if (!d.streams[0].url.includes("/hls/clean")) return "未经过 HLS 清洗入口";
    return true;
  });

  await test("Stream", "内部 ID (电影)", "/stream/movie/lz:movie:14547.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无返回流";
    return true;
  });

  await test("Stream", "IMDb ID (tt0111161)", "/stream/movie/tt0111161.json", (d) => {
    if (!Array.isArray(d.streams) || d.streams.length === 0) return "无返回流 (TMDB/匹配失败)";
    return true;
  });

  // 5. HLS 清洗测试
  const testM3u8 = encodeURIComponent("https://p.bvvvvvvvvv1f.com/video/xiaoshenkedejiushu/HD中字/index.m3u8");
  await test("HLS", "清洗并绝对化 (bfzy)", `/hls/clean?url=${testM3u8}&src=bfzy`, (d, res) => {
    if (!res.text.startsWith("#EXTM3U")) return "未返回 m3u8 格式";
    if (!res.text.includes("https://")) return "分片未绝对化";
    return true;
  });

  // 6. 调试接口
  await test("Debug", "源健康检测", "/debug/sources", (d) => {
    if (!Array.isArray(d.sources) || d.sources.length !== 3) return "源状态获取不全";
    return true;
  });

  // ===== 汇总报告 =====
  console.log(`\n${C.cyan}====================== 测 试 汇 总 ======================${C.reset}`);
  console.log(`  总计: ${results.total} | ${C.green}通过: ${results.pass}${C.reset} | ${results.fail > 0 ? C.red : C.gray}失败: ${results.fail}${C.reset}`);
  
  if (results.fail > 0) {
    console.log(`\n${C.red}!!! 发现异常，汇总如下 !!!${C.reset}`);
    results.details.forEach((d, i) => {
      console.log(`\n[${i + 1}] ${d.category} - ${d.name}`);
      console.log(`    - 请求路径: ${d.url}`);
      console.log(`    - 失败原因: ${d.errorMsg}`);
      console.log(`    - 响应表现: ${d.response}`);
    });
    process.exit(1);
  } else {
    console.log(`\n${C.green}🎉 完美！所有核心功能测试通过。${C.reset}\n`);
  }
}

run();