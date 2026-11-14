import { bfzy } from "./adapters/bfzy.js";
import { ffzy } from "./adapters/ffzy.js";
import { lz } from "./adapters/lz.js";

const ADAPTERS = { bfzy, ffzy, lz };

export function buildRegistry(sourcesConfig) {
  const map = new Map();
  for (const cfg of sourcesConfig) {
    const adapter = ADAPTERS[cfg.id];
    if (!adapter) continue;
    map.set(cfg.id, { adapter, cfg });
  }
  return {
    get(id) { return map.get(id); },
    all() { return [...map.values()]; },
    enabled() { return [...map.values()].filter((e) => e.cfg.enabled); },
  };
}