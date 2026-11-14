import { resolveByImdb } from "../metadata/tmdb.js";
import { rankCandidates, DEFAULT_THRESHOLDS } from "../metadata/matcher.js";
import { loadRules } from "../hls/rules.js";
import { pingCache, backendName } from "../cache/index.js";
import { log } from "../logger.js";

export function registerDebugRoutes(app, { registry }) {
  // 匹配链路全透明：TMDB 元数据 + 各源 search + 每候选打分明细
  app.get("/debug/match", async (req, res) => {
    const { imdbid, type = "series", season, episode } = req.query;
    if (!/^tt\d+$/.test(String(imdbid || ""))) {
      return res.status(400).json({ error: "imdbid required (tt...)" });
    }

    const t0 = Date.now();
    const meta = await resolveByImdb(String(imdbid), String(type), {
      season: season ? Number(season) : 1,
    });

    if (!meta) {
      return res.json({
        imdbid, type, season, episode,
        meta: null,
        reason: "TMDB unavailable or not found (check TMDB_API_KEY)",
        candidates: {},
        elapsedMs: Date.now() - t0,
      });
    }

    const entries = registry.enabled();
    const searches = await Promise.allSettled(
      entries.map(async (entry) => {
        const t = Date.now();
        const results = await entry.adapter.search(entry.cfg, meta.name);
        return { source: entry.cfg.id, label: entry.cfg.label, ms: Date.now() - t, results };
      })
    );

    const candidates = {};
    for (let i = 0; i < searches.length; i++) {
      const r = searches[i];
      const srcId = entries[i].cfg.id;
      if (r.status !== "fulfilled") {
        candidates[srcId] = { error: r.reason?.message || String(r.reason) };
        continue;
      }
      const { label, ms, results } = r.value;
      const ranked = rankCandidates(meta, results, { thresholds: DEFAULT_THRESHOLDS });
      candidates[srcId] = {
        label,
        ms,
        total: results.length,
        ranked: ranked.slice(0, 5).map((x) => ({
          vod_id: x.candidate.vod_id,
          vod_name: x.candidate.vod_name,
          vod_year: x.candidate.vod_year,
          type_name: x.candidate.type_name,
          score: x.score,
          level: x.level,
          breakdown: x.breakdown,
        })),
      };
    }

    res.json({
      imdbid, type, season, episode,
      meta,
      candidates,
      elapsedMs: Date.now() - t0,
    });
  });

  // 各源健康检测
  app.get("/debug/sources", async (req, res) => {
    const keyword = String(req.query.keyword || "庆余年");
    const entries = registry.enabled();
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const t = Date.now();
        try {
          const r = await entry.adapter.search(entry.cfg, keyword);
          return {
            id: entry.cfg.id,
            label: entry.cfg.label,
            ok: true,
            ms: Date.now() - t,
            count: r.length,
            sample: r[0]?.vod_name || null,
          };
        } catch (e) {
          return {
            id: entry.cfg.id,
            label: entry.cfg.label,
            ok: false,
            ms: Date.now() - t,
            error: e.message,
          };
        }
      })
    );

    res.json({
      keyword,
      ts: Date.now(),
      sources: results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) })),
    });
  });

  // 热重载广告规则
  app.post("/debug/reload-rules", (req, res) => {
    try {
      const rules = loadRules();
      log.info(`[debug] rules reloaded: ${rules.rules.length} groups, ${rules.ads.length} ads`);
      res.json({ ok: true, groups: rules.rules.length, ads: rules.ads.length });
    } catch (e) {
      log.error(`[debug] reload-rules failed: ${e.message}`);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 缓存后端状态
  app.get("/debug/cache", async (req, res) => {
    try {
      const p = await pingCache();
      res.json({ backend: backendName(), ...p });
    } catch (e) {
      res.status(500).json({ backend: backendName(), ok: false, error: e.message });
    }
  });
}
