// 真实写入缓存，供 Upstash Console 验证。不删除。
import { loadSourcesConfig } from "../src/config/loadConfig.js";
import { buildRegistry } from "../src/sources/registry.js";
import { cachedSearch, cachedDetail } from "../src/sources/cached.js";
import * as cache from "../src/cache/index.js";

const { sources } = loadSourcesConfig();
const registry = buildRegistry(sources);
const bfzy = registry.get("bfzy");

console.log("backend:", cache.backendName());
console.log("prefix :", cache.currentPrefix());

// 1. 永不删的验证 key
const vkey = "verify:hello:" + Date.now();
await cache.setJSON(vkey, { ts: Date.now(), note: "persist for Redis inspection" }, 3600);
console.log("\n[1] persisted key:", cache.exampleKey(vkey));
console.log("    value:", await cache.getJSON(vkey));

// 2. search 缓存
console.log("\n[2] cachedSearch bfzy 庆余年 ...");
const results = await cachedSearch(bfzy, "庆余年");
console.log("    returned:", results.length, "items");
console.log("    key should be:", cache.exampleKey(`search:bfzy:庆余年`));

// 3. detail 缓存
if (results[0]?.vod_id) {
  console.log("\n[3] cachedDetail bfzy", results[0].vod_id, "...");
  const item = await cachedDetail(bfzy, String(results[0].vod_id));
  console.log("    detail:", item?.vod_name);
  console.log("    key should be:", cache.exampleKey(`detail:bfzy:${results[0].vod_id}`));
}

console.log("\n去 Upstash Console → Data Browser 搜 catvod:prod: 应能看到上述 key");
