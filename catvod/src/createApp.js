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
import { log } from "./logger.js";

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
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "*");
    req.userConfig = parseCfg(req);
    next();
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