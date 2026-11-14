// import express from "express";
// import { loadSourcesConfig } from "./config/loadConfig.js";
// import { buildRegistry } from "./sources/registry.js";
// import { buildManifest } from "./addon/manifest.js";
// import { handleCatalog } from "./addon/catalog.js";
// import { handleMeta } from "./addon/meta.js";
// import { handleStream } from "./addon/stream.js";
// import { registerHlsRoutes } from "./routes/hls.js";
// import { registerDebugRoutes } from "./routes/debug.js";
// import { traceMiddleware } from "./utils/traceId.js";
// import { log } from "./logger.js";

// const app = express();
// app.disable("x-powered-by");
// app.set("trust proxy", true);

// app.use(traceMiddleware);
// app.use((req, res, next) => {
//   res.set("Access-Control-Allow-Origin", "*");
//   res.set("Access-Control-Allow-Headers", "*");
//   next();
// });

// const { sources } = loadSourcesConfig();
// const registry = buildRegistry(sources);
// log.info(`[boot] enabled sources: ${registry.enabled().map((e) => e.cfg.id).join(",")}`);

// app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// app.get("/manifest.json", (_req, res) => {
//   // Manifest 很少变：1h + swr 1h
//   res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=3600");
//   res.json(buildManifest());
// });

// // 统一把 handler 返回值里的 cacheMaxAge / staleRevalidate / staleError 转成 Cache-Control
// function sendWithCache(res, data, fallbackSeconds = 180) {
//   const maxAge = Number(data?.cacheMaxAge) || fallbackSeconds;
//   const swr = Number(data?.staleRevalidate);
//   const sie = Number(data?.staleError);

//   let cc = `public, max-age=${maxAge}, s-maxage=${maxAge}`;
//   if (swr) cc += `, stale-while-revalidate=${swr}`;
//   if (sie) cc += `, stale-if-error=${sie}`;
//   res.set("Cache-Control", cc);
//   res.json(data);
// }

// app.get(/^\/catalog\/(movie|series)\/(.+)\.json$/, async (req, res) => {
//   try {
//     const type = req.params[0];
//     const idPart = req.params[1];
//     const [id, ...extraParts] = idPart.split("/");
//     const extra = {};
//     for (const p of extraParts) {
//       const eq = p.indexOf("=");
//       if (eq > 0) extra[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
//     }
//     const r = await handleCatalog({ type, id, extra }, { registry });
//     sendWithCache(res, r, 1800);
//   } catch (e) {
//     log.error(`[catalog] uncaught: ${e.message}`);
//     res.json({ metas: [] });
//   }
// });

// app.get("/meta/:type/:id.json", async (req, res) => {
//   try {
//     const id = stripExtra(req.params.id);
//     const r = await handleMeta({ type: req.params.type, id }, { registry });
//     sendWithCache(res, r, 900);
//   } catch (e) {
//     log.error(`[meta] uncaught: ${e.message}`);
//     res.json({ meta: null });
//   }
// });

// app.get("/stream/:type/:id.json", async (req, res) => {
//   try {
//     const id = stripExtra(req.params.id);
//     const r = await handleStream({ type: req.params.type, id }, req, { registry });
//     sendWithCache(res, { streams: r.streams || [] }, 180);
//   } catch (e) {
//     log.error(`[stream] uncaught: ${e.message}`);
//     res.json({ streams: [] });
//   }
// });

// registerHlsRoutes(app, { getSourcesConfig: () => sources });
// registerDebugRoutes(app, { registry });

// const PORT = Number(process.env.PORT) || 7100;
// app.listen(PORT, () => log.info(`[boot] listening on :${PORT}`));

// function stripExtra(id) { return String(id).split("/")[0]; }



// 本地开发入口：createApp() + listen
// Vercel 不走这个文件，用 api/index.js
import { createApp } from "./createApp.js";
import { log } from "./logger.js";

const app = createApp();
const PORT = Number(process.env.PORT) || 7100;
app.listen(PORT, () => log.info(`[boot] listening on :${PORT}`));