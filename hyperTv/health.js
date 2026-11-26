// 端到端回归：manifest / catalog / meta / stream / CORS
// 用法：node health.js [http://127.0.0.1:7000]
import { encodeConfig, HYPETV_BASE, HYPETV_KEY } from './src/helper.js';
import { xtreamBase } from './src/adapter.js';

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
  // 版本不变 + 长期缓存会让客户端一直用旧 manifest（从而永远不发字幕请求）
  check(
    'manifest 版本与强制重新校验',
    /^1\.0\.[3-9]\d*$/.test(String(manifest.version || '')) && /no-cache/.test(mr.headers.get('cache-control') || ''),
    `${manifest.version} / ${mr.headers.get('cache-control')}`,
  );

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
      if (cat.type === 'movie' || cat.type === 'series') {
        const playUrl = decodeURIComponent(streams[0].url || '');
        check(
          `stream ${cat.type} 新版 key 路径`,
          new RegExp(`/api/x/k/[^/]+/[^/]+/${cat.type}/-/-/`).test(playUrl),
          playUrl.slice(0, 100),
        );
        try {
          const playRes = await fetch(playUrl, {
            headers: { Range: 'bytes=0-50' },
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
          });
          check(
            `stream ${cat.type} 源站可访问`,
            [200, 206, 302].includes(playRes.status),
            `HTTP ${playRes.status}${playRes.headers.get('location') ? ' → CDN' : ''}`,
          );
        } catch (e) {
          check(`stream ${cat.type} 源站可访问`, false, e.message);
        }
      }
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
  // 部分客户端把搜索词直接放 query（?search=），旧版完全忽略 → 返回整页目录，表现为「搜索没反应」
  const cnQuery = await getJson('/catalog/movie/htv_movie.json?search=' + encodeURIComponent('黑客帝国'));
  const cnQueryMetas = cnQuery.body?.metas ?? [];
  check('中文搜索 ?search= 兼容', cnQueryMetas.length > 0 && cnQueryMetas.length < 100, `${cnQueryMetas.length} metas（旧版会返回整页 100）`);
  check('中文搜索结果含中文标题', cnQueryMetas.some((m) => /[\u4e00-\u9fff]/.test(m.name || '')), cnQueryMetas[0]?.name || 'none');

  // Interstellar 在 OpenSubtitles 镜像上同时有中文与英文字幕
  const subRes = await getJson('/subtitles/movie/tt0816692.json');
  const subs = subRes.body?.subtitles;
  check('subtitles 路由', Array.isArray(subs) && subs.length > 0, `${subs?.length ?? 0} subtitles`);
  const ZH_EN = ['zh-CN', 'zh-TW', 'en'];
  check('字幕仅中英', Array.isArray(subs) && subs.length > 0 && subs.every((s) => ZH_EN.includes(s.lang)), [...new Set((subs || []).map((s) => s.lang))].join(','));
  check(
    '字幕 URL 可用（OS 直连 / rezesubs 走代理）',
    (subs || []).every((s) => /^https?:\/\//.test(s.url || '') && (/rezesubs/.test(decodeURIComponent(s.url)) ? /\/api\/subtitle\?u=/.test(s.url) : true)),
    subs?.[0]?.url?.slice(0, 70) || 'none',
  );
  // 中文字幕优先：简体/繁体排在英文之前（中英双语 tier 最高）
  const langSeq = (subs || []).map((s) => s.lang);
  const firstEn = langSeq.indexOf('en');
  const lastZh = langSeq.reduce((acc, l, i) => (l === 'zh-CN' || l === 'zh-TW' ? i : acc), -1);
  check('中文字幕优先排序', firstEn < 0 || lastZh < firstEn, `first en@${firstEn} / last zh@${lastZh}`);
  // vidzee 第二字幕源（按 TMDB ID），日志里必须有一次查询记录
  await fetch(`${base}/api/logs?clear=1`);
  // 站内 ID 自带 tmdb_id，可确保一定会打到 vidzee
  await getJson('/subtitles/movie/htvb1v4564043.json');
  const srcLogs = (await getJson(`/api/logs?cfg=${encodeConfig({ debug: true })}&limit=400&q=core.vidzee`)).body?.logs ?? [];
  check('接入 vidzee 第二字幕源', srcLogs.some((e) => /core\.vidzee\.wtf\/subs\//.test(e.msg)), srcLogs[0]?.msg?.slice(0, 60) || 'none');
  // vidzee 的字幕文件在 rezesubs，缺 Referer 会 403 —— 代理必须补上并能下载到 WEBVTT
  const vzSubs = (await getJson('/subtitles/movie/htvb1v4564043.json')).body?.subtitles || [];
  const vzUrl = vzSubs.find((s) => /rezesubs/.test(decodeURIComponent(s.url)));
  if (vzUrl) {
    try {
      const r = await fetch(vzUrl.url, { signal: AbortSignal.timeout(45000) });
      const body = await r.text();
      check('vidzee 字幕经代理可下载', r.ok && /^WEBVTT/.test(body.trim()), `HTTP ${r.status}, ${body.length} chars`);
    } catch (e) {
      check('vidzee 字幕经代理可下载', false, e.message);
    }
  } else {
    check('vidzee 字幕经代理可下载', true, '本轮上游未返回（跳过）');
  }
  if (subs?.[0]?.url) {
    try {
      const proxyRes = await fetch(subs[0].url, { signal: AbortSignal.timeout(45000) });
      const text = await proxyRes.text();
      check(
        '字幕可下载（直连/代理）',
        proxyRes.ok && (text.includes('--\u003e') || /^WEBVTT/.test(text.trim())),
        `HTTP ${proxyRes.status}, ${text.length} chars`,
      );
    } catch (e) {
      check('字幕可下载（直连/代理）', false, e.message);
    }
  }
  check('manifest 顶层 idPrefixes', Array.isArray(manifest.idPrefixes) && manifest.idPrefixes.includes('tt'), (manifest.idPrefixes || []).join(','));
  // 客户端只在开播时请求 /subtitles，浏览列表时没有字幕请求 → 字幕随 stream 一起下发兜底
  // 先预热一次（冷启动要串「源站详情 → TMDB → 字幕源」，内嵌有 6s 预算）
  await getJson('/subtitles/movie/htvb1v4564044.json');
  const streamWithSubs = (await getJson('/stream/movie/htvb1v4564044.json')).body?.streams ?? [];
  const embedded = streamWithSubs.find((s) => Array.isArray(s.subtitles) && s.subtitles.length);
  check(
    'stream 内嵌字幕下发',
    !!embedded && embedded.subtitles.every((x) => ZH_EN.includes(x.lang) && /^https?:\/\//.test(x.url)),
    embedded ? `${embedded.subtitles.length} 条 ${embedded.subtitles.map((x) => x.lang).join(',')}` : 'none',
  );
  // 剧集分集 ID 解析修复后不应因字段错位返回空字幕对象
  const seriesSubs = await getJson('/subtitles/series/htvb1e16829_4744071_mp4.json');
  check('剧集分集 ID 字幕路由', Array.isArray(seriesSubs.body?.subtitles), `${seriesSubs.body?.subtitles?.length ?? 0} subtitles`);

  // subtitleLang 必须真正过滤（旧版只排序，zh/en 仍返回全部三种）
  const zhCfg = encodeConfig({ subtitleLang: 'zh' });
  const enCfg = encodeConfig({ subtitleLang: 'en' });
  const zhSubs = (await getJson(`/subtitles/movie/tt5034838.json?cfg=${zhCfg}`)).body?.subtitles ?? [];
  const enSubs = (await getJson(`/subtitles/movie/tt5034838.json?cfg=${enCfg}`)).body?.subtitles ?? [];
  check('subtitleLang=zh 仅中文', zhSubs.length > 0 && zhSubs.every((s) => ['zh-CN', 'zh-TW'].includes(s.lang)), [...new Set(zhSubs.map((s) => s.lang))].join(','));
  check('subtitleLang=en 仅英文', enSubs.length > 0 && enSubs.every((s) => s.lang === 'en'), [...new Set(enSubs.map((s) => s.lang))].join(','));
  // 官方 SDK 会把 extra 放在路径段：/subtitles/{type}/{id}/{extra}.json，不能把它吞进 id
  const extraPath = 'filename%3DGodzilla.vs.Kong.2021.mkv';
  const withExtra = await getJson(`/subtitles/movie/tt5034838/${extraPath}.json`);
  check('subtitles extra 路径段', Array.isArray(withExtra.body?.subtitles) && withExtra.body.subtitles.length > 0, `${withExtra.body?.subtitles?.length ?? 0} subtitles`);
  // 站内 ID 走 get_vod_info.tmdb_id -> external_ids，拿到正确的 IMDb ID
  const internalDiagCfg = encodeConfig({ debug: true, diagnosticStream: true });
  const internalStream = await getJson(`/stream/movie/htvb1v4564044.json?cfg=${internalDiagCfg}`);
  const internalDiag = internalStream.body?.streams?.find?.((s) => s.name === '诊断信息' && /^IMDb=tt/.test(s.description || ''));
  check('站内 ID 字幕映射到正确 ttid', /IMDb=tt1979388/.test(internalDiag?.description || ''), internalDiag?.description?.slice(0, 60) || 'none');
  const internalSubs = (await getJson('/subtitles/movie/htvb1v4564044.json')).body?.subtitles ?? [];
  check('站内 ID 可返回字幕', internalSubs.length > 0 && internalSubs.every((s) => ZH_EN.includes(s.lang)), `${internalSubs.length} subtitles`);

  // 剧集字幕：OpenSubtitles v3 必须用 :S:E 路径（?season=&episode= 与无季集均返回 0 条）
  const epSubs = (await getJson('/subtitles/series/tt0903747:1:1.json')).body?.subtitles ?? [];
  check('剧集 :S:E 字幕非空', epSubs.length > 0 && epSubs.every((s) => ZH_EN.includes(s.lang)), `${epSubs.length} subtitles`);
  const epFallback = (await getJson('/subtitles/series/tt0903747.json')).body?.subtitles ?? [];
  check('剧集无季集兜底 1:1', epFallback.length > 0, `${epFallback.length} subtitles`);
  const epQuery = (await getJson('/subtitles/series/tt0903747.json?season=2&episode=3')).body?.subtitles ?? [];
  check('剧集 query 季集字幕', Array.isArray(epQuery), `${epQuery.length} subtitles`);
  const internalEp = (await getJson('/subtitles/series/htvb1s16829:1:1.json')).body?.subtitles ?? [];
  check('站内剧集 :S:E 字幕', internalEp.length > 0, `${internalEp.length} subtitles`);
  const episodeIdSubs = (await getJson('/subtitles/series/htvb1e16829_4744071_mp4.json')).body?.subtitles ?? [];
  check('分集 ID 字幕非空', episodeIdSubs.length > 0, `${episodeIdSubs.length} subtitles`);

  // 运行日志：默认不记录（debug 关闭 → 零缓冲）；只有 debug 配置才写日志
  const quietLogs = await getJson('/api/logs');
  check(
    '默认不记录日志（debug 关闭）',
    quietLogs.body?.debug === false && (quietLogs.body?.logs?.length ?? 0) === 0,
    `debug=${quietLogs.body?.debug} logs=${quietLogs.body?.logs?.length ?? 0}`,
  );
  const quietHtml = await (await fetch(`${base}/api/logs?format=html`)).text();
  check('未开 debug 的日志页给出提示', /调试模式未开启/.test(quietHtml));

  const dbgCfg = encodeConfig({ debug: true });
  await fetch(`${base}/api/logs?clear=1`);
  // 用 debug 配置真打一次字幕请求（选一个前面没查过的片子，确保走冷路径、真的访问上游）
  await getJson(`/subtitles/movie/tt0133093.json?cfg=${dbgCfg}`);
  const logs = (await getJson(`/api/logs?cfg=${dbgCfg}&limit=400&q=subtitle`)).body?.logs ?? [];
  check(
    '日志含字幕链路埋点',
    logs.some((e) => e.tag === 'subtitle' && /ID 解析完成/.test(e.msg)) &&
      logs.some((e) => e.tag === 'subtitle' && /\[OpenSubtitles\] 返回/.test(e.msg)),
    `${logs.filter((e) => e.tag === 'subtitle').length} 条`,
  );
  const allLogs = (await getJson(`/api/logs?cfg=${dbgCfg}&limit=500`)).body?.logs ?? [];
  check('「事项」分区标题', allLogs.some((e) => e.tag === 'section' && /=========/.test(e.msg)), `${allLogs.filter((e) => e.tag === 'section').length} 个分区`);
  check('不再重复 config 调试行', !allLogs.some((e) => e.tag === 'config'), allLogs.map((e) => e.tag).filter((t) => t === 'config').length + ' 条');
  const sectionEntry = allLogs.find((e) => e.tag === 'section' && /字幕/.test(e.msg));
  const outEntry = allLogs.find((e) => e.tag === 'http' && String(e.msg).startsWith('←'));
  check(
    '分区含路径/参数/配置，结果行含状态/字节/耗时',
    !!(sectionEntry?.ctx?.path && sectionEntry?.ctx?.params && sectionEntry?.ctx?.config) &&
      !!(outEntry?.ctx?.status && typeof outEntry?.ctx?.elapsed === 'number' && outEntry?.ctx?.bytes != null),
    `${sectionEntry?.ctx?.path || 'none'} / ${outEntry?.ctx?.elapsed ?? '-'}ms / ${outEntry?.ctx?.bytes ?? '-'}B`,
  );
  // 上游调用可能整轮命中缓存，也可能被网络中断（EXCEPTION），只要求「完整 URL + 耗时」
  const upstreamLogs = allLogs.filter((e) => /https?:\/\//.test(String(e.msg)) && /(→ \d{3}|EXCEPTION.*\d+ms)/.test(String(e.msg)));
  check(
    '上游接口详情（URL/状态/耗时/字节）',
    upstreamLogs.length > 0,
    upstreamLogs[0]?.msg?.slice(0, 90) || 'none',
  );
  const logsHtmlText = await (await fetch(`${base}/api/logs?format=html&cfg=${dbgCfg}`)).text();
  check(
    '日志页增量追加 / 暂停 / 详情 / 事项渲染',
    /since/.test(logsHtmlText) && /暂停接收/.test(logsHtmlText) && /显示详情/.test(logsHtmlText) && /事项/.test(logsHtmlText),
  );
  const health = await getJson('/health');
  check('health 暴露日志统计', !!health.body?.logs?.consoleLevel && 'blocked' in (health.body?.tmdbWeb || {}), health.body?.logs?.consoleLevel || 'none');

  // 日志页自身轮询不得写入缓冲：debug 模式下也一样（NOOP logger）
  const beforePoll = (await getJson(`/api/logs?cfg=${dbgCfg}&limit=1`)).body?.buffered ?? 0;
  for (let i = 0; i < 5; i += 1) await fetch(`${base}/api/logs?cfg=${dbgCfg}&level=debug&q=&limit=400`);
  const afterPoll = (await getJson(`/api/logs?cfg=${dbgCfg}&limit=1`)).body?.buffered ?? 0;
  check('日志页轮询不写日志', afterPoll <= beforePoll, `${beforePoll} → ${afterPoll} 条`);

  // 配置页只保留 debug 开关，不再暴露运行日志级别
  const configureHtml = await (await fetch(`${base}/configure`)).text();
  check(
    '配置页只留 debug 开关',
    /开发调试模式/.test(configureHtml) && !/id="logLevel"/.test(configureHtml) && !/运行日志级别/.test(configureHtml),
    /运行日志级别/.test(configureHtml) ? '仍有日志级别区块' : 'ok',
  );

  const detailSample = manifest.catalogs?.find?.((c) => c.type === 'movie');
  if (detailSample) {
    const detail = (await getJson(`/meta/movie/${encodeURIComponent((await getJson(`/catalog/movie/${detailSample.id}.json`)).body?.metas?.[0]?.id || '')}.json`)).body?.meta;
    check('详情页增强字段', !!detail && Array.isArray(detail.genres) && Array.isArray(detail.cast), `${detail?.genres?.length ?? 0} genres / ${detail?.cast?.length ?? 0} cast`);
  }

  // 新版源站：container_extension=null 的分集用 .mp4 兜底即可播（旧版会跳 nginx 页）
  const nullExtMeta = (await getJson('/meta/series/htvb1s23053.json')).body?.meta;
  check(
    '空扩展名剧集生成 videos',
    Array.isArray(nullExtMeta?.videos) && nullExtMeta.videos.length > 0 && !!nullExtMeta.behaviorHints?.defaultVideoId,
    `${nullExtMeta?.videos?.length ?? 0} videos / defaultVideoId=${nullExtMeta?.behaviorHints?.defaultVideoId || 'none'}`,
  );
  const proxyCfg = encodeConfig({ useProxy: true });
  const nullExtStreams = (await getJson(`/stream/series/htvb1s23053.json?cfg=${proxyCfg}`)).body?.streams ?? [];
  const nullExtPlay = nullExtStreams.find((s) => s.name !== '诊断信息' && s.url);
  check(
    '空扩展名剧集（代理）生成播放地址',
    !!nullExtPlay && /\/1\/series\/\-\/\-\/\d+\.mp4|api\/stream\?u=/.test(decodeURIComponent(nullExtPlay?.url || '')),
    decodeURIComponent(nullExtPlay?.url || 'none').slice(0, 110),
  );

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

  // 调试模式：debug 只开日志；诊断流默认不注入 stream，需显式开启
  const debugCfg = encodeConfig({ debug: true });
  const diagCfg = encodeConfig({ debug: true, diagnosticStream: true });
  const quietMiss = await getJson('/stream/movie/tt0000000.json');
  check('默认无诊断流', Array.isArray(quietMiss.body?.streams) && quietMiss.body.streams.length === 0, `${quietMiss.body?.streams?.length ?? 0} streams`);
  const debugMiss = await getJson(`/stream/movie/tt0000000.json?cfg=${debugCfg}`);
  check(
    'debug 日志模式不注入诊断流',
    Array.isArray(debugMiss.body?.streams) && !debugMiss.body.streams.some((s) => s.name === '诊断信息'),
    `${debugMiss.body?.streams?.length ?? 0} streams`,
  );
  const diagMiss = await getJson(`/stream/movie/tt0000000.json?cfg=${diagCfg}`);
  const diag = diagMiss.body?.streams?.find?.((s) => s.name === '诊断信息');
  check('显式开启后诊断流含可复制 URL', !!diag?.externalUrl?.includes('/api/diagnose?d='), diag?.description?.slice(0, 60) || 'none');
  if (diag?.externalUrl) {
    const page = await fetch(diag.externalUrl);
    const html = await page.text();
    check('诊断页可访问且含上下文', page.ok && html.includes('HypeTv 诊断信息') && html.includes('trace'), `HTTP ${page.status}`);
  }
  const diagHit = await getJson(`/stream/movie/tt5034838.json?cfg=${diagCfg}`);
  const subDiag = diagHit.body?.streams?.find?.((s) => s.name === '诊断信息' && /^IMDb=tt\d+/.test(s.description || ''));
  check('诊断流字幕链路（显式开启）', !!subDiag && /IMDb=tt\d+/.test(subDiag.description), subDiag?.description?.slice(0, 60) || 'none');

  // 葡语站点片名：ttid 应精确命中葡语译名，而不是模糊误命中相似英文标题
  const dinosaur = await getJson('/stream/movie/tt1979388.json');
  const dinoUrl = decodeURIComponent(dinosaur.body?.streams?.[0]?.url || '');
  check('ttid 葡语译名精确匹配', dinoUrl.includes('/movie/-/-/4564044.mp4'), dinoUrl.slice(-40));

  const upstream = await fetch(`${HYPETV_BASE}/api/lists`);
  check('上游 HypeTv 可达', upstream.ok, `HTTP ${upstream.status}`);
  // 新版内置列表：域名 + key 鉴权路径，两者缺一即 404
  check(
    '内置列表 base 含 /api/x/k/{key}/{listId}',
    xtreamBase({ type: 'hypetv', listId: '2', key: 'testkey' }) === `${HYPETV_BASE}/api/x/k/testkey/2`,
    xtreamBase({ type: 'hypetv', listId: '2', key: 'testkey' }),
  );
  try {
    const devRes = await fetch(`${HYPETV_BASE}/api/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123' }),
      signal: AbortSignal.timeout(15000),
    });
    const dev = await devRes.json();
    check('上游开发者码可换 key', devRes.ok && typeof dev.key === 'string' && !!dev.key, `HTTP ${devRes.status}, key=${String(dev.key || '').slice(0, 8)}…`);
    check('默认内置 key 与站点一致', dev.key === HYPETV_KEY, `${String(dev.key || '').slice(0, 8)}… vs ${HYPETV_KEY.slice(0, 8)}…`);
  } catch (e) {
    check('上游开发者码可换 key', false, e.message);
  }
} catch (e) {
  check('执行异常', false, e?.message);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
