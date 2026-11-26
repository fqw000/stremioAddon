import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSourcesConfig } from "./config/loadConfig.js";
import { buildRegistry } from "./sources/registry.js";
import { buildManifest } from "./addon/manifest.js";
import { handleCatalog } from "./addon/catalog.js";
import { handleMeta } from "./addon/meta.js";
import { handleStream } from "./addon/stream.js";
import { registerHlsRoutes } from "./routes/hls.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { traceMiddleware } from "./utils/traceId.js";
import {
  log, createLogger, initLogStore, scopeFromCfg, safeCfgTag,
  getLogs, clearLogs, logStats, flushLogWrites, runWithLogStore,
} from "./logger.js";
import { logsHtml } from "./logPage.js";

const registryCache = new Map();
const MAX_REGISTRY_CACHE = 30;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");


function getContext(userConfig) {
  const key = JSON.stringify(userConfig.sources || "all");
  if (registryCache.has(key)) return registryCache.get(key);

  const { sources } = loadSourcesConfig(userConfig);
  const registry = buildRegistry(sources);
  const ctx = { sources, registry };

  if (registryCache.size >= MAX_REGISTRY_CACHE) {
    registryCache.delete(registryCache.keys().next().value);
  }
  registryCache.set(key, ctx);
  return ctx;
}

function sendWithCache(res, data, fallbackSeconds = 180) {
  const maxAge = Number(data?.cacheMaxAge) || fallbackSeconds;
  const swr = Number(data?.staleRevalidate);
  const sie = Number(data?.staleError);
  let cc = `public, max-age=${maxAge}, s-maxage=${maxAge}`;
  if (swr) cc += `, stale-while-revalidate=${swr}`;
  if (sie) cc += `, stale-if-error=${sie}`;
  res.set("Cache-Control", cc);
  res.json(data);
}

function stripExtra(id) {
  return String(id).split("/")[0];
}

