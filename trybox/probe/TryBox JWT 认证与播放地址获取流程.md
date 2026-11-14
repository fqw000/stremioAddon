# TryBox JWT 认证与播放地址获取流程

## 1. 概述

TryBox 是一个影视播放站点，前端使用 **React + TanStack Start**，用户认证基于 **Supabase Auth**。获取播放地址的核心接口是一个 **TanStack Start Server Function**，请求头必须携带 **Supabase 签发的 JWT（access_token）**。

整个链路只需要理解三件事：

```
ANON_KEY  →  向 Supabase 换/刷新 access_token  →  拿 access_token 调 TryBox 接口取播放地址
```

本文从三种凭证讲起，逐步梳理到最终的播放地址获取。

---

## 2. 三种关键凭证

TryBox 认证体系涉及三种 key，用途和敏感度完全不同：

| 名称 | 类型 | 用途 | 敏感度 | 有效期 |
|---|---|---|---|---|
| **ANON_KEY** | Supabase 项目密钥 | 标识 Supabase 项目、调用 Auth API | 可公开 | 约到 2036 年 |
| **access_token** | 用户 JWT | 调 TryBox 业务接口 | 不可公开 | 1 小时 |
| **refresh_token** | 刷新令牌 | 换新的 access_token | 不可公开 | 较长（服务端可配置） |

三者关系：

```
ANON_KEY（项目标识）
    │
    │ 用于调用 Supabase Auth
    ▼
refresh_token ──► access_token ──► 调 TryBox Server Function
```

### 2.1 ANON_KEY

Supabase 项目的**匿名公开密钥**，本质是一个 `role: anon` 的 JWT，只用来标识「我是哪个项目」，不含任何用户身份信息。前端必须公开使用它来调用 Auth API，因此它天生就是可公开的。

以 TryBox 为例：

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWNoY3V3emJuY3VxbnFodXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTg4MjUsImV4cCI6MjA5OTk3NDgyNX0.v0KsTzaaiHUTvtA_W-HuAOQul3E7cxnbw4Kiy9hFVus
```

解码 Payload：

```json
{
  "iss": "supabase",
  "ref": "saichcuwzbncuqnqhuul",
  "role": "anon",
  "iat": 1784398825,
  "exp": 2099974825
}
```

- `iss: "supabase"` → 由 Supabase 签发
- `ref: "saichcuwzbncuqnqhuul"` → 项目 ref，对应 `https://saichcuwzbncuqnqhuul.supabase.co`
- `role: "anon"` → 匿名角色，权限受 RLS 约束
- `exp` 到 2036 年 → 基本不会变

**获取方式**（任选一种）：

- **Network 面板**：F12 → 过滤 `supabase.co` → 看任意请求的 `apikey` 头
- **Sources 面板**：全局搜 `role":"anon` 或 `saichcuwzbncuqnqhuul`，能找到前端硬编码的字符串
- **Supabase Dashboard**：项目设置 → API → `anon public`

### 2.2 access_token

Supabase 签发的用户 JWT，`role: authenticated`，包含用户身份信息（`sub`、`email`、`session_id` 等）。**每次调用 TryBox 业务接口都要带在 `Authorization: Bearer` 头里**，1 小时后过期。

### 2.3 refresh_token

换新 access_token 用的一次性凭证。用一次旧值立即失效，响应里给一个新的（Refresh Token Rotation）。**这是它最需要小心的一点**——脚本或浏览器必须同步保存新值。

### 2.4 三者对比

| 对比项 | ANON_KEY | access_token |
|---|---|---|
| `iss` | `supabase` | `https://xxx.supabase.co/auth/v1` |
| `role` | `anon` | `authenticated` |
| 算法 | HS256 | ES256 |
| 有效期 | ~2036 年 | 1 小时 |
| 是否含用户信息 | ❌ | ✅ |
| 用途 | 标识项目 | 标识用户会话 |
| 能否公开 | ✅ | ❌ |

**最容易踩的坑**：把 `access_token` 填到 `apikey` 头里，会得到：

```json
{"message":"Invalid API key","hint":"Double check your Supabase `anon` or `service_role` API key."}
```

---

## 3. 认证流程

