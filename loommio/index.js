#!/usr/bin/env node
// health.js
// 本地 Node 回归脚本（不部署到 Edge）。Node 18+ 原生 fetch。
// 读取项目根 .env.local 中的 ADDON_BASE_URL；缺失则退出。
// 覆盖：Manifest / Catalog / Search / Meta / Stream / 负缓存 / 缓存命中软提示

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = resolve(ROOT, '.env.local');

function loadEnvLocal() {
  if (!existsSync(ENV_PATH)) return;
  const text = readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();

const BASE = (process.env.ADDON_BASE_URL || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('ADDON_BASE_URL missing in .env.local or environment');
  process.exit(1);
}

const TIMEOUT_MS = 15000;

const results = [];

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

async function requestJson(path) {
  const url = BASE + path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal });
    const elapsed = Date.now() - started;
    const ct = res.headers.get('content-type') || '';
    const cors = res.headers.get('access-control-allow-origin') || '';
    const cc = res.headers.get('cache-control') || '';
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { url, status: res.status, elapsed, ct, cors, cc, data, rawLen: text.length };
  } catch (e) {
    return {
      url,
      status: 0,
      elapsed: Date.now() - started,
      ct: '',
      cors: '',
      cc: '',
      data: null,
      error: e.name === 'AbortError' ? 'timeout' : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}  ${detail}`);
}

function checkCors(r) {
  return r.cors === '*';
}

function summarize(r) {
  return `status=${r.status} ${r.elapsed}ms ct=${r.ct} cors=${r.cors || '-'} cc=${r.cc || '-'} len=${r.rawLen}`;
}

// ---------- 用例 ----------

async function testManifest() {
  const r = await requestJson('/manifest.json');
  const ok =
    r.status === 200 &&
    checkCors(r) &&
    r.data &&
    typeof r.data.id === 'string' &&
    Array.isArray(r.data.resources) &&
    Array.isArray(r.data.catalogs);
  record('manifest', ok, summarize(r));
  return ok ? r.data : null;
}

async function testRoot() {
  const r = await requestJson('/');
  const ok = r.status === 200 && checkCors(r) && r.data && typeof r.data.id === 'string';
  record('root -> manifest', ok, summarize(r));
  return ok ? r.data : null;
}

async function testCatalog() {
  const r = await requestJson('/catalog/series/loommio_cartoons.json');
  const metas = r.data && Array.isArray(r.data.metas) ? r.data.metas : null;
  const ok =
    r.status === 200 &&
    checkCors(r) &&
    metas !== null &&
    metas.length > 0 &&
    metas.every(
      (m) =>
        typeof m.id === 'string' &&
        m.id.startsWith('loommio_') &&
        typeof m.name === 'string' &&
        typeof m.poster === 'string'
    );
  record('catalog', ok, `${summarize(r)} metas=${metas ? metas.length : 'n/a'}`);

  // 缓存命中软提示：同一请求再打一次，比较耗时
  if (ok) {
    const r2 = await requestJson('/catalog/series/loommio_cartoons.json');
    const faster = r2.status === 200 && r2.elapsed < r.elapsed;
    record(
      'catalog cache hint (soft)',
      faster,
      `first=${r.elapsed}ms second=${r2.elapsed}ms`
    );
  }

  return metas;
}

async function testSearch() {
  const r = await requestJson('/catalog/series/loommio_cartoons/search=cartoon.json');
  const metas = r.data && Array.isArray(r.data.metas) ? r.data.metas : null;
  const ok = r.status === 200 && checkCors(r) && metas !== null;
  record('catalog search', ok, `${summarize(r)} metas=${metas ? metas.length : 'n/a'}`);
  return metas;
}

async function testMeta(plID) {
  if (!plID) {
    record('meta', false, 'skipped: no plID from catalog');
    return null;
  }
  const r = await requestJson(`/meta/series/${encodeURIComponent(plID)}.json`);
  const meta = r.data ? r.data.meta : null;
  const ok =
    r.status === 200 &&
    checkCors(r) &&
    meta &&
    meta.id === plID &&
    typeof meta.name === 'string' &&
    Array.isArray(meta.videos) &&
    meta.videos.length > 0 &&
    meta.videos.every(
      (v) =>
        typeof v.id === 'string' &&
        v.id.startsWith('loommio_') &&
        v.id.includes('__') &&
        v.season === 1 &&
        Number.isInteger(v.episode) &&
        v.episode >= 1
    );
  record('meta', ok, `${summarize(r)} videos=${meta && meta.videos ? meta.videos.length : 'n/a'}`);
  return ok ? meta : null;
}

async function testStream(videoID) {
  if (!videoID) {
    record('stream', false, 'skipped: no videoID from meta');
    return null;
  }
  const r = await requestJson(`/stream/series/${encodeURIComponent(videoID)}.json`);
  const streams = r.data && Array.isArray(r.data.streams) ? r.data.streams : null;
  const ok =
    r.status === 200 &&
    checkCors(r) &&
    streams !== null &&
    streams.length > 0 &&
    streams.every(
      (s) =>
        typeof s.url === 'string' &&
        s.url.length > 0 &&
        !s.url.includes('#') &&
        s.behaviorHints &&
        typeof s.behaviorHints.bingeGroup === 'string'
    );
  record('stream', ok, `${summarize(r)} streams=${streams ? streams.length : 'n/a'}`);
  return ok ? streams : null;
}

async function testNegativeMeta() {
  const r = await requestJson('/meta/series/loommio_pl_notexist.json');
  const ok =
    r.status === 200 &&
    checkCors(r) &&
    r.data &&
    r.data.meta === null;
  record('meta not-found -> { meta: null }', ok, summarize(r));
}

async function testNegativeStream() {
  const r = await requestJson('/stream/series/loommio_pl_notexist__vid_notexist.json');
  const ok =
    r.status === 200 &&
    checkCors(r) &&
    r.data &&
    Array.isArray(r.data.streams) &&
    r.data.streams.length === 0;
  record('stream not-found -> { streams: [] }', ok, summarize(r));
}

// ---------- 主流程 ----------

async function main() {
  console.log(`[health] ${ts()} base=${BASE}`);

  await testManifest();
  await testRoot();

  const metas = await testCatalog();
  await testSearch();

  const firstMetaID = metas && metas[0] ? metas[0].id : null;
  const meta = await testMeta(firstMetaID);

  const firstVideoID = meta && meta.videos && meta.videos[0] ? meta.videos[0].id : null;
  await testStream(firstVideoID);

  await testNegativeMeta();
  await testNegativeStream();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n[health] ${ts()} total=${results.length} pass=${passed} fail=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`[health] fatal: ${e.message}`);
  process.exit(1);
});