function parseCfg(req) {
  const cfgB64 = req.query.cfg;
  if (!cfgB64) return {};
  try {
    const base64 = String(cfgB64).replace(/-/g, "+").replace(/_/g, "/");
    const binary = Buffer.from(base64, "base64").toString("utf-8");
    const cfg = JSON.parse(binary);
    log.debug(`[cfg] parsed: ${JSON.stringify(cfg).slice(0, 200)}`);
    return cfg;
  } catch (e) {
    log.warn(`[cfg] parse failed: ${e.message}`);
    return {};
  }
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(traceMiddleware);

  // 运行日志：按请求隔离 store（Node 长驻进程并发安全），并注册日志路由
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    runWithLogStore(() => {
      const cfgParam = typeof req.query.cfg === "string" ? req.query.cfg : "";
      const scopeParam = typeof req.query.scope === "string" ? req.query.scope : "";
      const pathname = req.path;
      const logRoute = pathname === "/api/logs" || pathname === "/api/logs.html";
      const viewParam = String(req.query.view || "");
      const view = ["all", "debug", "personal"].includes(viewParam)
        ? viewParam
        : (cfgParam || scopeParam ? "personal" : "all");

      req.userConfig = parseCfg(req);
      let cfgDebug = false;
      let cfgUid = "";
      try {
        cfgDebug = req.userConfig.dbg === true || req.userConfig.debug === true;
        cfgUid = String(req.userConfig.uid || "");
      } catch (e) {}
      const scope = scopeParam || scopeFromCfg(cfgParam);
      initLogStore(process.env, {
        prefix: process.env.APP_PREFIX || "catvod",
        scope, debugUser: cfgDebug, cfgTag: safeCfgTag(cfgParam), uid: cfgUid,
      });

      // 日志路由自身不写访问日志，避免每 3 秒轮询刷屏
      if (!logRoute) {
        const label = pathname === "/manifest.json" || pathname === "/" ? "资源声明"
          : pathname.startsWith("/catalog/") ? "目录"
          : pathname.startsWith("/meta/") ? "详情"
          : pathname.startsWith("/stream/") ? "播放源"
          : pathname.startsWith("/debug/") ? "健康检查" : "请求";
        const L = createLogger("Edge", { reqId: String(req.headers["x-trace-id"] || "").slice(0, 6) });
        L.section(`${label} · ${req.method} ${pathname}`, {
          path: pathname, method: req.method, params: req.originalUrl.slice(pathname.length).slice(0, 160),
          config: `scope=${scope} debug=${cfgDebug}`,
        });
        L.info(`${req.method} ${req.originalUrl.slice(0, 160)} scope=${scope} debug=${cfgDebug}`);
      }

      if (logRoute) {
        (async () => {
          try {
            if (req.query.clear === "1") {
              await clearLogs({ view });
              return res.json({ ok: true, cleared: true, view, ...logStats() });
            }
            if (req.query.format === "html") {
              res.set("Content-Type", "text/html; charset=utf-8");
              res.set("Cache-Control", "no-store");
              return res.send(logsHtml(scope, view));
            }
            const level = String(req.query.level || "debug");
            const limit = Number(req.query.limit) || 200;
            const q = String(req.query.q || "");
            const logs = await getLogs({ level, limit, q, view });
            res.set("Cache-Control", "no-store");
            res.json({ ok: true, view, ...logStats(), logs });
          } catch (e) {
            res.status(500).json({ error: e.message });
          } finally {
            await flushLogWrites();
          }
        })();
        return;
      }
      // Node 长驻进程不冻结实例，但仍在响应结束时统一刷写，便于日志落盘
      res.on("finish", () => { flushLogWrites().catch(() => {}); });
      next();
    });
  });

  // ==========================================
  // API 路由 (静态文件交由 Vercel 的 rewrites 处理)
  // ==========================================
  app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.get("/manifest.json", (req, res) => {
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=3600");
    res.json(buildManifest(req.userConfig));
  });

  app.get(/^\/catalog\/(movie|series)\/(.+)\.json$/, async (req, res) => {
    const { registry } = getContext(req.userConfig);
    try {
      const type = req.params[0];
      const idPart = req.params[1];
      const [id, ...extraParts] = idPart.split("/");
      const extra = {};
      for (const p of extraParts) {
        const eq = p.indexOf("=");
        if (eq > 0) extra[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
      }
      const r = await handleCatalog({ type, id, extra }, { registry });
      sendWithCache(res, r, 1800);
    } catch (e) {
      log.error(`[catalog] uncaught: ${e.message}`);
      res.json({ metas: [] });
    }
  });

  app.get("/meta/:type/:id.json", async (req, res) => {
    const { registry } = getContext(req.userConfig);
    try {
      const id = stripExtra(req.params.id);
      const r = await handleMeta({ type: req.params.type, id }, { registry, userConfig: req.userConfig });
      sendWithCache(res, r, 900);
    } catch (e) {
      log.error(`[meta] uncaught: ${e.message}`);
      res.json({ meta: null });
    }
  });

  app.get("/stream/:type/:id.json", async (req, res) => {
    const { registry } = getContext(req.userConfig);
    try {
      const id = stripExtra(req.params.id);
      const r = await handleStream({ type: req.params.type, id }, req, { registry, userConfig: req.userConfig });
      sendWithCache(res, { streams: r.streams || [] }, 180);
    } catch (e) {
      log.error(`[stream] uncaught: ${e.message}`);
      res.json({ streams: [] });
    }
  });

  // ==========================================
  // HLS + Debug
  // ==========================================
  const { sources: allSources, registry: allRegistry } = getContext({});
  registerHlsRoutes(app, { getSourcesConfig: () => allSources });
  registerDebugRoutes(app, { registry: allRegistry });

  app.use(express.static(PUBLIC_DIR, { index: false }));
app.get("/configure", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "configure.html"));
});

  return app;
}