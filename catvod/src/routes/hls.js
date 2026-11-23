// src/routes/hls.js
import { cleanHls } from "../hls/cleaner.js";
import { log } from "../logger.js";

function addonBase(req) {
  if (process.env.ADDON_BASE_URL) return process.env.ADDON_BASE_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function pickSourceCfg(sources, sourceId) {
  return sources.find((s) => s.id === sourceId) || {};
}

export function registerHlsRoutes(app, { getSourcesConfig }) {
  // app.get("/hls/clean", async (req, res) => {
    // ===== 关键改动：将请求路径 /hls/clean 改为 /hls =====
    app.get("/hls", async (req, res) => {
    const { url, src } = req.query;
    if (!url) return res.status(400).send("#EXTM3U\n# error: url required");

    const sourceCfg = pickSourceCfg(getSourcesConfig(), src);

    try {
      const r = await cleanHls(String(url), src ? String(src) : null, {
        addonBaseUrl: addonBase(req),
        sourceCfg,
      });

      // ===== 关键改动：fetch 失败时 307 重定向到原始 URL =====
      if (r.type === "error") {
        log.warn(`[hls] fetch failed, redirect to original URL (未过滤广告): ${url}`);
        res.set("X-HLS-Degraded", "1");
        res.set("X-HLS-Error", String(r.reason || "fetch-failed").slice(0, 200));
        return res.redirect(307, String(url));
      }

      res.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.set("Cache-Control", "no-cache");
      res.set("Access-Control-Allow-Origin", "*");
      if (r.degraded) {
        res.set("X-HLS-Degraded", "1");
        if (r.reason) res.set("X-HLS-Reason", String(r.reason).slice(0, 200));
      }
      res.send(r.cleaned || "#EXTM3U\n");
    } catch (e) {
      log.error(`[hls] /hls uncaught: ${e.message}`);
      // 兜底：未捕获异常也 307，让播放器直连
      res.set("X-HLS-Degraded", "1");
      res.redirect(307, String(url));
    }
  });

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
      // ===== 关键：暴露源站原始请求/响应 =====
      fetchAttempts: r.fetchAttempts || [],
    });
  });
  
}