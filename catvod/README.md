更新日志：
11/19 修改 请求路径 hls/clean 为/hls  待验证
`http://localhost:3000/hls/clean?url=`调整为：`http://localhost:3000/hls?url=`


# CatVod Multi-Source Stremio Addon

多源影视聚合 Stremio Addon（技术研究用途）。将国内多家 MacCMS 影视资源站封装为统一接口，支持独立源 catalog、外部 IMDb id 自动匹配拉流、HLS 广告清洗，分片始终直连源站不中转。

> **声明**：本项目仅用于技术研究，不存储任何影视内容。源站、内容、播放地址均来自第三方，使用者需自行承担合规责任。

---

## 目录

- [功能特性](#功能特性)
- [架构概览](#架构概览)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [配置页](#配置页)
- [API 接口](#api-接口)
- [调试接口](#调试接口)
- [HLS 广告清洗](#hls-广告清洗)
- [三层降级策略](#三层降级策略)
- [新增源](#新增源)
- [广告规则维护](#广告规则维护)
- [部署](#部署)
- [常见问题](#常见问题)

---

## 功能特性

### 两条独立业务通路

**通路 1 · 用户搜索/浏览**
每个源独立 catalog，独立 meta，不合并不同源结果。用户在 Stremio 的 catalog 里搜索时，请求直接分发到对应源的原生搜索接口。

**通路 2 · 外部 IMDb id 拉流**
接收其他 Addon（如 Cinemeta）的 stream 请求，通过 TMDB 标准化元数据（中文名、别名、年份、季集）→ 多源并行搜索 → 匹配打分 → 高置信取流。低置信返回空或候选，不强行匹配。

### 核心能力

- **多源聚合**：当前支持暴风（bfzy）、非凡（ffzy）、量子（lz）
- **HLS 广告清洗**：按源分组正则剔除广告片段，只改清单不中转分片
- **master playlist 递归**：master 子清单入口指向本服务 `/hls`，保留 `sign` 等 query
- **风险检测降级**：片段减少 > 30% 判定高风险，原样返回原始清单
- **三层拉取降级**：直连 → 代理 → 307 重定向到原始 URL
- **双层缓存**：L1 内存 + L2 Upstash Redis，Redis 抖动自动冷却降级
- **匹配打分器**：标题相似度 + 年份 + 类型 + 季集 + 别名加分，阈值 0.85/0.60
- **完整调试体系**：`/debug/match` / `/debug/hls-clean` / `/debug/sources` / `/debug/cache` / `/debug/reload-rules`
- **用户自定义配置**：URL 参数 `?cfg=base64url` 控制启用源、线路黑名单、自定义 TMDB Key

---

## 架构概览

```
┌──────────────────────────────────────────────────┐
│                  Stremio 客户端                   │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│  协议层  src/addon/                              │
│  manifest · catalog · meta · stream              │
├──────────────────────────────────────────────────┤
│  业务层                                          │
│  metadata/  TMDB 元数据 + 匹配打分                │
│  sources/   源适配器 + share 解析 + 缓存包装       │
│  hls/       清单清洗 + master 递归                │
├──────────────────────────────────────────────────┤
│  基础设施层                                       │
│  cache/     L1 内存 + L2 Redis + 冷却降级         │
│  logger.js  分级日志 + traceId                   │
│  utils/     HTTP 超时重试 + 追踪上下文             │
└──────────────────────────────────────────────────┘
```

### 播放链路

```
播放器
  → GET /hls?url=<源站m3u8>&src=bfzy
      ├─ 1. 直连源站拉清单（首选）
      ├─ 2. 直连失败 → 走代理拉清单（MANIFEST_PROXY_URL）
      ├─ 3. 代理也失败 → 307 重定向到原始 URL
      ├─ 4. 清洗（按源正则剔除广告）
      ├─ 5. 分片 URL 绝对化
      └─ 6. 返回清洗后清单
  → 播放器直连源站分片（不经过本服务）
```

---

## 目录结构

```
catvod/
├── server.js                   # Vercel 入口（直接 import express）
├── vercel.json                 # 部署配置
├── package.json
├── .env.example                # 环境变量模板
├── config/
│   ├── sources.json            # 源配置（URL / UA / 线路模式 / 广告组）
│   └── adRules.json            # 广告清洗规则库
├── public/
│   ├── configure.html          # 配置页
│   ├── configure.css
│   └── configure.js
├── src/
│   ├── createApp.js            # Express 工厂
│   ├── localServer.js          # 本地开发入口
│   ├── logger.js               # 分级日志 + traceId
│   ├── addon/                  # Stremio 协议层
│   ├── sources/                # 源适配器
│   │   ├── maccmsBase.js       # MacCMS 通用解析
│   │   ├── shareResolver.js    # share 页面 → m3u8
│   │   ├── cached.js           # search/detail 缓存
│   │   ├── registry.js
│   │   └── adapters/
│   ├── metadata/               # 元数据与匹配
│   │   ├── tmdb.js
│   │   ├── matcher.js
│   │   └── normalizeTitle.js
│   ├── hls/                    # HLS 清洗
│   │   ├── cleaner.js
│   │   ├── master.js
│   │   ├── fetchManifest.js    # 三层降级拉取
│   │   └── rules.js
│   ├── cache/                  # L1 + L2
│   ├── config/
│   │   └── loadConfig.js
│   ├── routes/
│   │   ├── hls.js
│   │   └── debug.js
│   └── utils/
├── scripts/
│   ├── health.js               # 全量健康检查
│   ├── regression-test.js      # 回归测试
│   ├── probe.js                # 源探针
│   ├── probe-share.js          # share 页探针
│   ├── test-hls.js
│   └── test-matcher.js
└── docs/
    ├── DEVELOPMENT.md          # 开发文档
    └── TROUBLESHOOT.md         # 故障排查
```

---

## 快速开始

### 前置依赖

- Node.js ≥ 18（内置 fetch）
- TMDB API Key（https://www.themoviedb.org/settings/api）
- Upstash Redis（可选，https://console.upstash.com/，免费 500K commands/月）

### 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，填入：
#   APP_PREFIX=catvod:dev
#   TMDB_API_KEY=<你的 key>
#   UPSTASH_REDIS_REST_URL=<可选>
#   UPSTASH_REDIS_REST_TOKEN=<可选>
#   ADDON_BASE_URL=http://127.0.0.1:3000

# 3. 启动（推荐：贴近线上环境）
npx vercel dev
# 或：本地 node 直接跑（/configure 静态页不可用）
PORT=3000 node --env-file=.env.local src/localServer.js

# 4. 访问
open http://127.0.0.1:3000/configure    # 配置页
open http://127.0.0.1:3000/health       # 健康检查
```

### 在 Stremio 中安装

1. 打开 Stremio → Addons
2. 搜索框输入：`http://127.0.0.1:3000/manifest.json`
3. 点击 Install

或通过配置页生成带 `?cfg=` 的定制链接。

### 验证

```bash
# 全量健康检查
node scripts/health.js http://127.0.0.1:3000 -v

# 回归测试
node scripts/regression-test.js http://127.0.0.1:3000 -v
```

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `7100` | 本地端口（Vercel 平台自动注入） |
| `APP_PREFIX` | **是** | — | Redis key 前缀，如 `catvod:prod` |
| `TMDB_API_KEY` | 推荐 | — | TMDB v3 API Key，不配则 imdbid 通路返回空 |
| `TMDB_BASE_URL` | 否 | `https://api.themoviedb.org` | TMDB 反代地址（本地网络差时配） |
| `UPSTASH_REDIS_REST_URL` | 否 | — | Upstash REST URL，不配则降级内存 |
| `UPSTASH_REDIS_REST_TOKEN` | 否 | — | Upstash REST Token |
| `ADDON_BASE_URL` | **Vercel 必填** | — | 如 `https://your-app.vercel.app`，拼接 `/hls` 入口 |
| `MANIFEST_PROXY_URL` | 推荐 | — | 清单代理地址，如 `https://hls.wangqifei.eu.org`，解决出站 IP 被屏蔽 |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_JSON` | 否 | `false` | `true` 时输出结构化 JSON（生产推荐） |
| `AD_RULES_PATH` | 否 | `config/adRules.json` | 广告规则文件路径 |
| `SOURCES_CONFIG_PATH` | 否 | `config/sources.json` | 源配置文件路径 |

---

## 配置页

访问 `https://your-app.vercel.app/configure`，可自定义：

- **启用源**：默认全开，可勾选关闭部分源
- **线路黑名单**：每行一个关键词，命中则过滤该线路（如 `lzm3u8`）
- **自定义 TMDB Key**：优先于环境变量

生成带 `?cfg=base64url` 的安装链接，Stremio 会保留该参数，后续所有请求生效。

---

## API 接口

### Stremio 协议

| 路径 | 说明 |
|---|---|
| `GET /manifest.json` | Addon manifest，支持 `?cfg=` 定制 |
| `GET /catalog/:type/:id.json` | catalog 浏览 + 搜索（`extra.search`） |
| `GET /meta/:type/:id.json` | 内部 id 或 IMDb id 的 meta |
| `GET /stream/:type/:id.json` | 内部 id 或 IMDb id 的流列表 |

### 流与健康

| 路径 | 说明 |
|---|---|
| `GET /hls?url=<encoded>&src=<id>` | HLS 清洗入口（播放器直接请求） |
| `GET /health` | 健康检查 |
| `GET /configure` | 配置页（HTML） |

---

## 调试接口

| 路径 | 用途 |
|---|---|
| `GET /debug/sources?keyword=<kw>` | 各源健康检测（并发搜索） |
| `GET /debug/match?imdbid=&type=&season=` | 完整匹配链路：TMDB + 各源候选 + 每候选打分明细 |
| `GET /debug/hls-clean?url=&src=` | HLS 清洗预览：原始 / 命中规则 / 清洗后 / `fetchAttempts` |
| `POST /debug/reload-rules` | 热重载广告规则 |
| `GET /debug/cache` | 缓存后端状态 |

### 常用调试命令

```bash
# 匹配链路（看某 imdbid 在各源的候选和分数）
curl -s "http://127.0.0.1:3000/debug/match?imdbid=tt0111161&type=movie" | jq

# HLS 清洗预览
curl -s "http://127.0.0.1:3000/debug/hls-clean?url=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' '<m3u8-url>')&src=bfzy" | jq '{
  type, risk, degraded, reason,
  originalLength, cleanedLength,
  hits,
  fetchAttempts: [.fetchAttempts[] | {stage, viaProxy, status: .response.status}]
}'

# 源健康
curl -s "http://127.0.0.1:3000/debug/sources" | jq '.sources'

# 热重载规则
curl -X POST "http://127.0.0.1:3000/debug/reload-rules"
```

---

## HLS 广告清洗

### 清洗流程

```
拉取清单 → 判断 master/media
  ├─ master：改写子清单为 /hls 入口（保留 sign）
  └─ media：
      ├─ 按源正则剔除广告片段
      ├─ 全局广告域名黑名单剔除
      └─ 分片 URL 绝对化
→ 风险检测（片段减少 > 30% → 原样返回）
→ 返回清单
```

### 规则编译

`config/adRules.json` 的 `regex` 数组支持三种写法：

| 输入示例 | 编译为 | 说明 |
|---|---|---|
| `"17.19"` | `#EXTINF:?17\.19...` | 匹配该时长的片段整段删 |
| `"#EXT-X-DISCONTINUITY..."` | 原样正则 | 完整正则 |
| `"更多"` | 命中 `#EXTINF` 行含该词则删片段 | 纯字面量 |

### 风险阈值

`src/hls/cleaner.js`：

```javascript
export const DEFAULT_HLS_CONFIG = {
  maxReduction: 0.3,   // 片段减少 > 30% → 降级返回原始
  maxHits: 50,         // 命中 > 50 条 → 中风险
  enableAdDomains: true,
};
```

---

## 三层降级策略

`src/hls/fetchManifest.js` 在拉取清单时按以下顺序降级：

```
1. 直连源站（首选）
      ↓ 失败（404/timeout/非 m3u8）
2. 代理（MANIFEST_PROXY_URL 配置时）
      ↓ 失败
3. 307 重定向到原始 URL（由 /hls 路由层执行）
```

**原因**：部分源站屏蔽数据中心 IP 段（Vercel、Cloudflare Worker 等），需通过代理绕过。但并非所有源都被屏蔽（如 ffzy/lz 直连可用），因此**直连优先，避免代理成为不必要的中转**。

**`fetchAttempts` 记录**：每次尝试的 request headers、response status/headers/bodyHead 都返回给 `/debug/hls-clean`，可判断失败是 IP 屏蔽、UA/Referer 缺失还是网络层拦截。

---

## 新增源

### 步骤 1：`config/sources.json` 添加配置

```json
{
  "id": "newsrc",
  "label": "新源",
  "enabled": true,
  "baseUrl": "https://api.newsrc.com/api.php/provide/vod",
  "referer": "https://api.newsrc.com/",
  "timeoutMs": 8000,
  "retries": 1,
  "lines": {
    "newm3u8": { "mode": "direct" },
    "newshare": { "mode": "share" }
  },
  "adRuleGroup": "新源"
}
```

- `lines[].mode`：`direct`（直链 m3u8）或 `share`（`/share/xxx` 页面需二次解析）
- `adRuleGroup`：对应 `adRules.json` 的 `rules[].name`

### 步骤 2：新建 adapter

`src/sources/adapters/newsrc.js`：

```javascript
import { maccmsSearch, maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../maccmsBase.js";
import { resolveShare } from "../shareResolver.js";

export const newsrc = {
  id: "newsrc",
  label: "新源",
  capabilities: { search: true, detail: true, shareResolve: true },
  async search(cfg, keyword) { return maccmsSearch(cfg, keyword); },
  async resolveStream(cfg, vodId, { episode } = {}) {
    // 参考 bfzy.js / ffzy.js
  },
};
```

### 步骤 3：注册

`src/sources/registry.js`：

```javascript
import { newsrc } from "./adapters/newsrc.js";
const ADAPTERS = { bfzy, ffzy, lz, newsrc };
```

### 步骤 4：添加广告规则

`config/adRules.json` 的 `rules` 数组追加：

```json
{
  "name": "新源",
  "hosts": ["newsrc", "newsrccdn"],
  "regex": ["#EXTINF.*?\\s+.*?ad.*?\\.ts"]
}
```

### 步骤 5：验证

```bash
curl -s "http://127.0.0.1:3000/debug/sources" | jq '.sources[] | select(.id=="newsrc")'
curl -s "http://127.0.0.1:3000/catalog/series/newsrc-series/search=庆余年.json" | jq '.metas | length'
node scripts/health.js -v
```

更详细的接入指南见 `docs/DEVELOPMENT.md`。

---

## 广告规则维护

### 调试流程

1. 用 `/debug/hls-clean` 观察当前源的广告特征
2. 在 `config/adRules.json` 对应组里新增正则
3. `POST /debug/reload-rules` 热重载
4. 再用 `/debug/hls-clean` 验证清洗比例（片段不应减少超过 30%）

### 常用正则模式

| 广告特征 | 正则 |
|---|---|
| 固定时长的独立片段 | `#EXT-X-DISCONTINUITY\r*\n*#EXTINF:3\.[\s\S]*?#EXT-X-DISCONTINUITY` |
| 特定文件名 | `#EXTINF.*?\s+.*?adjump.*?\.ts` |
| 纯时长 | 直接写 `"17.19"` |

### 规则冲突排查

`/debug/hls-clean` 的 `hits` 字段显示每条规则分别删了多少片段，优先保留覆盖更广的，删掉重叠的。

---

## 部署

### Vercel

详见 `docs/DEPLOY.md`，要点：

1. `server.js` 在项目根目录，**直接 `import express`**（Vercel 通过这个识别 Express 应用）
2. `vercel.json` 只保留 `functions.includeFiles`，不要用 `rewrites` 转发到 `api/`
3. `api/` 目录不存在（避免零配置冲突）
4. 环境变量至少配：`APP_PREFIX`、`TMDB_API_KEY`、`ADDON_BASE_URL`、`MANIFEST_PROXY_URL`（推荐）

```json
// vercel.json
{
  "functions": {
    "server.js": {
      "includeFiles": "config/**,public/**"
    }
  }
}
```

### 安装到 Stremio

1. 访问 `https://your-app.vercel.app/configure`
2. 调整配置 → 复制安装链接
3. Stremio → Addons → Community → 粘贴链接

---

## 常见问题

### Q1：`/configure` 返回 404 或 502

**原因**：`server.js` 没直接 `import express`，或 `vercel.json` 用了错误的 `rewrites`。

**修复**：按「部署」一节的 `vercel.json` 配置，`rm -rf .vercel && npx vercel dev` 重新启动。

### Q2：`/stream` 返回空

**排查**：
1. `/debug/match?imdbid=...` 看 TMDB 元数据是否正常
2. `meta: null` → TMDB 网络不通或 key 无效
3. `candidates` 里各源 `ranked` 都低分 → 源里没这部片
4. 某源 `error` → 该源失效

### Q3：`/hls` 返回 307

**含义**：直连和代理都拉不到清单，降级到让播放器直连原始 URL。

**排查**：`/debug/hls-clean` 看 `fetchAttempts`：
- 直连 `status: 404` + 代理 `status: 502` → 源站对代理 IP 也屏蔽
- 直连和代理都 `timeout` → 网络层拦截

**修复**：检查代理是否可达；或确认该源是否已对 Vercel 全平台屏蔽（此时该源在线上不可用，需在 `sources.json` 里禁用）。

### Q4：HLS 清洗后视频变短

**原因**：正则删掉了正常片段。

**修复**：`/debug/hls-clean` 看 `hits`，缩小该正则的匹配范围，`POST /debug/reload-rules` 热重载。

### Q5：Redis 频繁 `redis-timeout`

**原因**：本地网络到 Upstash 慢。

**修复**：`src/cache/index.js` 里 `REDIS_TIMEOUT_MS` 从 500 调到 1500。

### Q6：TMDB 一直返回 404

**原因**：`TMDB_BASE_URL` 少了 `/3`。检查 `src/metadata/tmdb.js`：

```javascript
const TMDB_BASE = (process.env.TMDB_BASE_URL || "https://api.themoviedb.org").replace(/\/$/, "") + "/3";
```

---

## 技术栈

- **运行环境**：Node.js 18+（Vercel Serverless Function）
- **Web 框架**：Express 4
- **缓存**：L1 内存 Map + L2 Upstash Redis REST
- **元数据**：TMDB v3 API
- **协议**：Stremio Addon Protocol v3
- **依赖**：`express`（唯一运行时依赖）

---

## 参考

- 开发文档：`docs/DEVELOPMENT.md`
- 故障排查：`docs/TROUBLESHOOT.md`
- 部署指南：`docs/DEPLOY.md`
- Stremio Addon 协议：https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/protocol
- MacCMS 通用接口：`?ac=search&wd=` / `?ac=detail&ids=`

---

## 许可

仅用于技术研究。请遵守源站服务条款及当地法律法规。