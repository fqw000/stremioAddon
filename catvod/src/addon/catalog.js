import { cachedSearch } from "../sources/cached.js";
import { inferType } from "../metadata/matcher.js";
import { log } from "../logger.js";

function parseCatalogId(id) {
  const m = String(id).match(/^(.+)-(movie|series)$/);
  if (!m) return null;
  return { srcId: m[1], type: m[2] };
}

export async function handleCatalog({ type, id, extra = {} }, { registry }) {
  const parsed = parseCatalogId(id);
  if (!parsed) return { metas: [] };
  if (parsed.type !== type) return { metas: [] };

  const entry = registry.get(parsed.srcId);
  if (!entry) return { metas: [] };

  const keyword = extra.search;
  if (!keyword) return { metas: [] };

  try {
    const results = await cachedSearch(entry, keyword);
    const metas = [];
    for (const r of results) {
      const itemType = inferType(r.type_name);
      if (itemType !== type) continue;
      metas.push({
        id: `${parsed.srcId}:${type}:${r.vod_id}`,
        type,
        name: r.vod_name,
        poster: r.vod_pic || undefined,
        releaseInfo: r.vod_year || undefined,
        description: r.vod_remarks || undefined,
      });
    }
    log.info(`[catalog] ${id} search="${keyword}" → ${metas.length} items`);

    // Catalog 可容忍短暂陈旧：max-age 30min + swr 10min + stale-if-error 1h
    return {
      metas,
      cacheMaxAge: 1800,
      staleRevalidate: 600,
      staleError: 3600,
    };
  } catch (e) {
    log.error(`[catalog] ${id} failed: ${e.message}`);
    return { metas: [] };
  }
}

export function parseItemId(id) {
  const m = String(id).match(/^([a-z0-9]+):(movie|series):(\d+)/i);
  if (!m) return null;
  return { srcId: m[1], type: m[2], vodId: m[3] };
}
