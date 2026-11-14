// 内存 LRU 缓存（无 Upstash 时的降级实现，单实例有效）
const MAX_SIZE = 2000;
const store = new Map(); // key -> { value, expireAt }

function now() { return Date.now(); }

export function isEnabled() { return true; }

export async function get(key) {
  const e = store.get(key);
  if (!e) return null;
  if (e.expireAt && e.expireAt < now()) {
    store.delete(key);
    return null;
  }
  // LRU：命中后移到末尾
  store.delete(key);
  store.set(key, e);
  return e.value;
}

export async function set(key, value, ttlSeconds) {
  if (store.size >= MAX_SIZE) {
    // 淘汰最早的 key
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
  store.set(key, {
    value,
    expireAt: ttlSeconds ? now() + ttlSeconds * 1000 : null,
  });
}

export async function del(key) {
  store.delete(key);
}

export async function ping() {
  return { ok: true, backend: "memory", size: store.size };
}
