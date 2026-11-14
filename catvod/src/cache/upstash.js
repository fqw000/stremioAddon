// Upstash Redis REST API 客户端（原生 fetch，不引 SDK）
const URL_BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

export function isEnabled() {
  return Boolean(URL_BASE && TOKEN);
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function request(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${URL_BASE}${path}`, { headers: authHeaders(), signal: ctrl.signal });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function get(key) {
  const j = await request(`/get/${encodeURIComponent(key)}`);
  if (j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

export async function set(key, value, ttlSeconds) {
  const v = encodeURIComponent(JSON.stringify(value));
  const path = ttlSeconds
    ? `/setex/${encodeURIComponent(key)}/${ttlSeconds}/${v}`
    : `/set/${encodeURIComponent(key)}/${v}`;
  await request(path);
}

export async function del(key) {
  await request(`/del/${encodeURIComponent(key)}`);
}

export async function ping() {
  const j = await request("/ping");
  return { ok: j.result === "PONG" };
}
