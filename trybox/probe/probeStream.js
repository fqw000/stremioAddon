// probeStream.mjs
// 运行：node probeStream.mjs
// 依赖：npm install seroval @tanstack/router-core
// 提示：package.json 建议加 "type": "module"，或将文件命名为 .mjs

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ============ 配置 ============
const SUPABASE_URL =  process.env.SUPABASE_URL || 'https://***********.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhb***********iy9hFVus';

// 首次种子；一旦 .trybox-session.json 存在，后续都读文件
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || 'b7rye5kqbzno';

const SERVER_FN = process.env.SERVER_FN || 'https://***********18105012';

const DEFAULT_LANG = 'zh-CN';

// 测试目标
const MOVIE = { tmdbId: 687163, kind: 'movie' };
const TV    = { tmdbId: 2316, kind: 'tv', season: 1, episode: 5 };

// ============ 通用工具 ============
const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

const utf8Size = (s) => new TextEncoder().encode(s).length;
const toKB = (bytes) => +(bytes / 1024).toFixed(2);

const section = (title) => console.log(`\n=== ${title} ===`);

/**
 * 打印 payload 说明（单行紧凑模式）
 */
function logPayload(tag, payload, opts = {}) {
  const { raw, note } = opts;
  let line = `[${tag}] [payload] ${note ?? '请求体如下'}`;
  try {
    line += ` ${JSON.stringify(payload)}`;
  } catch {
    line += ' <无法序列化>';
  }
  console.log(line);

  if (raw && raw !== payload) {
    console.log(`[${tag}] [payload:raw] ${JSON.stringify(raw)}`);
  }
}

/** 字段完整性通用统计 */
function statFields(items, fields) {
  const stats = {};
  fields.forEach((f) => (stats[f] = { present: 0, missing: 0 }));
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const f of fields) {
      const v = item[f];
      if (v === null || v === undefined || v === '') stats[f].missing++;
      else stats[f].present++;
    }
  }
  return stats;
}

// ============ seroval 按需加载 ============
let _serovalCache = null;
async function loadSeroval() {
  if (_serovalCache) return _serovalCache;
  const seroval = await import('seroval');
  const require = createRequire(import.meta.url);
  const routerCore = require('@tanstack/router-core');
  _serovalCache = {
    fromJSON: seroval.fromJSON,
    fromCrossJSON: seroval.fromCrossJSON,
    defaultSerovalPlugins: routerCore.defaultSerovalPlugins,
  };
  return _serovalCache;
}

// ============ Refresh token 滚动持久化 ============
// 服务端开启了 Refresh Token Rotation（默认），每次用 refresh_token 换
// access_token 时旧的立即失效，响应里会带一个新的 refresh_token。
// 必须每次成功刷新后把新值落盘，否则下次启动还在用旧值 → already_used。
//
// 优先级：.trybox-session.json > REFRESH_TOKEN（仅首次作为种子）
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SESSION_FILE = join(__dirname, '.trybox-session.json');

function loadRefreshToken() {
  if (existsSync(SESSION_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (data.refresh_token) return data.refresh_token;
    } catch (e) {
      console.warn(`[stream] .trybox-session.json 解析失败，回退到 REFRESH_TOKEN: ${e.message}`);
    }
  }
  return REFRESH_TOKEN;
}

function saveRefreshToken(token, extra = {}) {
  const payload = {
    refresh_token: token,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`[stream] .trybox-session.json 写入失败: ${e.message}`);
  }
}

let _cachedToken = null;
let _cachedRefresh = null;

async function getAccessToken(force = false) {
  if (_cachedToken && !force) {
    console.log('[stream] 复用已缓存的 access_token（未触发刷新）');
    return _cachedToken;
  }

  if (!_cachedRefresh) {
    _cachedRefresh = loadRefreshToken();
  }

  console.log(`[stream] refresh_token (旧): ${_cachedRefresh}`);

  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: _cachedRefresh }),
    }
  );
  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `刷新失败: ${JSON.stringify(data)}\n` +
        `  当前使用的 refresh_token 前 8 位: ${String(_cachedRefresh).slice(0, 8)}...\n` +
        `  若报 already_used，说明该值已被消耗，请重新从浏览器获取并覆盖 ` +
        `.trybox-session.json 或 REFRESH_TOKEN。`
    );
  }

  _cachedToken = data.access_token;

  if (data.refresh_token) {
    _cachedRefresh = data.refresh_token;
    saveRefreshToken(_cachedRefresh, {
      expires_at: data.expires_at || null,
      token_type: data.token_type || 'bearer',
    });
    console.log(`[stream] refresh_token (新): ${_cachedRefresh}`);
  }

  return _cachedToken;
}

