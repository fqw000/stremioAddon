#!/usr/bin/env node
// health.js
// 本地 Node 回归脚本（不部署到 Edge）。Node 18+ 原生 fetch。
// 读取项目根 .env.local 中的 ADDON_BASE_URL；缺失则退出。
// 覆盖：Manifest / Root / Catalog / Search / Meta / Stream / 负缓存 / 缓存命中软提示
// 详细日志：每个请求打印 URL、耗时、状态、Content-Type、CORS、Cache-Control、响应体预览

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = resolve(ROOT, '.env.local');

const EXPECTED_MANIFEST_ID = 'com.loommio.cartoons';
const TIMEOUT_MS = 15000;
const BODY_PREVIEW_LEN = 240;

const results = [];

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(msg) {
  console.log(`[health] ${ts()} ${msg}`);
}

function loadEnvLocal() {
  if (!existsSync(ENV_PATH)) {
    log(`.env.local not found at ${ENV_PATH}`);
    return false;
  }
  const text = readFileSync(ENV_PATH, 'utf8');
  let loaded = 0;
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
    if (!(k in process.env)) {
      process.env[k] = v;
      loaded += 1;
    }
  }
  log(`.env.local loaded: ${loaded} vars`);
  return true;
}

const envFromFile = loadEnvLocal();

const RAW_BASE = process.env.ADDON_BASE_URL || 'http://localhost:3000';
const BASE = RAW_BASE.replace(/\/+$/, '');

log(`node=${process.version} cwd=${ROOT}`);
log(`ADDON_BASE_URL(raw)="${RAW_BASE}" source=${envFromFile && RAW_BASE ? '.env.local|env' : 'env'}`);

if (!BASE) {
  console.error('ADDON_BASE_URL missing in .env.local or environment');
  process.exit(1);
}

// 常见误配检测：指向源站，而不是 Addon
if (/loommio\.com$/i.test(new URL(BASE).hostname) && !/vercel\.app$/i.test(new URL(BASE).hostname)) {
  log(`WARN: base host "${new URL(BASE).hostname}" looks like the source site, not your addon.`);
  log(`WARN: expected http://localhost:3000 (vercel dev) or https://<project>.vercel.app`);
}

log(`base normalized = ${BASE}`);
console.log('');

function preview(text) {
  if (!text) return '<empty>';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_PREVIEW_LEN ? flat.slice(0, BODY_PREVIEW_LEN) + '…' : flat;
}

async function requestJson(path, label) {
  const url = BASE + path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  log(`--> [${label}] GET ${url}`);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const elapsed = Date.now() - started;
    const ct = res.headers.get('content-type') || '';
    const cors = res.headers.get('access-control-allow-origin') || '';
    const cc = res.headers.get('cache-control') || '';
    const text = await res.text();
    const len = text.length;
    let data = null;
    let jsonErr = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      jsonErr = e.message;
    }
    log(
      `<-- [${label}] status=${res.status} ${elapsed}ms ct=${ct || '-'} ` +
        `cors=${cors || '-'} cc=${cc || '-'} len=${len} json=${data ? 'ok' : 'fail'}`
    );
    if (!data || res.status >= 400) {
      log(`    body: ${preview(text)}`);
    }
    return { url, status: res.status, elapsed, ct, cors, cc, data, rawLen: len, jsonErr, bodyText: text };
  } catch (e) {
    const elapsed = Date.now() - started;
    const reason = e.name === 'AbortError' ? `timeout>${TIMEOUT_MS}ms` : e.message;
    log(`<-- [${label}] ERROR ${elapsed}ms reason=${reason}`);
    return { url, status: 0, elapsed, ct: '', cors: '', cc: '', data: null, rawLen: 0, error: reason, bodyText: '' };
  } finally {
    clearTimeout(timer);
  }
}

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  log(`[${tag}] ${name}  ${detail}`);
  if (!pass) log(`       ↳ detail: ${detail}`);
}

function checkCors(r) {
  return r.cors === '*';
}

function summarize(r) {
  return `status=${r.status} ${r.elapsed}ms ct=${r.ct || '-'} cors=${r.cors || '-'} cc=${r.cc || '-'} len=${r.rawLen}`;
}

