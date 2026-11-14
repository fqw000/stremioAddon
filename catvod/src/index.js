import express from "express";
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

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// traceId 必须最先挂载，后续所有日志自动带 traceId
app.use(traceMiddleware);

// CORS
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  next();
});

const { sources } = loadSourcesConfig();
const registry = buildRegistry(sources);
log.info(`[boot] enabled sources: ${registry.enabled().map((e) => e.cfg.id).join(",")}`);

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/manifest.json", (_req, res) => res.json(buildManifest()));

// catalog 的 id 可含 "/"（如 "bfzy-series/search=庆余年"），
// Express 4 的 "/:type/:id.json" 无法匹配含 "/" 的 id，改用 RegExp。
app.get(/^\/catalog\/(movie|series)\/(.+)\.json$/, async (req, res) => {
  try {
    const type = req.params[0];
    const idPart = req.params[1];
    const [id, ...extraParts] = idPart.split("/");

    const extra = {};
    for (const p of extraParts) {
      const eq = p.indexOf("=");
      if (eq > 0) {
        extra[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
      }
    }

    const r = await handleCatalog({ type, id, extra }, { registry });
    res.json(r);
  } catch (e) {
    log.error(`[catalog] uncaught: ${e.message}`);
    res.json({ metas: [] });
  }
});

app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const id = stripExtra(req.params.id);
    const r = await handleMeta({ type: req.params.type, id }, { registry });
    res.json(r);
  } catch (e) {
    log.error(`[meta] uncaught: ${e.message}`);
    res.json({ meta: null });
  }
});

app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    const id = stripExtra(req.params.id);
    const r = await handleStream({ type: req.params.type, id }, req, { registry });
    res.json({ streams: r.streams || [] });
  } catch (e) {
    log.error(`[stream] uncaught: ${e.message}`);
    res.json({ streams: [] });
  }
});

registerHlsRoutes(app, { getSourcesConfig: () => sources });
registerDebugRoutes(app, { registry });

// PORT 环境变量优先（本地用 PORT=7001，Vercel 由平台注入），默认 7100 避开常见冲突
const PORT = Number(process.env.PORT) || 7100;
app.listen(PORT, () => log.info(`[boot] listening on :${PORT}`));

function stripExtra(id) {
  return String(id).split("/")[0];
}