// ============ 构造请求体 ============
function buildStreamRequestBody({ tmdbId, kind, season, episode }) {
  const dataObj =
    kind === 'tv'
      ? {
          t: 10,
          i: 1,
          p: {
            k: ['tmdb_id', 'kind', 'season', 'episode'],
            v: [
              { t: 0, s: tmdbId },
              { t: 1, s: 'tv' },
              { t: 0, s: season },
              { t: 0, s: episode },
            ],
          },
          o: 0,
        }
      : {
          t: 10,
          i: 1,
          p: {
            k: ['tmdb_id', 'kind'],
            v: [
              { t: 0, s: tmdbId },
              { t: 1, s: 'movie' },
            ],
          },
          o: 0,
        };

  return {
    t: { t: 10, i: 0, p: { k: ['data'], v: [dataObj] }, o: 0 },
    f: 127,
    m: [],
  };
}

// ============ 数据量统计 ============
function streamSummarize(result, parsed, rawText, elapsed) {
  const rawSize = utf8Size(rawText);
  const meta = parsed?.result?.meta ?? {};
  const links = [
    ...(result?.mbp_links ?? []),
    ...(result?.links ?? []),
    ...(result?.beta_links ?? []),
  ];
  const withUrl = links.filter((l) => l && l.url);
  const hls = withUrl.filter((l) => l.url.includes('.m3u8'));
  const vipLocked = withUrl.filter((l) => l.vip_locked);

  const byQuality = {};
  for (const l of withUrl) {
    const q = (l.quality || 'Unknown').toUpperCase();
    byQuality[q] = (byQuality[q] || 0) + 1;
  }

  const byGroup = {};
  for (const l of withUrl) {
    const g = l.group || 'Unknown';
    byGroup[g] = (byGroup[g] || 0) + 1;
  }

  return {
    耗时ms: +elapsed.toFixed(1),
    原始大小KB: toKB(rawSize),
    原始大小Bytes: rawSize,
    顶层字段: Object.keys(result || {}),
    链接总数: links.length,
    有效链接数: withUrl.length,
    HLS链接数: hls.length,
    VIP锁定数: vipLocked.length,
    质量分布: byQuality,
    分组分布: byGroup,
    媒体字段: Object.keys(meta),
  };
}

// ============ 字段完整性 ============
function streamFieldStats(result) {
  const fields = ['url', 'quality', 'size', 'group', 'file_id', 'file_name', 'vip_locked'];
  const links = [
    ...(result?.mbp_links ?? []),
    ...(result?.links ?? []),
    ...(result?.beta_links ?? []),
  ];
  return { total: links.length, stats: statFields(links, fields) };
}

// ============ 解析响应 ============
function parseStreamLinks(json) {
  const result = json?.result ?? {};
  const meta = result.meta ?? {};
  const links = [
    ...(result.mbp_links ?? []),
    ...(result.links ?? []),
    ...(result.beta_links ?? []),
  ];

  const streams = links
    .filter((l) => l && l.url)
    .map((l) => ({
      quality: l.quality || 'Unknown',
      url: l.url,
      size: l.size || 'Unknown',
      group: l.group || 'Unknown',
      fileId: l.file_id || '',
      fileName: l.file_name || '',
      vipLocked: l.vip_locked ?? false,
      isHls: l.url.includes('.m3u8'),
    }));

  const order = {
    '4K': 0, '2160P': 0, '2160p': 0,
    '1080P': 1, '1080p': 1,
    '720P': 2, '720p': 2,
    '360P': 3, '360p': 3,
    AUTO: 4, ORG: 5,
  };
  streams.sort((a, b) => (order[a.quality] ?? 99) - (order[b.quality] ?? 99));

  return { meta, streams, result };
}

