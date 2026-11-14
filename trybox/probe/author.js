/**
 * TryBox 播放地址获取脚本（电影 + 电视剧）
 *
 * 依赖：Node.js 18+
 * 运行：node trybox.mjs
 *
 * 请求体严格遵循 TryBox (TanStack Start) 的序列化格式：
 *   电影:  k=["tmdb_id","kind"]                        v=[{0,tmdbId},{1,"movie"}]
 *   电视剧: k=["tmdb_id","kind","season","episode"]     v=[{0,tmdbId},{1,"tv"},{0,season},{0,episode}]
 */

// ============ 配置 ============
const SUPABASE_URL = 'https://saichcuwzbncuqnqhuul.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWNoY3V3emJuY3VxbnFodXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTg4MjUsImV4cCI6MjA5OTk3NDgyNX0.v0KsTzaaiHUTvtA_W-HuAOQul3E7cxnbw4Kiy9hFVus';
const REFRESH_TOKEN = 'axmnt7pfwkrx';

const TRYBOX_SERVER_FN =
  'https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15';

// ============ 日志 & 工具 ============
const log = (...a) => console.log('[TryBox]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ 1. 刷新 access_token ============
async function refreshAccessToken() {
  log('刷新 access_token ...');
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
    }
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`刷新失败 HTTP ${res.status}: ${text.slice(0, 300)}`);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`刷新响应不是 JSON: ${text.slice(0, 200)}`); }

  if (!data.access_token) throw new Error(`没有 access_token: ${text.slice(0, 200)}`);

  log('access_token OK, expires_in =', data.expires_in);
  return data.access_token;
}

// ============ 2. 构建请求体（电影 / 电视剧） ============
/**
 * 电影:
 *   {t:{t:10,i:0,p:{k:["data"],v:[
 *      {t:10,i:1,p:{k:["tmdb_id","kind"],v:[{t:0,s:tmdbId},{t:1,s:"movie"}]},o:0}
 *   ]},o:0},f:127,m:[]}
 *
 * 电视剧:
 *   {t:{t:10,i:0,p:{k:["data"],v:[
 *      {t:10,i:1,p:{k:["tmdb_id","kind","season","episode"],
 *                   v:[{t:0,s:tmdbId},{t:1,s:"tv"},{t:0,s:season},{t:0,s:episode}]},o:0}
 *   ]},o:0},f:127,m:[]}
 */
function buildRequestBody(target) {
  const { tmdbId, kind } = target;

  let inner;
  if (kind === 'tv') {
    const { season, episode } = target;
    if (!Number.isInteger(season) || !Number.isInteger(episode)) {
      throw new Error('电视剧需要整数 season 和 episode');
    }
    inner = {
      t: 10,
      i: 1,
      p: {
        k: ['tmdb_id', 'kind', 'season', 'episode'],
        v: [
          { t: 0, s: tmdbId },      // 0 = number
          { t: 1, s: 'tv' },        // 1 = string
          { t: 0, s: season },
          { t: 0, s: episode },
        ],
      },
      o: 0,
    };
  } else {
    // 默认按电影处理
    inner = {
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
  }

  return {
    t: { t: 10, i: 0, p: { k: ['data'], v: [inner] }, o: 0 },
    f: 127,
    m: [],
  };
}

// ============ 3. 调用 TryBox Server Function ============
async function fetchPlaySource(accessToken, target) {
  const body = buildRequestBody(target);

  log('请求播放地址：');
  log('  tmdb_id:', target.tmdbId, '| kind:', target.kind,
    target.kind === 'tv' ? `| S${target.season}E${target.episode}` : '');
  log('  body:', JSON.stringify(body));

  const res = await fetch(TRYBOX_SERVER_FN, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-trybox-lang': 'zh-CN',
      'User-Agent': UA,
      'Origin': 'https://trybox.app',
      'Referer': 'https://trybox.app/',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (res.status === 401) {
    const err = new Error(`401 Unauthorized: ${text.slice(0, 200)}`);
    err.code = 401;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  try { return JSON.parse(text); }
  catch { throw new Error(`响应不是 JSON: ${text.slice(0, 300)}`); }
}

// ============ 4. 解析序列化响应 ============
function parseStreamLinks(json) {
  const result = json?.result ?? {};
  const meta = result.meta ?? {};
  const links = result.links ?? [];

  const streams = links
    .filter((l) => l && l.url)
    .map((l) => ({
      quality: l.quality || 'Unknown',
      url: l.url,
      size: l.size || 'Unknown',
      group: l.group || 'Unknown',
      fileId: l.file_id || '',
      vipLocked: l.vip_locked ?? false,
      isHls: l.url.includes('.m3u8'),
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

// ============ 5. 打印结果 ============
function printResult(target, { meta, streams }) {
  console.log('\n========== 媒体信息 ==========');
  console.log('类型 :', target.kind === 'tv' ? `TV S${target.season}E${target.episode}` : 'Movie');
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

  const hls = streams.find((s) => s.isHls);
  const best = hls || streams[0];
  console.log('\n========== 主播放地址 ==========');
  console.log(best.url);
  return best.url;
}

// ============ 6. 高层封装：获取一次 ============
async function getStreams(target) {
  let accessToken = await refreshAccessToken();

  let json;
  try {
    json = await fetchPlaySource(accessToken, target);
  } catch (err) {
    if (err.code === 401) {
      log('收到 401，强制刷新后重试 ...');
      await sleep(800);
      accessToken = await refreshAccessToken();
      json = await fetchPlaySource(accessToken, target);
    } else {
      throw err;
    }
  }

  return parseStreamLinks(json);
}

// ============ 7. 主流程：演示电影 + 电视剧 ============
async function main() {
  // -------- 测试 1：电影 Project Hail Mary (2026) --------
  const movieTarget = {
    tmdbId: 687163,
    kind: 'movie',
  };

  try {
    const movieResult = await getStreams(movieTarget);
    printResult(movieTarget, movieResult);
  } catch (err) {
    console.error('\n[电影] 失败:', err.message);
  }

  // -------- 测试 2：电视剧 TMDB 299167，S1E5 --------
  const tvTarget = {
    tmdbId: 299167,
    kind: 'tv',
    season: 1,
    episode: 5,
  };

  try {
    const tvResult = await getStreams(tvTarget);
    printResult(tvTarget, tvResult);
  } catch (err) {
    console.error('\n[电视剧] 失败:', err.message);
  }
}

main().catch((err) => {
  console.error('\n[TryBox] 致命错误:', err);
  process.exit(1);
});