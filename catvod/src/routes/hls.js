import { cleanHls } from "../hls/cleaner.js";
import { log } from "../logger.js";

/** 从请求里推断 addon 的公开 base URL */
function addonBase(req) {
  if (process.env.ADDON_BASE_URL) return process.env.ADDON_BASE_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

/** 从已加载的 sources 配置里按 sourceId 找 cfg（供 UA/Referer/超时使用） */
function pickSourceCfg(sources, sourceId) {
  return sources.find((s) => s.id === sourceId) || {};
}

export function registerHlsRoutes(app, { getSourcesConfig }) {
  // 生产播放入口
  app.get("/hls/clean", async (req, res) => {
    const { url, src } = req.query;
    if (!url) return res.status(400).send("#EXTM3U\n# error: url required");
    const sourceCfg = pickSourceCfg(getSourcesConfig(), src);

    try {
      const r = await cleanHls(String(url), src ? String(src) : null, {
        addonBaseUrl: addonBase(req),
        sourceCfg,
      });
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-cache");
      res.set("Access-Control-Allow-Origin", "*");
      if (r.degraded) res.set("X-HLS-Degraded", "1");
      res.send(r.cleaned || "#EXTM3U\n");
    } catch (e) {
      log.error(`[hls] /hls/clean uncaught: ${e.message}`);
      // 极端情况：307 回原 URL，让播放器直连
      res.redirect(307, String(url));
    }
  });

  // 调试入口
  app.get("/debug/hls-clean", async (req, res) => {
    const { url, src } = req.query;
    if (!url) return res.status(400).json({ error: "url required" });
    const sourceCfg = pickSourceCfg(getSourcesConfig(), src);

    const r = await cleanHls(String(url), src ? String(src) : null, {
      addonBaseUrl: addonBase(req),
      sourceCfg,
    });

    res.json({
      url,
      src: src || null,
      type: r.type,
      risk: r.risk,
      degraded: !!r.degraded,
      reason: r.reason || null,
      hits: r.hits,
      originalLength: r.original.length,
      cleanedLength: r.cleaned.length,
      originalSegments: (r.original.match(/^#EXTINF/gm) || []).length,
      cleanedSegments: (r.cleaned.match(/^#EXTINF/gm) || []).length,
      originalHead: r.original.slice(0, 800),
      cleanedHead: r.cleaned.slice(0, 800),
    });
  });
}