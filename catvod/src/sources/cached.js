// search / detail 缓存包装：catalog / meta / stream 统一走这里
import { maccmsDetail } from "./maccmsBase.js";
import { getJSON, setJSON, withInflight } from "../cache/index.js";
import { KEY, TTL } from "../cache/ttl.js";
import { log } from "../logger.js";

export async function cachedSearch(entry, keyword) {
  const key = KEY.search(entry.cfg.id, keyword);
  const hit = await getJSON(key);
  if (hit) return hit;

  return withInflight(key, async () => {
    const results = await entry.adapter.search(entry.cfg, keyword);
    // 空结果不写（setJSON 已过滤空数组）
    await setJSON(key, results, TTL.SEARCH_RESULTS);
    return results;
  });
}

export async function cachedDetail(entry, vodId) {
  const key = KEY.detail(entry.cfg.id, vodId);
  const hit = await getJSON(key);
  if (hit) return hit;

  return withInflight(key, async () => {
    const item = await maccmsDetail(entry.cfg, vodId);
    if (item) await setJSON(key, item, TTL.SOURCE_DETAIL);
    return item;
  });
}
