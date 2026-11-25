// 端到端回归：manifest / catalog / meta / stream / CORS
// 用法：node health.js [http://127.0.0.1:7000]
import { encodeConfig, HYPETV_BASE } from './src/helper.js';

const base = (process.argv[2] || process.env.ADDON_URL || 'http://127.0.0.1:7000').replace(/\/+$/, '');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(p) {
  const r = await fetch(base + p);
  const body = await r.json();
  return { r, body };
}

try {
  const { r: mr, body: manifest } = await getJson('/manifest.json');
  check('manifest 200 + CORS', mr.status === 200 && mr.headers.get('access-control-allow-origin') === '*');
  check('manifest resources/catalogs', Array.isArray(manifest.resources) && Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0, `${manifest.catalogs?.length} catalogs`);

  for (const cat of manifest.catalogs ?? []) {
    const { r, body } = await getJson(`/catalog/${cat.type}/${cat.id}.json`);
    const metas = body?.metas;
    check(`catalog ${cat.type}`, r.status === 200 && Array.isArray(metas) && metas.length <= 100, `${metas?.length ?? 0} metas`);
    if (!metas?.length) continue;

    const first = metas[0];
    check(`meta ${cat.type} 必需字段`, !!(first.id && first.name && first.type), first.name);

    let target = first;
    let targetMeta = (await getJson(`/meta/${cat.type}/${encodeURIComponent(first.id)}.json`)).body?.meta;
    check(`meta detail ${cat.type}`, !!targetMeta?.id, targetMeta?.name || 'null');
    if (cat.type === 'series') {
      // 内置列表前若干剧集的分集容器扩展名为空（源站返回 nginx 页面），
      // 样本取一个实测可播的剧集验证 videos/defaultVideoId 链路。
      const prefix = manifest.resources?.find?.((x) => x.name === 'stream')?.idPrefixes?.[0];
      const candidates = [...metas.slice(0, 3)];
      if (prefix === 'htvb1') candidates.push({ id: 'htvb1s16829', type: 'series', name: 'Guerra Sombra e Água Fresca' });
      for (const c of candidates) {
        if (targetMeta?.videos?.length) break;
        if (c.id === target.id) continue;
        target = c;
        targetMeta = (await getJson(`/meta/${cat.type}/${encodeURIComponent(c.id)}.json`)).body?.meta;
      }
      const videos = targetMeta?.videos;
      check('series videos + defaultVideoId', Array.isArray(videos) && videos.length > 0 && !!targetMeta?.behaviorHints?.defaultVideoId, `${targetMeta?.name || ''} / ${videos?.length ?? 0} videos`);
    }

    const streamRes = await getJson(`/stream/${cat.type}/${encodeURIComponent(target.id)}.json`);
    const streams = streamRes.body?.streams;
    check(`stream ${cat.type} 非空数组`, Array.isArray(streams), `${streams?.length ?? 0} streams`);
    if (cat.type !== 'channel' && streams?.length) {
      check('stream url 非空', !!streams[0].url, streams[0].url?.slice(0, 90));
      const noBrand = streams.every((s) => !/hypetv/i.test(`${s.name || ''} ${s.title || ''} ${s.description || ''}`));
      check('stream name/title 不含品牌名', noBrand, `${streams[0].name} | ${streams[0].title}`);
      check('stream 官方字段', !!streams[0].name && !!streams[0].description && !!streams[0].behaviorHints?.filename);
    }
    if (cat.type === 'channel') {
      check('内置直播诊断流', streams?.some?.((s) => s.name === '诊断信息') || streams?.some?.((s) => !!s.url), '403 限制或真实流');
    }
  }

  const prefixes = manifest.resources?.find?.((x) => x.name === 'stream')?.idPrefixes ?? [];
  check('idPrefixes 含 tt', prefixes.some((p) => /^tt$/i.test(p)), prefixes.join(','));
  check('manifest 含 subtitles 资源', manifest.resources.some((r) => r.name === 'subtitles'));

  const searchRes = await getJson('/search/Matrix.json?type=movie');
  check('search 路由', Array.isArray(searchRes.body?.metas), `${searchRes.body?.metas?.length ?? 0} metas`);
  // Stremio 真实搜索请求：extra 在路径里，不是 ?extra=
  const pathSearch = await getJson('/catalog/movie/htv_movie/search=Matrix.json');
  check('官方 catalog 路径搜索', Array.isArray(pathSearch.body?.metas) && pathSearch.body.metas.length > 0, `${pathSearch.body?.metas?.length ?? 0} metas`);
  const cnSearch = await getJson('/catalog/movie/htv_movie/search=' + encodeURIComponent('黑客帝国') + '.json');
  check('中文搜索', Array.isArray(cnSearch.body?.metas) && cnSearch.body.metas.length > 0, `${cnSearch.body?.metas?.length ?? 0} metas`);

  // Interstellar 在 OpenSubtitles 镜像上同时有中文与英文字幕
  const subRes = await getJson('/subtitles/movie/tt0816692.json');
  const subs = subRes.body?.subtitles;
  check('subtitles 路由', Array.isArray(subs) && subs.length > 0, `${subs?.length ?? 0} subtitles`);
  check('字幕仅中英', Array.isArray(subs) && subs.every((s) => ['zho', 'zht', 'eng'].includes(s.lang)), [...new Set((subs || []).map((s) => s.lang))].join(','));
  check('字幕 URL 走 addon 代理', !!subs?.[0]?.url?.includes('/api/subtitle?u='), subs?.[0]?.url?.slice(0, 80) || 'none');
  if (subs?.[0]?.url) {
    try {
      const proxyRes = await fetch(subs[0].url, { signal: AbortSignal.timeout(15000) });
      const text = await proxyRes.text();
      check('代理字幕可下载', proxyRes.ok && text.includes('--\u003e'), `HTTP ${proxyRes.status}, ${text.length} chars`);
    } catch (e) {
      check('代理字幕可下载', false, e.message);
    }
  }
  check('manifest 顶层 idPrefixes', Array.isArray(manifest.idPrefixes) && manifest.idPrefixes.includes('tt'), (manifest.idPrefixes || []).join(','));
  // 剧集分集 ID 解析修复后不应因字段错位返回空字幕对象
  const seriesSubs = await getJson('/subtitles/series/htvb1e16829_4744071_mp4.json');
  check('剧集分集 ID 字幕路由', Array.isArray(seriesSubs.body?.subtitles), `${seriesSubs.body?.subtitles?.length ?? 0} subtitles`);

  // subtitleLang 必须真正过滤（旧版只排序，zh/en 仍返回全部三种）
  const zhCfg = encodeConfig({ subtitleLang: 'zh' });
  const enCfg = encodeConfig({ subtitleLang: 'en' });
  const zhSubs = (await getJson(`/subtitles/movie/tt5034838.json?cfg=${zhCfg}`)).body?.subtitles ?? [];
  const enSubs = (await getJson(`/subtitles/movie/tt5034838.json?cfg=${enCfg}`)).body?.subtitles ?? [];
  check('subtitleLang=zh 仅中文', zhSubs.length > 0 && zhSubs.every((s) => ['zho', 'zht'].includes(s.lang)), [...new Set(zhSubs.map((s) => s.lang))].join(','));
  check('subtitleLang=en 仅英文', enSubs.length > 0 && enSubs.every((s) => s.lang === 'eng'), [...new Set(enSubs.map((s) => s.lang))].join(','));
  // 官方 SDK 会把 extra 放在路径段：/subtitles/{type}/{id}/{extra}.json，不能把它吞进 id
  const extraPath = 'filename%3DGodzilla.vs.Kong.2021.mkv';
  const withExtra = await getJson(`/subtitles/movie/tt5034838/${extraPath}.json`);
  check('subtitles extra 路径段', Array.isArray(withExtra.body?.subtitles) && withExtra.body.subtitles.length > 0, `${withExtra.body?.subtitles?.length ?? 0} subtitles`);
  // 站内 ID 走 get_vod_info.tmdb_id -> external_ids，拿到正确的 IMDb ID
  const internalDiagCfg = encodeConfig({ debug: true });
  const internalStream = await getJson(`/stream/movie/htvb1v4564044.json?cfg=${internalDiagCfg}`);
  const internalDiag = internalStream.body?.streams?.find?.((s) => s.name === '诊断信息' && /^IMDb=tt/.test(s.description || ''));
  check('站内 ID 字幕映射到正确 ttid', /IMDb=tt1979388/.test(internalDiag?.description || ''), internalDiag?.description?.slice(0, 60) || 'none');
  const internalSubs = (await getJson('/subtitles/movie/htvb1v4564044.json')).body?.subtitles ?? [];
  check('站内 ID 可返回字幕', internalSubs.length > 0 && internalSubs.every((s) => ['zho', 'zht', 'eng'].includes(s.lang)), `${internalSubs.length} subtitles`);

  // 剧集字幕：OpenSubtitles v3 必须用 :S:E 路径（?season=&episode= 与无季集均返回 0 条）
  const epSubs = (await getJson('/subtitles/series/tt0903747:1:1.json')).body?.subtitles ?? [];
  check('剧集 :S:E 字幕非空', epSubs.length > 0 && epSubs.every((s) => ['zho', 'zht', 'eng'].includes(s.lang)), `${epSubs.length} subtitles`);
  const epFallback = (await getJson('/subtitles/series/tt0903747.json')).body?.subtitles ?? [];
  check('剧集无季集兜底 1:1', epFallback.length > 0, `${epFallback.length} subtitles`);
  const internalEp = (await getJson('/subtitles/series/htvb1s16829:1:1.json')).body?.subtitles ?? [];
  check('站内剧集 :S:E 字幕', internalEp.length > 0, `${internalEp.length} subtitles`);
  const episodeIdSubs = (await getJson('/subtitles/series/htvb1e16829_4744071_mp4.json')).body?.subtitles ?? [];
  check('分集 ID 字幕非空', episodeIdSubs.length > 0, `${episodeIdSubs.length} subtitles`);

  // 运行日志：请求级 + 字幕链路埋点 + 可查看页
  const logsRes = await getJson('/api/logs?limit=400&q=subtitle');
  const logs = logsRes.body?.logs ?? [];
  check('运行日志接口', Array.isArray(logs) && logsRes.body?.buffered > 0, `buffered=${logsRes.body?.buffered}`);
  check('日志含字幕链路埋点', logs.some((e) => e.tag === 'subtitle' && /开始 type=/.test(e.msg)) && logs.some((e) => e.tag === 'subtitle' && /上游返回/.test(e.msg)), `${logs.filter((e) => e.tag === 'subtitle').length} 条`);
  check('日志含 http 请求记录', logs.some((e) => e.tag === 'http' && /subtitles=/.test(e.msg)), 'http 埋点');
  const logsHtml = await fetch(`${base}/api/logs?format=html`);
  check('日志查看页可访问', logsHtml.ok && (await logsHtml.text()).includes('HypeTv 运行日志'), `HTTP ${logsHtml.status}`);
  const health = await getJson('/health');
  check('health 暴露日志统计', !!health.body?.logs?.consoleLevel && 'blocked' in (health.body?.tmdbWeb || {}), health.body?.logs?.consoleLevel || 'none');

  const detailSample = manifest.catalogs?.find?.((c) => c.type === 'movie');
  if (detailSample) {
    const detail = (await getJson(`/meta/movie/${encodeURIComponent((await getJson(`/catalog/movie/${detailSample.id}.json`)).body?.metas?.[0]?.id || '')}.json`)).body?.meta;
    check('详情页增强字段', !!detail && Array.isArray(detail.genres) && Array.isArray(detail.cast), `${detail?.genres?.length ?? 0} genres / ${detail?.cast?.length ?? 0} cast`);
  }

  const ttid = process.env.HEALTH_TTID_MOVIE || 'tt0133093'; // The Matrix (1999)
  const ttStream = await getJson(`/stream/movie/${ttid}.json`);
  check('ttid stream 映射', Array.isArray(ttStream.body?.streams) && ttStream.body.streams.some((s) => !!s.url), `${ttStream.body?.streams?.length ?? 0} streams`);
  const ttMeta = await getJson(`/meta/movie/${ttid}.json`);
  check('ttid meta', !!ttMeta.body?.meta?.name, ttMeta.body?.meta?.name || 'null');
  check('ttid meta 中文', /[\u4e00-\u9fff]/.test(ttMeta.body?.meta?.name || ''), ttMeta.body?.meta?.name || 'null');
  check('中文海报', /image\.tmdb\.org/.test(ttMeta.body?.meta?.poster || ''), (ttMeta.body?.meta?.poster || '').slice(0, 80));
  if (ttMeta.body?.meta?.id) {
    check('ttid meta id 回显一致', ttMeta.body.meta.id === ttid, ttMeta.body.meta.id);
  }

  // 调试模式：默认关闭时诊断流为空，开启时诊断信息编码进可复制 URL
  const debugCfg = encodeConfig({ debug: true });
  const quietMiss = await getJson('/stream/movie/tt0000000.json');
  check('默认无诊断流', Array.isArray(quietMiss.body?.streams) && quietMiss.body.streams.length === 0, `${quietMiss.body?.streams?.length ?? 0} streams`);
  const debugMiss = await getJson(`/stream/movie/tt0000000.json?cfg=${debugCfg}`);
  const diag = debugMiss.body?.streams?.find?.((s) => s.name === '诊断信息');
  check('debug 诊断流含可复制 URL', !!diag?.externalUrl?.includes('/api/diagnose?d='), diag?.description?.slice(0, 60) || 'none');
  if (diag?.externalUrl) {
    const page = await fetch(diag.externalUrl);
    const html = await page.text();
    check('诊断页可访问且含上下文', page.ok && html.includes('HypeTv 诊断信息') && html.includes('trace'), `HTTP ${page.status}`);
  }
  const debugHit = await getJson(`/stream/movie/tt5034838.json?cfg=${debugCfg}`);
  const subDiag = debugHit.body?.streams?.find?.((s) => s.name === '诊断信息' && /^IMDb=tt\d+/.test(s.description || ''));
  check('debug 字幕诊断链路', !!subDiag && /IMDb=tt\d+/.test(subDiag.description), subDiag?.description?.slice(0, 60) || 'none');

  // 葡语站点片名：ttid 应精确命中葡语译名，而不是模糊误命中相似英文标题
  const dinosaur = await getJson('/stream/movie/tt1979388.json');
  const dinoUrl = decodeURIComponent(dinosaur.body?.streams?.[0]?.url || '');
  check('ttid 葡语译名精确匹配', dinoUrl.includes('/movie/-/-/4564044.mp4'), dinoUrl.slice(-40));

  const upstream = await fetch(`${HYPETV_BASE}/api/lists`);
  check('上游 HypeTv 可达', upstream.ok, `HTTP ${upstream.status}`);
} catch (e) {
  check('执行异常', false, e?.message);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
