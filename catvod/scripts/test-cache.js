import * as cache from "../src/cache/index.js";

const key = "test:cache:" + Date.now();
const value = { hello: "world", n: 42 };

console.log("backend:", cache.backendName());
console.log("ping:", await cache.pingCache());

await cache.setJSON(key, value, 60);
console.log("get:", await cache.getJSON(key));

await cache.setJSON(key + ":empty", [], 60);
console.log("get empty (should be null):", await cache.getJSON(key + ":empty"));

console.log("get missing:", await cache.getJSON("no:such:key:" + Date.now()));

await cache.delJSON(key);
console.log("after del:", await cache.getJSON(key));
