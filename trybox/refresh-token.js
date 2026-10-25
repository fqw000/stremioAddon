import { Redis } from "@upstash/redis";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

// ========== 配置项 ==========
const LOCK_KEY = "tryboxStream:dev:token:lock";
const LOCK_TTL = 30;
const ACCESS_KEY = "tryboxStream:dev:token:access";
const REFRESH_KEY = "tryboxStream:dev:token:refresh";
const REFRESH_THRESHOLD = 60 * 10;
const ACCESS_TTL = 3600;
const SCRIPT_MAX_TIME = 30000;

// 固定前缀
const APP_PREFIX = "trybox refreshToken Action";

// ========== 环境变量 ==========
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://saichcuwzbncuqnqhuul.supabase.co";
const SUPABASE_ANON = process.env.SUPABASE_ANON || "";
const BARK_KEY = process.env.BARK_KEY || "";

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const UNLOCK_SCRIPT = `
if redis.call("GET",KEYS[1]) == ARGV[1] then
    return redis.call("DEL",KEYS[1])
else
    return 0
end
`;

// ========== 带超时的 fetch ==========
function fetchWithTimeout(resource, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(resource, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id))
    .catch((e) => {
      if (e.name === "AbortError") {
        throw new Error(`请求超时（${timeoutMs}ms）`);
      }
      throw e;
    });
}

// ========== Bark 通知 ==========
const WORKFLOW_URL =
  "https://github.com/fqw000/tbStremio/actions/workflows/refresh-token.yml";

async function sendBark({
  title,
  body,
  url = WORKFLOW_URL,
  group = "TryBox",
  level = "active",
}) {
  if (!BARK_KEY) {
    console.warn("[Bark] 未配置 BARK_KEY，跳过通知");
    return;
  }

  const bodyWithLink = body
    ? `${body}\n\n---\n[查看工作流](${WORKFLOW_URL})`
    : `[查看工作流](${WORKFLOW_URL})`;

  try {
    const resp = await fetchWithTimeout(
      "https://api.day.app/push",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_key: BARK_KEY,
          title,
          body: bodyWithLink,
          url,
          markdown: "1",
          group,
          level,
        }),
      },
      5000
    );

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("[Bark] 返回非 JSON:", text.slice(0, 200));
      return;
    }

    if (data.code !== 200) {
      console.error("[Bark] 推送失败:", JSON.stringify(data).slice(0, 200));
    } else {
      console.log("[Bark] 通知发送成功");
    }
  } catch (e) {
    console.error("[Bark] 推送异常:", e.message);
  }
}

// ========== Token 预览 ==========
function getTokenPreview(token) {
  if (!token || typeof token !== "string") return "null";
  if (token.length <= 16) return `*******(len=${token.length})`;
  return `${token.slice(0, 10)}...${token.slice(-4)}(len=${token.length})`;
}

// ========== Supabase 刷新 ==========
async function refreshWithSupabase(refreshToken) {
  console.log(`[Supabase] 刷新, refresh前缀: ${getTokenPreview(refreshToken)}`);

  const resp = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    10000
  );

  const rawText = await resp.text();
  console.log(`[Supabase] HTTP ${resp.status}`);

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Supabase非JSON响应: ${rawText.slice(0, 200)}`);
  }

  if (!resp.ok) {
    throw new Error(`status:${resp.status}, ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  if (!parsed.access_token) {
    throw new Error("缺少access_token");
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || refreshToken,
  };
}

