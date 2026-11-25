// Stream：解析 ID -> 构造播放地址 -> 可选走 HypeTv /api/stream 代理
// 展示字段遵循官方 Stream Object：name=画质/格式，title/description=线路说明
import { buildPlayUrl, getCatalogItems, getSeriesInfo, proxyUrl } from '../adapter.js';
import { findItem, isImdbId, parseId } from '../resolver.js';
import { cleanUrl, encodeDebugData, safeExtension } from '../helper.js';
import { resolveImdbToCatalog } from '../tmdb.js';
import { diagnoseSubtitle } from './subtitle.js';

const SOURCE_LABEL = {
  hypetv: '内置片库',
  xtream: 'Xtream 账号',
  m3u: 'M3U 列表',
};

function filenameOf(title, ext, fallback) {
  const base = String(title || fallback || 'video')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return `${base || 'video'}.${ext || 'mp4'}`;
}

function makeStream(url, opts) {
  const { contentTitle, ext, config, headers = {}, alt = false, index = 1 } = opts;
  const target = cleanUrl(url);
  if (!target || !/^https?:\/\//i.test(target)) return null;
  const finalUrl = config.useProxy ? proxyUrl(target, headers) : target;
  if (!finalUrl) return null;
  const format = String(ext || 'auto').toUpperCase();
  const notWebReady = !/^https:\/\//i.test(finalUrl) || !/^MP4$/i.test(format);
  const route = `${alt ? '备用线路' : '主线路'} ${index} · ${config.useProxy ? '代理' : '直连'}`;
  const description = `${SOURCE_LABEL[config.source.type] || '片源'} · ${route}`;
  return {
    url: finalUrl,
    // 官方约定：name 表示流质量/格式，不再放插件名
    name: `${format}${alt ? ' 备用' : ''}`,
    title: description,
    description,
    behaviorHints: {
      bingeGroup: `hypetv-${format.toLowerCase()}`,
      notWebReady,
      filename: filenameOf(contentTitle, ext, 'hypetv'),
    },
  };
}

// 诊断流只在 debug=true 时生成；诊断上下文全部编码进 URL，用户可直接复制反馈
function diagnostic(ctx, title, description, details = {}) {
  const { config, addonBase, type, id } = ctx;
  if (!config.debug) return null;
  const data = {
    v: 1,
    ts: new Date().toISOString(),
    addon: 'HypeTv',
    type,
    id,
    title,
    message: description,
    ...details,
  };
  const url = addonBase ? `${addonBase}/api/diagnose?d=${encodeDebugData(data)}` : '';
  return {
    name: '诊断信息',
    title: '点击查看 / 复制完整诊断链接',
    description: `${description}${url ? ` 诊断链接：${url}` : ''}`,
    ...(url ? { externalUrl: url } : {}),
    behaviorHints: { notWebReady: true },
  };
}

function withDiagnostic(streams, ctx, title, description, details) {
  const d = diagnostic(ctx, title, description, details);
  if (d) streams.push(d);
  return streams;
}

export async function handleStream(ctx) {
  const { type, id, config, prefix } = ctx;
  let parsed = parseId(id);
  let contentTitle = '';
  if (isImdbId(id)) {
    const trace = { imdbId: id, type, source: config.source.type };
    const resolved = await resolveImdbToCatalog(id, type, config, prefix, trace);
    if (!resolved) {
      return {
        streams: withDiagnostic(
          [],
          ctx,
          '未找到匹配的片源',
          '该 IMDb ID 未匹配到站内条目。请开启调试模式查看诊断链接，或检查数据源 / TMDB 配置。',
          { reason: 'no-catalog-match', trace },
        ),
        cacheMaxAge: 120,
      };
    }
    contentTitle = resolved.meta?.title || '';
    parsed = {
      prefix,
      kind: resolved.kind === 'series' ? 's' : 'v',
      key: String(resolved.item.series_id ?? resolved.item.stream_id ?? resolved.item.key),
    };
  } else if (!parsed || parsed.prefix !== prefix) {
    return { streams: [], cacheMaxAge: 120 };
  }

  // 内置列表直播实测 403：仅调试模式返回诊断流，不返回无效播放地址
  if (parsed.kind === 'l' && config.source.type === 'hypetv') {
    return {
      streams: withDiagnostic(
        [],
        ctx,
        '直播源不可用',
        '内置列表直播被站点限制（403：仅部分账号开放）。请在配置页改用自有 Xtream 账号或 M3U 来源。',
        { reason: 'builtin-live-403' },
      ),
      cacheMaxAge: 600,
    };
  }

  let target = parsed;
  if (parsed.kind === 's') {
    // 没有 defaultVideoId 的客户端兜底：取第一个可用分集
    const info = await getSeriesInfo(config.source, parsed.key);
    const episodes = Object.values(info?.episodes ?? {}).flat();
    const ep = episodes.find((e) => safeExtension(e.container_extension) || e.direct_source);
    if (!ep) {
      return {
        streams: withDiagnostic([], ctx, '无可用分集', '源站未返回可播放的分集。', {
          reason: 'no-episode',
          seriesId: parsed.key,
        }),
        cacheMaxAge: 120,
      };
    }
    target = {
      ...parsed,
      kind: 'e',
      seriesId: parsed.key,
      episodeId: String(ep.id),
      ext: safeExtension(ep.container_extension) || 'mp4',
    };
  }

  let built;
  if (target.kind === 'e') {
    const ext = safeExtension(target.ext) || 'mp4';
    built = await buildPlayUrl(
      config.source,
      'series',
      { stream_id: target.episodeId },
      { episodeId: target.episodeId, ext },
    );
    contentTitle = contentTitle || `episode-${target.episodeId}`;
  } else {
    const kind = target.kind === 'l' ? 'live' : 'movie';
    const items = await getCatalogItems(config.source, kind);
    const item = findItem(items, target.key, kind);
    if (!item) {
      return {
        streams: withDiagnostic([], ctx, '条目不存在', '站内片库中找不到该 ID。', {
          reason: 'no-item',
          key: target.key,
        }),
        cacheMaxAge: 120,
      };
    }
    built = await buildPlayUrl(config.source, kind, item);
    contentTitle = contentTitle || item.name || item.title || '';
  }

  const streams = [];
  const main = makeStream(built.url, { contentTitle, ext: built.ext, config, headers: built.headers });
  if (main) streams.push(main);
  let altIndex = 1;
  for (const alt of built.alt ?? []) {
    const s = makeStream(alt, { contentTitle, ext: built.ext, config, alt: true, index: altIndex });
    if (s) streams.push(s);
    altIndex += 1;
  }

  // 调试模式下附带字幕诊断，便于确认「没有字幕」是 ID 映射还是上游结果的问题
  if (config.debug) {
    const subInfo = await diagnoseSubtitle(id, type, config, prefix, {}, ctx.logger);
    withDiagnostic(
      streams,
      ctx,
      '字幕诊断',
      `IMDb=${subInfo.imdbId || '未解析'}，上游 ${subInfo.upstream} 条，保留 ${subInfo.kept} 条（${(subInfo.langs || []).join(', ') || '无'}）`,
      { reason: 'subtitle-diagnostic', subtitle: subInfo },
    );
  }

  return { streams, cacheMaxAge: 180, staleError: 60 };
}
