import { cleanHls } from "../src/hls/cleaner.js";

const url = process.argv[2];
const src = process.argv[3] || null;
if (!url) {
  console.error("usage: node scripts/test-hls.js <m3u8-url> [sourceId]");
  process.exit(1);
}

const r = await cleanHls(url, src, {
  addonBaseUrl: "http://localhost:7000",
  sourceCfg: {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
});

console.log("===", r.type, "risk:", r.risk, "degraded:", !!r.degraded, "===");
console.log("original:", r.original.length, "bytes,", (r.original.match(/^#EXTINF/gm) || []).length, "segments");
console.log("cleaned :", r.cleaned.length, "bytes,", (r.cleaned.match(/^#EXTINF/gm) || []).length, "segments");
console.log("hits:", JSON.stringify(r.hits, null, 2));
console.log("\n--- cleaned head ---\n" + r.cleaned.slice(0, 1200));