// ========== 主流程 ==========
async function main() {
  const lockId = uuidv4();
  let lockAcquired = false;
  let refreshToken = null; // 提到外面，catch 里能访问

  // 全局超时
  const globalTimeout = setTimeout(async () => {
    console.error("❌ 全局超时：超过30s，强制退出");
    if (lockAcquired) {
      try {
        await redis.eval(UNLOCK_SCRIPT, [LOCK_KEY], [lockId]);
        console.log("[超时] 已尝试释放锁");
      } catch (e) {
        console.error("[超时释放锁失败]", e.message);
      }
    }
    const refreshPreview = refreshToken
      ? getTokenPreview(refreshToken)
      : "(未读取)";
    await sendBark({
      title: "⏱️ TryBox 脚本超时",
      body: `**任务**: refreshToken\n\n**原因**: 执行超过 ${SCRIPT_MAX_TIME / 1000} 秒\n\n**refresh**: \`${refreshPreview}\`\n\n**项目**: ${APP_PREFIX}`,
      level: "timeSensitive",
    });
    process.exit(1);
  }, SCRIPT_MAX_TIME);

  console.log("===== Token刷新任务开始 =====");
  console.log(`[锁] key=${LOCK_KEY}, id=${lockId}`);

  const lockOk = await redis.set(LOCK_KEY, lockId, { nx: true, ex: LOCK_TTL });
  if (!lockOk) {
    console.log("[锁] 任务正在运行，跳过");
    clearTimeout(globalTimeout);
    return;
  }
  lockAcquired = true;
  console.log("[锁] 获取成功");

  try {
    const [accessToken, rt] = await redis.mget([ACCESS_KEY, REFRESH_KEY]);
    refreshToken = rt;
    console.log(
      `[Redis] access=${getTokenPreview(accessToken)}, refresh=${getTokenPreview(refreshToken)}`
    );

    let needRefresh = false;
    const exp = jwt.decode(accessToken)?.exp;
    const now = Math.floor(Date.now() / 1000);

    if (!accessToken || !exp) {
      console.log("[JWT] access无效，执行刷新");
      needRefresh = true;
    } else {
      const remainSec = exp - now;
      console.log(`[JWT] 剩余${remainSec}秒`);
      if (remainSec <= REFRESH_THRESHOLD) {
        needRefresh = true;
      } else {
        console.log("[判断] 有效期充足，无需刷新");
        clearTimeout(globalTimeout);
        return;
      }
    }

    if (needRefresh) {
      const { accessToken: newAccess, refreshToken: newRefresh } =
        await refreshWithSupabase(refreshToken);
      await redis.set(ACCESS_KEY, newAccess, { ex: ACCESS_TTL });
      await redis.set(REFRESH_KEY, newRefresh);
      console.log("✅ Token刷新并保存完成");
    }
  } catch (err) {
    console.error("❌ 任务异常", err.message);
    const msg = err.message || String(err);
    const refreshPreview = getTokenPreview(refreshToken);

    if (msg.includes("status:401")) {
      await sendBark({
        title: "🔑 TryBox Token 失效",
        body: `**状态**: refresh_token 已过期\n\n**refresh**: \`${refreshPreview}\`\n\n**需要**: 手动登录更新 token\n\n**项目**: ${APP_PREFIX}`,
        level: "timeSensitive",
      });
    } else {
      await sendBark({
        title: "❌ TryBox 刷新任务异常",
        body: `**错误**: ${msg}\n\n**refresh**: \`${refreshPreview}\`\n\n**项目**: ${APP_PREFIX}`,
        level: "active",
      });
    }
  } finally {
    clearTimeout(globalTimeout);
    if (lockAcquired) {
      try {
        const unlockRes = await redis.eval(UNLOCK_SCRIPT, [LOCK_KEY], [lockId]);
        console.log(`[锁释放] ${unlockRes === 1 ? "成功" : "失败"}`);
      } catch (e) {
        console.error("[锁释放失败]", e.message);
      }
    }
    console.log("===== 任务结束 =====");
  }
}

// ========== 全局异常兜底 ==========
let barkSent = false;
async function safeBark(opts) {
  if (barkSent) return;
  barkSent = true;
  try {
    await sendBark(opts);
  } catch (e) {
    console.error("[Bark] 兜底通知失败:", e.message);
  }
}

process.on("uncaughtException", async (err) => {
  console.error("未捕获异常:", err);
  await safeBark({
    title: "💥 TryBox 未捕获异常",
    body: `**错误**: ${err.message}\n\n**项目**: ${APP_PREFIX}`,
    level: "timeSensitive",
  });
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("未处理的 Promise:", reason);
  await safeBark({
    title: "💥 TryBox 未处理 Promise",
    body: `**原因**: ${reason}\n\n**项目**: ${APP_PREFIX}`,
    level: "timeSensitive",
  });
  process.exit(1);
});

process.on("SIGTERM", async () => {
  console.log("收到 SIGTERM");
  await safeBark({
    title: "⚠️ TryBox 被终止",
    body: `进程收到 SIGTERM，可能被取消\n\n**项目**: ${APP_PREFIX}`,
    level: "timeSensitive",
  });
  process.exit(0);
});

// ========== 启动 ==========
main().catch(async (e) => {
  console.error("❌ 全局捕获异常", e.message);
  await safeBark({
    title: "💥 TryBox 脚本全局异常",
    body: `**错误**: ${e.message}\n\n**项目**: ${APP_PREFIX}`,
    level: "timeSensitive",
  });
  process.exit(1);
});