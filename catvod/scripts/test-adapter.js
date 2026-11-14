// 验证链路：search → detail → resolveStream → 直链 manifest 可达
import { loadSourcesConfig } from "../src/config/loadConfig.js";
import { buildRegistry } from "../src/sources/registry.js";

const keyword = process.argv[2] || "庆余年";
const episode = process.argv[3] ? Number(process.argv[3]) : null;

(async () => {
  const { sources } = loadSourcesConfig();
  const registry = buildRegistry(sources);

  for (const { adapter, cfg } of registry.enabled()) {
    console.log(`\n===== ${cfg.id} (${cfg.label}) =====`);
    try {
      const t0 = Date.now();
      const results = await adapter.search(cfg, keyword);
      console.log(`search 命中 ${results.length} 条 (${Date.now() - t0}ms)`);
      if (!results.length) continue;

      const pick = results[0];
      console.log(`首条: id=${pick.vod_id} name="${pick.vod_name}" year=${pick.vod_year} type=${pick.type_name}`);

      const streams = await adapter.resolveStream(cfg, pick.vod_id, { episode });
      console.log(`resolveStream 返回 ${streams.length} 条:`);
      for (const s of streams) {
        console.log(`  [${s.lineName}] ${s.title} direct=${s.isDirect}${s.nonDirect ? " NON-DIRECT" : ""}${s.error ? " err=" + s.error : ""}`);
        console.log(`    ${s.url}`);
        if (s.isDirect) {
          try {
            const r = await fetch(s.url, { headers: { "User-Agent": cfg.ua, Referer: cfg.referer } });
            const text = await r.text();
            console.log(`    manifest: HTTP ${r.status}, ${text.length} bytes, head="${text.slice(0, 120).replace(/\n/g, "\\n")}"`);
          } catch (e) {
            console.log(`    manifest fetch failed: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.error(`[${cfg.id}] 失败:`, e.message);
    }
  }
})();