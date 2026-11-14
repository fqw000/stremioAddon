// trybox.mjs
// 依赖：node >= 18
// 安装：npm install seroval @tanstack/router-core


const { fromJSON, fromCrossJSON } = require('seroval');
const { defaultSerovalPlugins } = require('@tanstack/router-core');

// ============ 配置 ============
const SUPABASE_URL = 'https://saichcuwzbncuqnqhuul.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWNoY3V3emJuY3VxbnFodXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTg4MjUsImV4cCI6MjA5OTk3NDgyNX0.v0KsTzaaiHUTvtA_W-HuAOQul3E7cxnbw4Kiy9hFVus';
const REFRESH_TOKEN = 'axmnt7pfwkrx';

const SERVER_FN = 'https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012';

// 测试目标
const MOVIE = { tmdbId: 687163, kind: 'movie' };
const TV    = { tmdbId: 2316, kind: 'tv', season: 1, episode: 5 };

// ============ 日志 ============
const log = (...a) => console.log('[TryBox]', ...a);

// ============ 1. 刷新 access_token ============
async function getAccessToken() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`刷新失败: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ============ 2. 构造请求体 ============
function buildRequestBody({ tmdbId, kind, season, episode }) {
  const dataObj = kind === 'tv'
    ? {
        t: 10, i: 1,
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
        t: 10, i: 1,
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

// ============ 3. 解析响应，提取链接 ============
function parseStreamLinks(json) {
  const result = json?.result ?? {};
  const meta   = result.meta ?? {};

  // 关键：链接在 mbp_links，同时兼容 links / beta_links
  const links = [
    ...(result.mbp_links ?? []),
    ...(result.links ?? []),
    ...(result.beta_links ?? []),
  ];

  const streams = links
    .filter((l) => l && l.url)
    .map((l) => ({
      quality:   l.quality   || 'Unknown',
      url:       l.url,
      size:      l.size      || 'Unknown',
      group:     l.group     || 'Unknown',
      fileId:    l.file_id   || '',
      fileName:  l.file_name || '',
      vipLocked: l.vip_locked ?? false,
      isHls:     l.url.includes('.m3u8'),
    }));

  const order = {
    '4K': 0, '2160P': 0, '2160p': 0,
    '1080P': 1, '1080p': 1,
    '720P': 2, '720p': 2,
    '360P': 3, '360p': 3,
    'AUTO': 4, 'ORG': 5,
  };
  streams.sort((a, b) => (order[a.quality] ?? 99) - (order[b.quality] ?? 99));

  return { meta, streams };
}

// ============ 4. 请求 + 解析 ============
async function fetchStreams(accessToken, target) {
  const body = buildRequestBody(target);

  // 回显请求 payload
  try {
    const decoded = fromJSON(body, { plugins: defaultSerovalPlugins });
    log('请求 payload:', JSON.stringify(decoded));
  } catch (e) {
    log('payload 解码失败:', e.message);
  }

  const res = await fetch(SERVER_FN, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-trybox-lang': 'zh-CN',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15',
      'Origin': 'https://trybox.app',
      'Referer': 'https://trybox.app/',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }

  let parsed;
  try {
    parsed = fromCrossJSON(JSON.parse(raw), { plugins: defaultSerovalPlugins });
  } catch (e) {
    throw new Error(`解析响应失败: ${e.message}`);
  }

  if (parsed.error) throw new Error(`服务端错误: ${JSON.stringify(parsed.error)}`);

  return parseStreamLinks(parsed);
}

// ============ 5. 打印结果 ============
function printResult(target, { meta, streams }) {
  console.log('\n========== 媒体信息 ==========');
  console.log('类型 :', target.kind === 'tv'
    ? `TV S${target.season}E${target.episode}`
    : 'Movie');
  console.log('标题 :', meta.title || '未知');
  console.log('年份 :', meta.year || '未知');
  console.log('IMDb :', meta.imdb_id || '未知');

  console.log('\n========== 播放链接 ==========');
  if (streams.length === 0) {
    console.log('未找到可播放链接');
    return null;
  }

  streams.forEach((s, i) => {
    console.log(`\n[${i + 1}] ${s.quality} | ${s.isHls ? 'HLS' : 'RAW'} | ${s.group}`);
    console.log(`    大小 : ${s.size}`);
    console.log(`    VIP  : ${s.vipLocked ? '锁定' : '可用'}`);
    console.log(`    URL  : ${s.url}`);
  });

  const best = streams.find((s) => s.isHls) || streams[0];
  console.log('\n========== 主播放地址 ==========');
  console.log(best.url);
  return best.url;
}

// ============ 6. 主流程 ============
async function main() {
  const accessToken = await getAccessToken();
  log('access_token 获取成功');

  // 电影
  try {
    const movieResult = await fetchStreams(accessToken, MOVIE);
    printResult(MOVIE, movieResult);
  } catch (e) {
    console.error('\n[电影] 失败:', e.message);
  }

  // 电视剧
  try {
    const tvResult = await fetchStreams(accessToken, TV);
    printResult(TV, tvResult);
  } catch (e) {
    console.error('\n[电视剧] 失败:', e.message);
  }
}

main().catch((e) => {
  console.error('[TryBox] 致命错误:', e);
  process.exit(1);
});