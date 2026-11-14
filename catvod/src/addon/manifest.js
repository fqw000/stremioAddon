import { loadSourcesConfig } from "../config/loadConfig.js";

export function buildManifest() {
  const { sources } = loadSourcesConfig();
  const cfg = JSON.parse(JSON.stringify(sources[0] && {} )); // 占位，防止空

  const addonMeta = {
    id: "org.catvod.multisource",
    name: "CatVod Multi-Source",
    description: "多源影视聚合（技术研究）",
    version: "0.1.0",
    logo: "https://raw.githubusercontent.com/your/repo/main/logo.png",
  };

  const catalogs = [];
  for (const src of sources.filter((s) => s.enabled)) {
    for (const t of ["movie", "series"]) {
      catalogs.push({
        type: t,
        id: `${src.id}-${t}`,
        name: `${src.label} · ${t === "movie" ? "电影" : "剧集"}`,
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false },
        ],
      });
    }
  }

  return {
    id: addonMeta.id,
    version: addonMeta.version,
    name: addonMeta.name,
    description: addonMeta.description,
    logo: addonMeta.logo,
    types: ["movie", "series"],
    resources: [
      "catalog",
      "meta",
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt", "bfzy:", "ffzy:", "lz:"],
      },
    ],
    catalogs,
    behaviorHints: { adult: false, p2p: false },
  };
}