// ---------- 用例 ----------

async function testManifest() {
  const r = await requestJson('/manifest.json', 'manifest');
  const isJson = !!r.data;
  const idOk = isJson && r.data.id === EXPECTED_MANIFEST_ID;
  const shapeOk = isJson && Array.isArray(r.data.resources) && Array.isArray(r.data.catalogs);
  const corsOk = checkCors(r);

  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!isJson) reasons.push(`not json (${r.jsonErr || 'parse error'})`);
  if (isJson && !idOk) reasons.push(`manifest.id="${r.data.id}" != "${EXPECTED_MANIFEST_ID}" (base 可能指向源站)`);
  if (!shapeOk) reasons.push('resources/catalogs missing');
  if (!corsOk) reasons.push(`cors missing (${r.cors || 'none'})`);

  const ok = reasons.length === 0;
  record('manifest', ok, ok ? summarize(r) : `${summarize(r)} reasons=${reasons.join('; ')}`);

  if (isJson && !idOk) {
    log(`       ↳ hint: 当前 base=${BASE}，期望 manifest.id=${EXPECTED_MANIFEST_ID}`);
  }
  return ok ? r.data : null;
}

async function testRoot() {
  const r = await requestJson('/', 'root');
  const isJson = !!r.data;
  const idOk = isJson && r.data.id === EXPECTED_MANIFEST_ID;
  const ok = r.status === 200 && checkCors(r) && idOk;
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!isJson) reasons.push('not json');
  if (isJson && !idOk) reasons.push(`id="${r.data.id}" != "${EXPECTED_MANIFEST_ID}"`);
  if (!checkCors(r)) reasons.push('cors missing');
  record('root -> manifest', ok, ok ? summarize(r) : `${summarize(r)} reasons=${reasons.join('; ')}`);
  return ok ? r.data : null;
}

async function testCatalog() {
  const r = await requestJson('/catalog/series/loommio_cartoons.json', 'catalog');
  const metas = r.data && Array.isArray(r.data.metas) ? r.data.metas : null;
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!metas) reasons.push('metas not array');
  if (metas && metas.length === 0) reasons.push('metas empty');
  if (metas) {
    const bad = metas.find(
      (m) =>
        typeof m.id !== 'string' ||
        !m.id.startsWith('loommio_') ||
        typeof m.name !== 'string' ||
        typeof m.poster !== 'string'
    );
    if (bad) reasons.push(`bad meta item: ${preview(JSON.stringify(bad))}`);
  }
  if (!checkCors(r)) reasons.push('cors missing');
  const ok = reasons.length === 0;
  record('catalog', ok, ok ? `${summarize(r)} metas=${metas.length}` : `${summarize(r)} reasons=${reasons.join('; ')}`);

  if (ok) {
    const r2 = await requestJson('/catalog/series/loommio_cartoons.json', 'catalog#2');
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
  const r = await requestJson('/catalog/series/loommio_cartoons/search=cartoon.json', 'search');
  const metas = r.data && Array.isArray(r.data.metas) ? r.data.metas : null;
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!metas) reasons.push('metas not array');
  if (!checkCors(r)) reasons.push('cors missing');
  const ok = reasons.length === 0;
  record('catalog search', ok, ok ? `${summarize(r)} metas=${metas.length}` : `${summarize(r)} reasons=${reasons.join('; ')}`);
  return metas;
}

