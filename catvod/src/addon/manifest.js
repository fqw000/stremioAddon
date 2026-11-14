import { loadSourcesConfig } from "../config/loadConfig.js";

export function buildManifest(userConfig = {}) {
  const { sources } = loadSourcesConfig(userConfig);

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
    id: "wangqifei.eu.org.catvod",
    version: "0.1.0",
    name: "CatVod Multi-Source",
    description: "多源影视聚合，引入maccms源为stremio提供丰富的电影和剧集资源,支持多种源的搜索和播放",
    logo: "https://img.icons8.com/?size=200&id=23809&format=png",
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
    behaviorHints: {
      adult: false,
      p2p: false,
      configurable: true,
    },
  };
}