// ============ 主探针函数 ============
async function probeStream(accessToken, target, lang = DEFAULT_LANG) {
  const { fromJSON, fromCrossJSON, defaultSerovalPlugins } = await loadSeroval();

  const body = buildStreamRequestBody(target);
  const label =
    target.kind === 'tv'
      ? `tv tmdbId=${target.tmdbId} S${target.season}E${target.episode}`
      : `movie tmdbId=${target.tmdbId}`;

  console.log(`\n[stream] 请求: ${label}`);

  // 解码出可读对象（供日志展示；解码失败不影响实际请求）
  let decoded = null;
  try {
    decoded = fromJSON(body, { plugins: defaultSerovalPlugins });
  } catch (e) {
    console.log(`[stream] payload 解码失败: ${e.message}`);
  }

  logPayload('stream', decoded ?? target, {
    raw: body,
    note: decoded
      ? '解码后的请求体（同时给出原始 seroval 结构）'
      : '原始 seroval 结构（解码失败，仅显示原文）',
  });

  console.log(`[stream] URL: ${SERVER_FN}`);

  const t0 = now();
  const res = await fetch(SERVER_FN, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-trybox-lang': lang,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
      Origin: 'https://trybox.app',
      Referer: 'https://trybox.app/',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  const elapsed = now() - t0;

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }

  let parsed;
  try {
    parsed = fromCrossJSON(JSON.parse(raw), { plugins: defaultSerovalPlugins });
  } catch (e) {
    console.error('[stream] 解析失败的原始响应:');
    console.error(raw.slice(0, 3000));
    throw new Error(`解析响应失败: ${e.message}`);
  }

  if (parsed.error) throw new Error(`服务端错误: ${JSON.stringify(parsed.error)}`);

  const { meta, streams, result } = parseStreamLinks(parsed);

  section('数据量统计');
  console.log(streamSummarize(result, parsed, raw, elapsed));

  section('字段完整性');
  console.log(streamFieldStats(result));

  section('内容摘要');

  console.log('[媒体信息]', {
    title: meta.title || '未知',
    year: meta.year || '未知',
    imdbId: meta.imdb_id || '未知',
    type: target.kind,
    ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : {}),
  });

  if (!streams.length) {
    console.log('[streams] 未找到可播放链接');
  } else {
    console.log(`[streams] 共 ${streams.length} 条`);
    console.log('\n[播放链接]');
    streams.slice(0, 10).forEach((s, i) => {
      console.log(
        `  ${i + 1}. ${s.quality} | ${s.isHls ? 'HLS' : 'RAW'} | ${s.group} | ` +
          `大小: ${s.size} | VIP: ${s.vipLocked ? '锁定' : '可用'}`
      );
      console.log(`     URL: ${s.url}`);
    });
    if (streams.length > 10) console.log(`  ... 还有 ${streams.length - 10} 条`);

    const best = streams.find((s) => s.isHls) || streams[0];
    console.log(`\n[主播放地址] ${best.url}`);
  }

  return { meta, streams, result, elapsed };
}

// ============ 主流程 ============
async function main() {
  // 依赖检查：缺 seroval 就直接退出
  try {
    await loadSeroval();
  } catch (e) {
    console.error(
      '[stream] 缺少 seroval 依赖。如需启用：npm install seroval @tanstack/router-core'
    );
    process.exit(1);
  }

  console.log('[stream] 获取 access_token...');
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    console.error('[stream] 获取 access_token 失败:', e.message);
    process.exit(1);
  }
  console.log('[stream] access_token 获取成功');

  // 电影
  try {
    await probeStream(accessToken, MOVIE);
  } catch (e) {
    console.error('\n[stream] 电影失败:', e.message);
  }

  // 电视剧
  try {
    await probeStream(accessToken, TV);
  } catch (e) {
    console.error('\n[stream] 电视剧失败:', e.message);
  }

  console.log('\n[stream] 完成');
}

main().catch((e) => {
  console.error('[stream] 致命错误:', e);
  process.exit(1);
});