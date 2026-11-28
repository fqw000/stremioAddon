'use strict';

// 央视片库 addon 深度健康检查。
// 用法：
//   node health.js                        # 默认 http://127.0.0.1:7120
//   node health.js http://192.168.1.5:7120
//   node health.js --json                 # 额外输出 JSON 报告
//
// 检查粒度：配置页 → manifest → catalog → meta → stream → 画质过滤 →
// H5e m3u8 改写 → TS 解密 → ffprobe 真分辨率 → 央视源站接口 → 日志系统与实时日志页。

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configLib = require('./lib/config');

const args = process.argv.slice(2);
const base = (args.find(a => /^https?:\/\//i.test(a)) || process.env.ADDON_URL || 'http://127.0.0.1:7120').replace(/\/+$/, '');
const wantJson = args.includes('--json');
const results = [];

function group(title) {
  console.log(`\n=== ${title} ===`);
}

function record(status, name, detail = '') {
  results.push({ status, name, detail });
  const prefix = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log(`${prefix}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name, ok, detail = '') {
  record(ok ? 'PASS' : 'FAIL', name, detail);
}

function skip(name, detail = '') {
  record('SKIP', name, detail);
}

function allCfg(debug = false) {
  const catalogs = {};
  configLib.DEFAULT_CATALOG_IDS.forEach(id => { catalogs[id] = true; });
  const qualities = {};
  configLib.DEFAULT_QUALITY_IDS.forEach(id => { qualities[id] = true; });
  return { version: 2, catalogs, qualities, debug };
}

function cfgPath(cfg) {
  return `/${encodeURIComponent(JSON.stringify(cfg))}`;
}

function selectedCfg(catalogIds, qualityIds, debug = false) {
  const catalogs = {};
  configLib.DEFAULT_CATALOG_IDS.forEach(id => { catalogs[id] = catalogIds.includes(id); });
  const qualities = {};
  configLib.DEFAULT_QUALITY_IDS.forEach(id => { qualities[id] = qualityIds.includes(id); });
  return { version: 2, catalogs, qualities, debug };
}

// 三个开关组合：streamEnabled / encryptedUrl / decryptProxy
function switchCfg({ streamEnabled = true, encryptedUrl = true, decryptProxy = true } = {}) {
  const qualities = {};
  configLib.DEFAULT_QUALITY_IDS.forEach(id => { qualities[id] = true; });
  return { version: 2, catalogs: allCfg().catalogs, qualities, streamEnabled, encryptedUrl, decryptProxy, debug: false };
}

function isProxyUrl(s) { return /\/h5e\/m3u8\//.test(s.url || ''); }
function isRawH5eUrl(s) { return /\/asp\/(h5e|enc2?)\//.test(s.url || ''); }

async function request(urlOrPath, options = {}) {
  const url = /^https?:\/\//i.test(urlOrPath) ? urlOrPath : base + urlOrPath;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000);
  try {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      signal: controller.signal,
      redirect: 'follow'
    });
    const buffer = Buffer.from(await resp.arrayBuffer());
    return {
      url,
      status: resp.status,
      headers: resp.headers,
      text: buffer.toString('utf8'),
      buffer,
      bytes: buffer.length,
      ms: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

// 央视播放 API 偶发 SSL / CDN 节点抖动会导致单次 stream 为 0，
// 健康检查对 stream 请求重试几次，避免偶发波动造成误报。
async function getStreamsWithRetry(cfg, id, tries = 5) {
  let last = [];
  for (let i = 0; i < tries; i++) {
    const r = await getJson(`${cfgPath(cfg)}/stream/series/${encodeURIComponent(id)}.json`);
    last = r.body?.streams || [];
    if (last.length) return last;
  }
  return last;
}

async function getJson(urlOrPath, options) {
  const r = await request(urlOrPath, options);
  let body = null;
  try { body = JSON.parse(r.text); } catch (e) { /* ignore */ }
  return { ...r, body };
}

function short(s, n = 120) {
  const v = String(s || '');
  return v.length > n ? v.slice(0, n) + '…' : v;
}

function firstLine(text) {
  return String(text || '').split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
}

function qualityHeight(stream) {
  const n = String(stream?.name || '');
  let m = n.match(/(\d{3,4})[pP]\b/);
  if (m) return parseInt(m[1], 10);
  m = n.match(/(\d{3,4})x(\d{3,4})/i);
  if (m) return parseInt(m[2], 10);
  return 0;
}

async function main() {
  console.log(`央视片库 addon 健康检查：${base}`);
  const full = allCfg(false);

  group('1. 配置页与 manifest');
  try {
    const cfgPage = await request('/configure');
    check('configure 页面 200', cfgPage.status === 200 && cfgPage.text.includes('央视片库'), `${cfgPage.status} / ${cfgPage.bytes} bytes`);
    // Stremio 点击配置图标时，会把安装 URL 里的 manifest.json 替换成 configure，
    // 即请求 /<encoded-config>/configure。只注册 /configure 会落到 SDK router 返回 404。
    const cfgPrefixed = await request(`${cfgPath(full)}/configure`);
    check('带配置前缀的 configure 200（Stremio 配置图标）',
      cfgPrefixed.status === 200 && cfgPrefixed.text.includes('央视片库'),
      `${cfgPrefixed.status} / ${cfgPrefixed.bytes} bytes`);
  } catch (e) {
    check('configure 页面 200', false, e.message);
  }

  let manifestRes;
  try {
    manifestRes = await getJson('/manifest.json');
    check('manifest 200 + CORS', manifestRes.status === 200 && manifestRes.headers.get('access-control-allow-origin') === '*', `HTTP ${manifestRes.status}`);
    check('manifest 版本号有效', /^\d+\.\d+\.\d+$/.test(String(manifestRes.body?.version || '')), String(manifestRes.body?.version));
    check('manifest 默认 8 个 catalog', manifestRes.body?.catalogs?.length === 8, `${manifestRes.body?.catalogs?.length ?? 0} catalogs`);
    check('manifest 声明 configurable', manifestRes.body?.behaviorHints?.configurable === true, JSON.stringify(manifestRes.body?.behaviorHints || {}));
  } catch (e) {
    check('manifest 可访问', false, e.message);
    throw e;
  }

  group('2. 用户配置过滤');
  const onlyDoc = selectedCfg(['cctv_doc'], ['stable_270'], false);
  try {
    const m = await getJson(`${cfgPath(onlyDoc)}/manifest.json`);
    const ids = (m.body?.catalogs || []).map(c => c.id);
    check('配置后 manifest 仅含启用 catalog', ids.length === 1 && ids[0] === 'cctv_doc', ids.join(','));

    const disabled = await getJson(`${cfgPath(onlyDoc)}/catalog/series/cctv_tv.json`);
    check('关闭的 catalog 返回空', disabled.body?.metas?.length === 0, `${disabled.body?.metas?.length ?? 0} metas`);

    const enabled = await getJson(`${cfgPath(onlyDoc)}/catalog/series/cctv_doc.json`);
    check('启用的 catalog 有数据', (enabled.body?.metas?.length || 0) > 0, `${enabled.body?.metas?.length ?? 0} metas`);
  } catch (e) {
    check('配置过滤链路', false, e.message);
  }

  group('3. catalog / 分页 / 搜索');
  let docMetas = [];
  try {
    const cat = await getJson(`${cfgPath(full)}/catalog/series/cctv_doc.json`);
    docMetas = cat.body?.metas || [];
    check('纪录片 catalog 结构', cat.status === 200 && Array.isArray(docMetas) && docMetas.length > 0 && docMetas.length <= 100, `${docMetas.length} metas`);
    const ids = docMetas.map(m => m.id);
    check('catalog ID 无重复', ids.length === new Set(ids).size, `${ids.length} ids`);
    check('catalog ID 前缀正确', ids.every(id => /^cctv\.(s|4k)\./.test(id)), short(ids[0]));
    check('catalog 条目类型 series', docMetas.every(m => m.type === 'series'), String(docMetas[0]?.type));

    const page2 = await getJson(`${cfgPath(full)}/catalog/series/cctv_doc/skip=100.json`);
    check('skip 分页生效', Array.isArray(page2.body?.metas) && page2.body.metas[0]?.id !== docMetas[0]?.id, `first=${short(page2.body?.metas?.[0]?.id, 50)}`);

    const search = await getJson(`${cfgPath(full)}/catalog/series/cctv_search/search=${encodeURIComponent('海洋')}.json`);
    check('search catalog 路径', (search.body?.metas?.length || 0) > 0, `${search.body?.metas?.length ?? 0} metas`);
  } catch (e) {
    check('catalog 链路', false, e.message);
  }

  group('4. meta 分集');
  let videoId = '';
  try {
    let metaDetail = null;
    for (const m of docMetas.slice(0, 4)) {
      const r = await getJson(`${cfgPath(full)}/meta/series/${encodeURIComponent(m.id)}.json`);
      if ((r.body?.meta?.videos || []).length) { metaDetail = r.body.meta; break; }
    }
    check('meta 有分集', !!metaDetail && metaDetail.videos.length > 0, `${metaDetail?.name || ''} / ${metaDetail?.videos?.length ?? 0} videos`);
    check('meta 简介完整', (metaDetail?.description || '').length >= 20, `${(metaDetail?.description || '').length} chars`);
    check('meta 分集 ID 可播放', /^cctv\.e\./.test(metaDetail?.videos?.[0]?.id || ''), String(metaDetail?.videos?.[0]?.id));
    videoId = metaDetail?.videos?.[0]?.id || '';

    // 回归用例：4K 专辑 meta 曾因 resolveEpisodePage 不返回 html 而崩溃（undefined.match），
    // 26 次 meta 请求返回 null。修复后该 URL 应返回完整分集与简介。
    const k4Url = 'https://tv.cctv.com/2026/06/04/VIDEHt8P0uS4S8BiqYxXCi31260604.shtml';
    const k4Id = 'cctv.4k.' + Buffer.from(k4Url).toString('base64url');
    const k4 = await getJson(`${cfgPath(full)}/meta/series/${encodeURIComponent(k4Id)}.json`);
    const k4Meta = k4.body?.meta;
    check('4K 专辑 meta 不崩溃', !!k4Meta && (k4Meta.videos || []).length > 0 && (k4Meta.description || '').length > 0,
      `${k4Meta?.name || 'null'} / ${k4Meta?.videos?.length ?? 0} videos`);
  } catch (e) {
    check('meta 链路', false, e.message);
  }

  group('5. stream 与画质过滤');
  let streams = [];
  if (!videoId) {
    skip('stream 链路', '前一步未取得可用分集 ID');
  } else {
    try {
      streams = await getStreamsWithRetry(full, videoId);
      check('stream 非空', streams.length > 0, `${streams.length} streams`);
      check('stream URL 完整', streams.every(s => /^https?:\/\//.test(s.url || '')), short(streams[0]?.url));
      const stable = streams.filter(s => /\/asp\/hls\//.test(s.url || ''));
      check('稳定源存在', stable.length > 0, `${stable.length} stable streams`);
      const h5e = streams.filter(s => /\/h5e\/m3u8\//.test(s.url || ''));
      check('网页解密源存在', h5e.length > 0, `${h5e.length} decrypted streams`);
      check('画质名称不虚标', streams.some(s => /480x270|640x360|1080P|720P/.test(s.name || '')), streams.map(s => s.name).join(' | '));
      const heights = streams.map(qualityHeight);
      check('stream 按画质降序', heights.every((h, i) => i === 0 || heights[i - 1] >= h), heights.join(' >= '));

      // 回归用例：老旧分集 URL 的日期路径已过期，源站只返回 JS 跳转桩页。
      // 修复前 stream 为 0；修复后应跟随跳转到真实页面并正常解析出播放源。
      const staleUrl = 'https://tv.cctv.com/2012/12/16/VIDE1355592894134663.shtml';
      const staleId = 'cctv.e.' + Buffer.from(staleUrl).toString('base64url') + '.1';
      const staleRes = await getJson(`${cfgPath(full)}/stream/series/${encodeURIComponent(staleId)}.json`);
      const staleStreams = staleRes.body?.streams || [];
      check('过期日期 URL 自动跟随 JS 跳转', staleStreams.length > 0, `${staleStreams.length} streams / ${staleUrl}`);

      const filtered = await getJson(`${cfgPath(onlyDoc)}/stream/series/${encodeURIComponent(videoId)}.json`);
      const fs2 = filtered.body?.streams || [];
      const qids = fs2.map(s => configLib.streamQualityId(s));
      check('画质配置过滤生效', fs2.length > 0 && qids.every(q => q === 'stable_270'), `qualities=${[...new Set(qids)].join(',') || 'empty'}`);

      // 回归用例：只勾选 1080P 两档，而普通节目最高只有 720P/360P。
      // 修复前过滤后为 0 导致无法播放；修复后应降级到该集最高可用档位。
      const only1080 = selectedCfg(['cctv_doc'], ['stable_1080', 'h5e_1080'], false);
      const fb = await getStreamsWithRetry(only1080, videoId);
      check('勾选画质不存在时降级兜底', fb.length > 0,
        `${fb.length} streams / ${fb.map(s => s.name).slice(0, 3).join(' | ')}`);

      // 三个开关的组合回归：stream 总开关 > 加密 URL 开关 > 解密代理开关
      const idEnc = encodeURIComponent(videoId);
      const combo = {
        encOnProxyOn: switchCfg({ encryptedUrl: true, decryptProxy: true }),
        encOnProxyOff: switchCfg({ encryptedUrl: true, decryptProxy: false }),
        encOffProxyOn: switchCfg({ encryptedUrl: false, decryptProxy: true }),
        streamOff: switchCfg({ streamEnabled: false })
      };
      const c11 = await getStreamsWithRetry(combo.encOnProxyOn, videoId);
      const c10 = await getStreamsWithRetry(combo.encOnProxyOff, videoId);
      const c01 = await getStreamsWithRetry(combo.encOffProxyOn, videoId);
      const c00 = (await getJson(`${cfgPath(combo.streamOff)}/stream/series/${idEnc}.json`)).body?.streams || [];

      check('加密开+代理开 → h5e 为代理 URL', c11.some(isProxyUrl) && !c11.some(isRawH5eUrl),
        `proxy=${c11.filter(isProxyUrl).length} raw=${c11.filter(isRawH5eUrl).length}`);
      check('加密开+代理关 → h5e 为原始 URL', c10.some(isRawH5eUrl) && !c10.some(isProxyUrl),
        `proxy=${c10.filter(isProxyUrl).length} raw=${c10.filter(isRawH5eUrl).length}`);
      check('加密关 → 无 h5e 源（代理开关失效）', !c01.some(isProxyUrl) && !c01.some(isRawH5eUrl) && c01.length > 0,
        `${c01.length} streams / ${c01.map(s => s.name).join(' | ')}`);
      check('stream 总开关关 → 无 stream', c00.length === 0, `${c00.length} streams`);
      check('代理关时原始 URL 带 h5eEncrypted 标记', c10.filter(isRawH5eUrl).every(s => s.behaviorHints?.h5eEncrypted === true),
        JSON.stringify(c10.find(isRawH5eUrl)?.behaviorHints || {}));
    } catch (e) {
      check('stream 链路', false, e.message);
    }
  }

  group('6. H5e 本地解密代理');
  const h5eStream = streams.find(s => /\/h5e\/m3u8\//.test(s.url || ''));
  const h5eUrl = h5eStream?.url;
  if (!h5eUrl) {
    skip('H5e 代理链路', '没有可测的网页解密源');
  } else {
    try {
      const m3u8 = await request(h5eUrl, { timeout: 30000 });
      check('代理 m3u8 200', m3u8.status === 200 && /^#EXTM3U/.test(m3u8.text), `HTTP ${m3u8.status} / ${m3u8.bytes} bytes`);
      const firstTs = firstLine(m3u8.text);
      check('分片 URL 已改写为本地代理', /\/h5e\/ts\//.test(firstTs), short(firstTs, 160));
      if (!firstTs) {
        check('TS 分片可下载', false, 'm3u8 无分片行');
      } else {
        const ts = await request(firstTs, { timeout: 45000 });
        check('TS 分片 200', ts.status === 200 && /video\/mp2t/.test(ts.headers.get('content-type') || ''), `HTTP ${ts.status} / ${ts.bytes} bytes / ${ts.ms}ms`);
        check('TS 已由 wasm 解密', ts.headers.get('x-cctv-decrypt') === 'ok', `X-CCTV-Decrypt=${ts.headers.get('x-cctv-decrypt')}`);
        check('TS 体积合理', ts.bytes > 5000, `${ts.bytes} bytes`);

        const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
        if (probe.status !== 0) {
          skip('ffprobe 真分辨率', '本机未安装 ffprobe（不影响播放，只跳过分辨率复核）');
        } else {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-health-'));
          const file = path.join(dir, 'segment.ts');
          try {
            fs.writeFileSync(file, ts.buffer);
            const r = spawnSync('ffprobe', [
              '-v', 'error', '-select_streams', 'v:0',
              '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file
            ], { encoding: 'utf8' });
            const dims = (r.stdout || '').trim().split('\n')[0];
            const m = dims.match(/(\d+),(\d+)/);
            const w = m ? parseInt(m[1], 10) : 0;
            const h = m ? parseInt(m[2], 10) : 0;
            // 用流名称里的标称真实分辨率做复核：低码率片源本来就是 480x360/480x270，
            // 不能一律要求 720P；若标称 720P/1080P，则必须达到对应高度。
            const nm = String(h5eStream?.name || '');
            const wh = nm.match(/(\d{3,4})x(\d{3,4})/);
            const ph = nm.match(/(\d{3,4})[pP]/);
            let expected = '';
            let ok = false;
            if (wh) {
              const ew = parseInt(wh[1], 10);
              const eh = parseInt(wh[2], 10);
              expected = `${ew}x${eh}`;
              ok = Math.abs(w - ew) <= 16 && Math.abs(h - eh) <= 16;
            } else if (ph) {
              const eh = parseInt(ph[1], 10);
              expected = `${eh}P`;
              ok = h >= eh - 16;
            } else {
              ok = w >= 1280 && h >= 720;
            }
            check('ffprobe 真分辨率与标签一致', ok, `实测 ${w}x${h} / 标称 ${expected || '未标注'} / ${dims || r.stderr?.trim()}`);
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    } catch (e) {
      check('H5e 代理链路', false, e.message);
    }
  }

  group('7. 央视源站接口');
  const stable = streams.find(s => /\/asp\/hls\//.test(s.url || ''));
  const guid = stable ? (stable.url.match(/\/([0-9a-f]{32})\//) || [])[1] : '';
  if (!guid) {
    skip('央视播放 API', '未从稳定源 URL 提取到 guid');
  } else {
    try {
      const api = await getJson(`https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=${guid}`, { timeout: 20000 });
      check('播放 API 200', api.status === 200 && !!(api.body?.video || api.body?.manifest), `HTTP ${api.status} / guid=${guid}`);
    } catch (e) {
      check('播放 API 200', false, e.message);
    }
  }

  try {
    const q = new URLSearchParams({ serviceId: 'cctv4k', cid: 'CHAL1558416868484111', p: '1', n: '100', t: 'json' });
    const api4k = await getJson(`https://api.cntv.cn/NewVideo/getLastVideoList4K?${q}`, { timeout: 20000 });
    const list = api4k.body?.data?.list;
    check('4K 列表 API', api4k.status === 200 && Array.isArray(list) && list.length > 0, `${list?.length ?? 0} items`);
  } catch (e) {
    check('4K 列表 API', false, e.message);
  }

  try {
    const q = new URLSearchParams({
      channelid: 'CHAL1460955853485115', area: '', sc: '', fc: '电视剧',
      year: '', letter: '', p: '1', n: '24', serviceId: 'tvcctv', topv: '1', t: 'json'
    });
    const apiyxg = await getJson(`https://api.cntv.cn/list/getVideoAlbumList?${q}`, { timeout: 20000 });
    const list = apiyxg.body?.data?.list;
    check('yxg 列表 API', apiyxg.status === 200 && Array.isArray(list) && list.length > 0, `${list?.length ?? 0} items`);
  } catch (e) {
    check('yxg 列表 API', false, e.message);
  }

  group('8. 日志系统与实时日志页');
  try {
    const off = await getJson('/api/logs');
    check('默认日志关闭', off.body?.debug === false && off.body?.globalEnabled === false, `debug=${off.body?.debug} global=${off.body?.globalEnabled}`);
    const offHtml = await request('/api/logs?format=html');
    check('未开启时日志页给出提示', offHtml.status === 200 && offHtml.text.includes('日志系统当前已关闭'), `${offHtml.status}`);

    const dbg = allCfg(true);
    await request(`${cfgPath(dbg)}/api/logs?clear=1`);
    await request(`${cfgPath(dbg)}/manifest.json`);
    await request(`${cfgPath(dbg)}/catalog/series/cctv_doc.json`);
    // 取列表靠后的冷门专辑详情，绕过前面已缓存的条目，触发真实源站抓取，
    // 确保日志里出现完整的 UPSTREAM 接口 URL。
    const coldMeta = docMetas.length > 30 ? docMetas[docMetas.length - 5] : docMetas[0];
    if (coldMeta) {
      await request(`${cfgPath(dbg)}/meta/series/${encodeURIComponent(coldMeta.id)}.json`);
    }
    const logs = await getJson(`${cfgPath(dbg)}/api/logs?limit=500`);
    const entries = logs.body?.logs || [];
    check('debug 配置开启日志', logs.body?.debug === true && entries.length > 0, `${entries.length} entries / buffered=${logs.body?.buffered}`);
    check('日志有事项分区', entries.some(e => e.tag === 'section'), entries.filter(e => e.tag === 'section').slice(0, 2).map(e => e.msg).join(' | '));
    check('日志含上游完整 URL', entries.some(e => /upstreamUrl/.test(JSON.stringify(e.ctx || {}))), 'UPSTREAM 条目');
    const onHtml = await request(`${cfgPath(dbg)}/api/logs?format=html`);
    check('实时日志页 HTML', onHtml.status === 200 && onHtml.text.includes('实时日志'), `${onHtml.status}`);
  } catch (e) {
    check('日志链路', false, e.message);
  }

  const failed = results.filter(r => r.status === 'FAIL');
  const passed = results.filter(r => r.status === 'PASS');
  const skipped = results.filter(r => r.status === 'SKIP');
  console.log(`\n结果：${passed.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP`);
  if (wantJson) {
    console.log(JSON.stringify({ base, time: new Date().toISOString(), results }, null, 2));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  check('健康检查异常', false, `${e.message}\n${e.stack || ''}`);
  console.log(`\n结果：${results.filter(r => r.status === 'FAIL').length} FAIL`);
  process.exit(1);
});