```
用户浏览器 / 客户端
        │
        │ 1. OTP 登录（携带 ANON_KEY）
        ▼
Supabase Auth (https://<project>.supabase.co/auth/v1)
        │
        │ 2. 返回 access_token + refresh_token
        ▼
客户端保存 session（localStorage）
        │
        │ 3. 请求 TryBox Server Function
        │    Authorization: Bearer <access_token>
        ▼
TryBox 服务端
        │
        │ 4. 用 Supabase 公钥验证 JWT
        ▼
返回播放地址（JSON）
```

### 3.1 登录（邮箱 OTP）

**发送 OTP**：

```http
POST https://<project>.supabase.co/auth/v1/otp
apikey: <ANON_KEY>
Content-Type: application/json

{ "email": "user@example.com", "create_user": true }
```

**验证 OTP**：

```http
POST https://<project>.supabase.co/auth/v1/verify
apikey: <ANON_KEY>
Content-Type: application/json

{ "type": "email", "email": "user@example.com", "token": "123456" }
```

返回：

```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIs...",
  "token_type": "bearer",
  "expires_in": 3600,
  "refresh_token": "v1.Mr...",
  "user": { ... }
}
```

### 3.2 客户端存储

`supabase-js` 默认把 session 存在 `localStorage`，键名格式：

```
sb-<project-ref>-auth-token
```

TryBox 对应 `sb-saichcuwzbncuqnqhuul-auth-token`。

### 3.3 刷新 token

```http
POST https://<project>.supabase.co/auth/v1/token?grant_type=refresh_token
apikey: <ANON_KEY>
Content-Type: application/json

{ "refresh_token": "v1.Mr..." }
```

返回新的 `access_token`，**同时返回一个新的 `refresh_token`**（rotation 默认开启）。旧的 `refresh_token` 立即作废。

> **这就是「脚本和浏览器不能共用同一个 refresh_token」的根本原因**——用一次就废，两边互相踢。

### 3.4 JWT 结构

`access_token` 是标准 JWT：

```json
{
  "iss": "https://saichcuwzbncuqnqhuul.supabase.co/auth/v1",
  "sub": "b5640d62-f7a3-4d2a-b520-dbf28ec417b0",
  "aud": "authenticated",
  "exp": 1791710467,
  "iat": 1791706867,
  "email": "user@example.com",
  "role": "authenticated",
  "aal": "aal1",
  "amr": [{ "method": "otp", "timestamp": 1791694481 }],
  "session_id": "f97b4fb4-4fa0-4546-ac47-657e534fae5c",
  "is_anonymous": false
}
```

| 字段 | 含义 | 是否变动 |
|---|---|---|
| `sub` | 用户 UUID | 固定 |
| `exp` / `iat` | 过期/签发时间 | 每次刷新变 |
| `amr` | 认证方法记录 | 重新登录变 |
| `session_id` | 会话 ID | 重新登录变 |

**解码不等于验证**。解码只需 Base64URL，但验证签名要 Supabase 的公钥（JWKS）。

```javascript
function decodeJwt(token) {
  const [header, payload, signature] = token.split('.');
  const decode = (str) =>
    JSON.parse(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  return { header: decode(header), payload: decode(payload), signature };
}
```

---

## 4. 调 Server Function 获取播放地址

```http
POST https://trybox.app/_serverFn/5a020077e9367d29abeab1946108104517a066628ad6d94609eea11918105012
Authorization: Bearer <access_token>
Content-Type: application/json
x-trybox-lang: zh-CN
Origin: https://trybox.app
Referer: https://trybox.app/
```

### 4.1 请求体

TanStack Start 序列化格式。`t` 表示值类型：`0` 数字，`1` 字符串，`10` 对象。

**电影**：

```json
{
  "t": {
    "t": 10, "i": 0,
    "p": {
      "k": ["data"],
      "v": [{
        "t": 10, "i": 1,
        "p": {
          "k": ["tmdb_id", "kind"],
          "v": [
            { "t": 0, "s": 687163 },
            { "t": 1, "s": "movie" }
          ]
        },
        "o": 0
      }]
    },
    "o": 0
  },
  "f": 127,
  "m": []
}
```

**电视剧**：`kind: "tv"` 时还需 `season` 和 `episode`：

```json
"k": ["tmdb_id", "kind", "season", "episode"],
"v": [
  { "t": 0, "s": 299167 },
  { "t": 1, "s": "tv" },
  { "t": 0, "s": 1 },
  { "t": 0, "s": 5 }
]
```

外层 `f: 127` 和 `m: []` 是固定字段。

### 4.2 响应解析

响应也是 TanStack Start 序列化格式，需用 `seroval` 反序列化：

