import { parseSourceTitle, normalize } from "./normalizeTitle.js";

export const DEFAULT_WEIGHTS = {
  title: 0.5,
  year: 0.2,
  type: 0.1,
  season: 0.2,
  aliasBonus: 0.1,
};

export const DEFAULT_THRESHOLDS = {
  high: 0.85,
  medium: 0.60,
};

/** 字符 bigram Dice 系数 */
export function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 从 type_name 判定 movie/series */
export function inferType(typeName) {
  if (!typeName) return "series";
  if (/电影|片$/.test(typeName) && !/剧/.test(typeName)) return "movie";
  return "series";
}

/**
 * 对单条候选打分
 * @param {{ name:string, aliases?:string[], year?:string|number, type:"movie"|"series", season?:number }} meta
 * @param {{ vod_name:string, vod_year?:string, type_name?:string }} candidate
 */
export function scoreCandidate(meta, candidate, weights = DEFAULT_WEIGHTS) {
  const parsed = parseSourceTitle(candidate.vod_name);
  const candNorm = normalize(parsed.baseName);

  // 1. 标题相似度（meta.name + aliases 取最大）
  const names = [meta.name, ...(meta.aliases || [])].filter(Boolean).map(normalize);
  const titleSim = names.length
    ? Math.max(...names.map((n) => diceSimilarity(n, candNorm)))
    : 0;

  // 2. 年份（缺失给中性 0.5）
  let yearScore = 0.5;
  if (meta.year && candidate.vod_year) {
    const diff = Math.abs(Number(meta.year) - Number(candidate.vod_year));
    yearScore = diff <= 1 ? 1 : 0;
  }

  // 3. 类型
  const candType = inferType(candidate.type_name);
  const typeScore = candType === meta.type ? 1 : 0;

  // 4. 季（仅 series）
  let seasonScore = 0.5;
  if (meta.type === "series" && meta.season && parsed.season) {
    seasonScore = meta.season === parsed.season ? 1 : 0;
  }

  const base =
    titleSim * weights.title +
    yearScore * weights.year +
    typeScore * weights.type +
    seasonScore * weights.season;

  // 5. 别名加分（多别名且标题相似度不低）
  const aliasBonus = names.length > 1 && titleSim > 0.7 ? weights.aliasBonus : 0;

  const score = Math.min(1, Math.round((base + aliasBonus) * 1000) / 1000);

  return {
    score,
    breakdown: {
      title: Math.round(titleSim * 1000) / 1000,
      year: yearScore,
      type: typeScore,
      season: seasonScore,
      aliasBonus,
      parsed: { baseName: parsed.baseName, season: parsed.season, lang: parsed.lang, candType },
    },
  };
}

/**
 * 对一源的所有候选打分，按分数降序
 * @returns {Array<{ candidate, score, breakdown, level:"high"|"medium"|"low" }>}
 */
export function rankCandidates(meta, candidates, {
  weights = DEFAULT_WEIGHTS,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const ranked = candidates.map((c) => {
    const r = scoreCandidate(meta, c, weights);
    const level = r.score >= thresholds.high ? "high"
      : r.score >= thresholds.medium ? "medium" : "low";
    return { candidate: c, score: r.score, breakdown: r.breakdown, level };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}