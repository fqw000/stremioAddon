import { buildRegistry } from "../sources/registry.js";
import { inferType } from "../metadata/matcher.js";
import { log } from "../logger.js";

/** 从 catalog id 解析 sourceId 和 type：bfzy-movie → { srcId:"bfzy", type:"movie" } */
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
  if (!keyword) {
    // 无 search 时返回空（不实现"热门浏览"，因为源不提供稳定热门接口）
    return { metas: [] };
  }

  try {
    const results = await entry.adapter.search(entry.cfg, keyword);
    const metas = [];
    for (const r of results) {
      const itemType = inferType(r.type_name);
      if (itemType !== type) continue; // 按 catalog 类型过滤
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
    return { metas };
  } catch (e) {
    log.error(`[catalog] ${id} failed: ${e.message}`);
    return { metas: [] };
  }
}

/** 从 item id 解析：bfzy:movie:27312 → { srcId, type, vodId } */
export function parseItemId(id) {
  const m = String(id).match(/^([a-z0-9]+):(movie|series):(\d+)/i);
  if (!m) return null;
  return { srcId: m[1], type: m[2], vodId: m[3] };
}