async function testMeta(plID) {
  if (!plID) {
    record('meta', false, 'skipped: no plID from catalog');
    return null;
  }
  const r = await requestJson(`/meta/series/${encodeURIComponent(plID)}.json`, 'meta');
  const meta = r.data ? r.data.meta : null;
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!meta) reasons.push('meta is null');
  if (meta) {
    if (meta.id !== plID) reasons.push(`meta.id="${meta.id}" != "${plID}"`);
    if (typeof meta.name !== 'string') reasons.push('name missing');
    if (!Array.isArray(meta.videos) || meta.videos.length === 0) reasons.push('videos empty');
    if (Array.isArray(meta.videos)) {
      const bad = meta.videos.find(
        (v) =>
          typeof v.id !== 'string' ||
          !v.id.startsWith('loommio_') ||
          !v.id.includes('__') ||
          v.season !== 1 ||
          !Number.isInteger(v.episode) ||
          v.episode < 1
      );
      if (bad) reasons.push(`bad video item: ${preview(JSON.stringify(bad))}`);
    }
  }
  if (!checkCors(r)) reasons.push('cors missing');
  const ok = reasons.length === 0;
  record('meta', ok, ok ? `${summarize(r)} videos=${meta.videos.length}` : `${summarize(r)} reasons=${reasons.join('; ')}`);
  return ok ? meta : null;
}

async function testStream(videoID) {
  if (!videoID) {
    record('stream', false, 'skipped: no videoID from meta');
    return null;
  }
  const r = await requestJson(`/stream/series/${encodeURIComponent(videoID)}.json`, 'stream');
  const streams = r.data && Array.isArray(r.data.streams) ? r.data.streams : null;
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!streams) reasons.push('streams not array');
  if (streams && streams.length === 0) reasons.push('streams empty');
  if (streams) {
    const bad = streams.find(
      (s) =>
        typeof s.url !== 'string' ||
        s.url.length === 0 ||
        s.url.includes('#') ||
        !s.behaviorHints ||
        typeof s.behaviorHints.bingeGroup !== 'string'
    );
    if (bad) reasons.push(`bad stream item: ${preview(JSON.stringify(bad))}`);
  }
  if (!checkCors(r)) reasons.push('cors missing');
  const ok = reasons.length === 0;
  record('stream', ok, ok ? `${summarize(r)} streams=${streams.length}` : `${summarize(r)} reasons=${reasons.join('; ')}`);
  return ok ? streams : null;
}

async function testNegativeMeta() {
  const r = await requestJson('/meta/series/loommio_pl_notexist.json', 'meta-negative');
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!r.data || r.data.meta !== null) reasons.push('meta !== null');
  if (!checkCors(r)) reasons.push('cors missing');
  const ok = reasons.length === 0;
  record('meta not-found -> { meta: null }', ok, ok ? summarize(r) : `${summarize(r)} reasons=${reasons.join('; ')}`);
}

async function testNegativeStream() {
  const r = await requestJson('/stream/series/loommio_pl_notexist__vid_notexist.json', 'stream-negative');
  const reasons = [];
  if (r.status !== 200) reasons.push(`status=${r.status}`);
  if (!r.data || !Array.isArray(r.data.streams)) reasons.push('streams not array');
  if (r.data && Array.isArray(r.data.streams) && r.data.streams.length !== 0) reasons.push(`streams.length=${r.data.streams.length}`);
  if (!checkCors(r)) reasons.push('cors missing');
  const ok = reasons.length === 0;
  record('stream not-found -> { streams: [] }', ok, ok ? summarize(r) : `${summarize(r)} reasons=${reasons.join('; ')}`);
}

// ---------- 主流程 ----------

async function main() {
  await testManifest();
  await testRoot();

  const metas = await testCatalog();
  await testSearch();

  const firstMetaID = metas && metas[0] ? metas[0].id : null;
  log(`picked first plID = ${firstMetaID || '(none)'}`);
  const meta = await testMeta(firstMetaID);

  const firstVideoID = meta && meta.videos && meta.videos[0] ? meta.videos[0].id : null;
  log(`picked first videoID = ${firstVideoID || '(none)'}`);
  await testStream(firstVideoID);

  await testNegativeMeta();
  await testNegativeStream();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('');
  log(`SUMMARY total=${results.length} pass=${passed} fail=${failed}`);

  if (failed > 0) {
    log('FAILED CASES:');
    for (const r of results) {
      if (!r.pass) log(`  - ${r.name}: ${r.detail}`);
    }
    log(`hint: 当前 base=${BASE}；本地 dev 应为 http://localhost:3000，线上应为 https://<project>.vercel.app`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[health] fatal: ${e.stack || e.message}`);
  process.exit(1);
});