```javascript
const { fromCrossJSON } = require('seroval');
const { defaultSerovalPlugins } = require('@tanstack/router-core');

const parsed = fromCrossJSON(JSON.parse(rawText), {
  plugins: defaultSerovalPlugins,
});
```

解析后的结构：

```json
{
  "result": {
    "meta": {
      "title": "Project Hail Mary",
      "year": "2026",
      "imdb_id": "tt12042730"
    },
    "mbp_links": [
      {
        "quality": "4K",
        "url": "https://hls.shegu.net/38302246.m3u8?quality=4K&sign=...",
        "size": "29.17 GB",
        "group": "MovieBox",
        "file_id": "2368310",
        "vip_locked": false
      }
    ],
    "links": [],
    "beta_links": [],
    "cache_hit": false
  },
  "error": null,
  "context": {}
}
```

**关键点**：
- 播放链接主要在 **`result.mbp_links`**（`mbp` 推测为 MovieBox 缩写），`links` 和 `beta_links` 一般是空的但需兼容
- `meta` 在 `result.meta` 下，不在顶层

---

## 5. 播放链接特性

- **协议**：多为 HLS（`.m3u8`），少数原始文件（`.mkv` / `.mp4`）
- **质量**：`4K`、`1080P`、`720P`、`360P`、`AUTO`、`ORG`
- **URL 参数**：
  - `sign`：签名，防篡改
  - `t`：生成时间戳（Unix 秒）
  - `KEY2`：过期时间戳，通常是 `t + 7200`（**2 小时有效期**）
  - `IP`：请求方出口 IP，被编进签名
- **IP 绑定**：换网络后同一 URL 可能失效
- **建议**：每次播放前重新请求，不要长期缓存链接

---

## 6. 完整示例

```javascript
// 1. 用 refresh_token 换 access_token（携带 ANON_KEY）
const tokenRes = await fetch(
  `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY,          // ← 这里用 ANON_KEY
    },
    body: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
  }
);
const { access_token } = await tokenRes.json();

// 2. 构造请求体
const body = buildRequestBody({ tmdbId: 687163, kind: 'movie' });

// 3. 请求 Server Function（携带 access_token）
const res = await fetch(SERVER_FN, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${access_token}`,  // ← 这里用 access_token
    'Content-Type': 'application/json',
    'x-trybox-lang': 'zh-CN',
    'User-Agent': 'Mozilla/5.0 ...',
    Origin: 'https://trybox.app',
    Referer: 'https://trybox.app/',
  },
  body: JSON.stringify(body),
});

// 4. 解析响应
const raw = await res.text();
const parsed = fromCrossJSON(JSON.parse(raw), {
  plugins: defaultSerovalPlugins,
});

// 5. 提取播放链接
const links = parsed.result.mbp_links || [];
console.log(links.map((l) => `${l.quality}: ${l.url}`));
```

---

## 7. 常见错误

| 现象 | 原因 | 解决 |
|---|---|---|
| `Invalid API key` | 把 access_token 当 ANON_KEY 填到 `apikey` 头 | 用 `role: anon` 的那个 JWT |
| `401 Unauthorized` | access_token 过期或无效 | 用 refresh_token 换新的 |
| `Cannot convert argument to a ByteString` | header 里混入中文（如 `'你的_ANON_KEY'`） | 检查 header 值全是 ASCII |
| 响应解析为空 | 取的是 `result.links`，实际在 `result.mbp_links` | 同时兼容三个字段 |
| `refresh_token_already_used` | refresh_token 被用过一次 | 从浏览器重新拿一个新的，或滚动保存新值 |

---

## 8. 安全提醒

- `access_token` 和 `refresh_token` 是敏感凭证，**切勿泄露或提交到公开仓库**
- `ANON_KEY` 可公开，但只能标识项目，不能冒充用户
- 播放链接带签名和 2 小时时效，请勿传播或长期保存
- 本文仅用于技术研究与合法调试自己的账号，请遵守 TryBox 服务条款及当地法律法规

---

## 9. 参考

- Supabase Auth：https://supabase.com/docs/guides/auth
- Supabase API Keys：https://supabase.com/docs/guides/api/api-keys
- TanStack Start Server Functions：https://tanstack.com/start
- Seroval：https://github.com/lxsmnsyc/seroval
- Cloudflare Turnstile（登录可能遇到）：https://developers.cloudflare.com/turnstile/