// ID 双向映射：Stremio ID <-> 上游条目
// 格式（无冒号）：
//   live    htvb1l784811
//   movie   htvb1v4564035
//   series  htvb1s23056
//   episode htvb1e23056_4744071_mp4
import { hashId } from './helper.js';

export function isImdbId(id) {
  return /^tt\d{5,10}$/i.test(String(id ?? ''));
}

export function buildId(prefix, kind, key, extra = '') {
  return `${prefix}${kind}${key}${extra ? `_${extra}` : ''}`;
}

export function parseId(id) {
  const m = /^(htv[a-z0-9]+)([lvse])([0-9a-f]+)(?:_([0-9]+)_([a-z0-9]+))?$/i.exec(
    String(id ?? ''),
  );
  if (!m) return null;
  // m[3]=seriesId, m[4]=episodeId, m[5]=ext（episode 形态）
  return {
    prefix: m[1].toLowerCase(),
    kind: m[2].toLowerCase(),
    key: m[3],
    seriesId: m[3] || null,
    episodeId: m[4] || null,
    ext: m[5] || null,
  };
}

export function findItem(items, key, kind) {
  if (!Array.isArray(items)) return null;
  const idField = kind === 'series' ? 'series_id' : 'stream_id';
  return (
    items.find((x) => String(x?.[idField] ?? '') === String(key)) ||
    items.find((x) => hashId(x?.playUrl ?? x?.url ?? '') === String(key)) ||
    null
  );
}
