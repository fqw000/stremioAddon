# CatVod Stremio Addon · 完整开发文档

> 版本：v1.0.0
> 定位：多源影视聚合 Stremio Addon（技术研究用途）
> 面向：项目维护者、新源接入开发者、二次功能开发者
>
> 完整文档地址：`docs/DEVELOPMENT.md`

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构设计](#2-架构设计)
3. [目录结构](#3-目录结构)
4. [环境变量与配置](#4-环境变量与配置)
5. [两条业务通路详解](#5-两条业务通路详解)
6. [Stremio 协议层](#6-stremio-协议层)
7. [源适配器机制（重点）](#7-源适配器机制重点)
8. [元数据与匹配引擎](#8-元数据与匹配引擎)
9. [HLS 广告清洗](#9-hls-广告清洗)
10. [缓存体系](#10-缓存体系)
11. [日志与调试系统](#11-日志与调试系统)
12. [新增一个源：完整指南](#12-新增一个源完整指南)
13. [广告规则维护指南](#13-广告规则维护指南)
14. [配置页与 URL 参数](#14-配置页与-url-参数)
15. [部署指南](#15-部署指南)
16. [常见问题 FAQ](#16-常见问题-faq)
17. [性能优化建议](#17-性能优化建议)

---

## 1. 项目概览

### 1.1 项目目标

将一批国内影视资源站（MacCMS 类）封装为**标准 Stremio Addon**，实现：

- **独立源 catalog**：每个源独立展示、独立搜索，不合并不同源结果
- **外部 imdbid 拉流**：接收其他 Addon（如 Cinemeta）的 meta 请求，通过 TMDB 标准化 → 多源搜索 → 匹配打分 → 高置信取流
- **HLS 清单清洗**：剔除源站插播广告，**只清洗清单，不中转分片**

### 1.2 当前支持的源

| ID | 名称 | 状态 | 说明 |
|---|---|---|---|
| `bfzy` | 暴风 | ✅ 完整 | MacCMS 标准，直链 m3u8 |
| `ffzy` | 非凡 | ✅ 完整 | MacCMS 标准，双线路（`feifan` share / `ffm3u8` 直链） |
| `lz` | 量子 | ✅ 完整 | MacCMS 标准，双线路（`liangzi` share / `lzm3u8` 直链） |

### 1.3 硬性约束（不可违反）

| 约束 | 说明 |
|---|---|
| 不合并不同源 meta | 每个源独立 catalog / meta，stream 多源结果逐条返回 |
| 不中转分片 | `/hls/clean` 只改写 m3u8 清单，分片 URL 一律转为**绝对原始地址**，播放器直连源站 |
| ijk 不进返回流 | `config/adRules.json` 的 `ijk` 段仅文档参考，任何运行路径不得读取 |
| 低置信不强行透传 | score < 0.60 返回空，0.60–0.85 返回候选列表（给用户选择） |
| 不编造接口 | 所有源必须有明确的 API 依据；未验证的源为占位适配器 |

---

## 2. 架构设计

### 2.1 分层架构

```
┌──────────────────────────────────────────────────────┐
│                 Stremio 客户端                        │
└─────────────────┬────────────────────────────────────┘
                  │ HTTP
┌─────────────────▼────────────────────────────────────┐
│  协议层  addon/（manifest / catalog / meta / stream） │
├──────────────────────────────────────────────────────┤
│  业务层                                              │
│  ├─ metadata/   TMDB 元数据 + 匹配打分                │
│  ├─ sources/    源适配器 + share 解析 + 缓存包装      │
│  └─ hls/        清单清洗 + master 递归                │
├──────────────────────────────────────────────────────┤
│  基础设施层                                          │
│  ├─ cache/      L1 内存 + L2 Redis + 冷却降级         │
│  ├─ logger.js   分级日志 + traceId                    │
│  └─ utils/      HTTP 超时重试 + 追踪上下文            │
└──────────────────────────────────────────────────────┘
```

### 2.2 关键设计原则

1. **配置驱动**：源地址、UA、Referer、线路模式、广告分组全部在 `config/*.json` 中，新增源**零代码**或只加一个 adapter 文件
2. **故障隔离**：`Promise.allSettled` 并行搜索，单源超时不影响其他源
3. **优雅降级**：Redis 抖动降级为内存、清洗过度降级为原清单、share 解析失败降级为原链接
4. **可观测性**：每条请求带 `traceId`，结构化日志可 grep

---

## 3. 目录结构

```
catvod/
├── server.js                       # Vercel 入口（必须直接 import express）
├── vercel.json                     # Vercel 构建配置
├── package.json
├── .env.example                    # 环境变量模板
├── config/
│   ├── sources.json                # 源清单（baseUrl / UA / 线路模式 / 广告组）
│   └── adRules.json                # 广告规则库（按源分组）
├── public/
│   ├── configure.html              # 用户配置页
│   ├── configure.css
│   └── configure.js
├── src/
│   ├── createApp.js                # Express app 工厂（Vercel 与本地共用）
│   ├── localServer.js              # 本地 node 启动入口（可选）
│   ├── logger.js                   # 分级日志 + traceId
│   ├── addon/                      # Stremio 协议层
│   │   ├── manifest.js
│   │   ├── catalog.js
│   │   ├── meta.js
│   │   └── stream.js
│   ├── sources/                    # 源适配器层
│   │   ├── maccmsBase.js           # MacCMS 通用解析
│   │   ├── shareResolver.js        # share 页面 → m3u8
│   │   ├── cached.js               # search/detail 缓存包装
│   │   ├── registry.js             # 适配器注册表
│   │   └── adapters/
│   │       ├── bfzy.js
│   │       ├── ffzy.js
│   │       └── lz.js
│   ├── metadata/                   # 元数据与匹配
│   │   ├── tmdb.js
│   │   ├── matcher.js
│   │   └── normalizeTitle.js
│   ├── hls/                        # HLS 清洗
│   │   ├── cleaner.js
│   │   ├── master.js
│   │   ├── fetchManifest.js
│   │   └── rules.js
│   ├── cache/                      # L1 + L2 缓存
│   │   ├── index.js
│   │   ├── memory.js
│   │   ├── upstash.js
│   │   └── ttl.js
│   ├── config/
│   │   └── loadConfig.js           # sources.json 加载 + 用户覆盖
│   ├── routes/
│   │   ├── hls.js                  # /hls/clean + /debug/hls-clean
│   │   └── debug.js                # /debug/match /sources /cache /reload-rules
│   └── utils/
│       ├── http.js                 # fetchWithRetry
│       └── traceId.js              # AsyncLocalStorage 追踪上下文
├── scripts/
│   ├── health.js                   # 全量健康检查
│   ├── regression-test.js          # 回归测试
│   ├── probe.js                    # 源探针
│   ├── probe-share.js              # share 页面探针
│   ├── test-hls.js                 # HLS 清洗测试
│   └── test-matcher.js             # 匹配打分测试
└── docs/
    ├── DEVELOPMENT.md              # 本文档
    ├── DEPLOY.md                   # 部署指南
    └── TROUBLESHOOT.md             # 故障排查
```

---

## 4. 环境变量与配置

### 4.1 环境变量（`.env.local` 或 Vercel Project Settings）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `7100` | 本地端口（Vercel 平台自动注入） |
| `APP_PREFIX` | **是** | — | Redis 前缀，如 `catvod:prod`（多项目共用 Upstash 时必须唯一） |
| `TMDB_API_KEY` | 推荐 | — | TMDB v3 API Key，不配则 imdbid 通路返回空 |
| `TMDB_BASE_URL` | 否 | `https://api.themoviedb.org` | TMDB 反代地址（本地网络差时配） |
| `UPSTASH_REDIS_REST_URL` | 否 | — | Upstash REST URL，不配则降级内存 |
| `UPSTASH_REDIS_REST_TOKEN` | 否 | — | Upstash REST Token |
| `ADDON_BASE_URL` | **Vercel 必填** | — | 如 `https://xxx.vercel.app`，拼接 `/hls/clean` 入口 |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_JSON` | 否 | `false` | `true` 时输出结构化 JSON（生产推荐） |
| `AD_RULES_PATH` | 否 | `config/adRules.json` | 广告规则文件路径 |
| `SOURCES_CONFIG_PATH` | 否 | `config/sources.json` | 源配置文件路径 |

### 4.2 `config/sources.json` 结构

```json
{
  "ua": "Mozilla/5.0 ...",
  "sources": [
    {
      "id": "bfzy",
      "label": "暴风",
      "enabled": true,
      "baseUrl": "https://bfzyapi.com/api.php/provide/vod",
      "referer": "https://bfzyapi.com/",
      "timeoutMs": 8000,
      "retries": 1,
      "lines": {
        "bfzym3u8": { "mode": "direct" }
      },
      "adRuleGroup": "暴风"
    }
  ]
}
```

**字段说明**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一标识，用于内部 id 前缀（如 `bfzy:movie:123`）和缓存 key |
| `label` | 是 | 展示名 |
| `enabled` | 是 | 是否启用；可被环境变量 `<ID>_ENABLED` 或 URL `cfg.sources` 覆盖 |
| `baseUrl` | 是 | MacCMS 搜索/详情接口；可被 `<ID>_BASE_URL` 覆盖 |
| `referer` | 是 | HTTP Referer 头（部分源有防盗链） |
| `timeoutMs` | 是 | 单请求超时（毫秒） |
| `retries` | 是 | 失败重试次数 |
| `lines` | 是 | 播放线路 → 模式映射（见下） |
| `adRuleGroup` | 建议 | 对应 `adRules.json` 的 `rules[].name`；不配走 host 匹配 fallback |

**线路模式（`lines[].mode`）**：

| 模式 | 说明 |
|---|---|
| `direct` | URL 是直链 m3u8（直接进 `/hls/clean`） |
| `share` | URL 是 `/share/xxx` 页面，需要 `shareResolver` 二次解析 |

### 4.3 `config/adRules.json` 结构

```json
{
  "rules": [
    {
      "name": "暴风",
      "hosts": ["bfzy", "bfbfvip", "bfengbf"],
      "regex": ["#EXTINF.*?\\s+.*?adjump.*?\\.ts"]
    }
  ],
  "ads": ["mimg.0c1q0l.cn", "cnzz.mmstat.com", "..."],
  "ijk": [{ "group": "软解码", "options": [] }]
}
```

**说明**：
- `rules[].name`：组名，与 `sources.json` 的 `adRuleGroup` 匹配
- `rules[].hosts`：fallback host 匹配（含 `/` 时按 host+path 前缀）
- `rules[].regex`：清洗正则数组，三条编译规则见 [第13章](#13-广告规则维护指南)
- `ads`：全局广告域名黑名单（只删含这些域名的片段/标签行）
- `ijk`：**仅文档参考，运行时任何路径不读取**

---

## 5. 两条业务通路详解

### 5.1 通路 1：用户搜索 / 浏览

```
Stremio UI
  └─ 用户在 "暴风 · 电影" catalog 内输入 "庆余年"
       └─ GET /catalog/movie/bfzy-movie/search=庆余年.json
            └─ handleCatalog
                 ├─ parseCatalogId("bfzy-movie") → { srcId: "bfzy", type: "movie" }
                 ├─ registry.get("bfzy").adapter.search(cfg, "庆余年")
                 │    └─ maccmsSearch → GET {baseUrl}/?ac=search&wd=庆余年
                 └─ 按 type_name 过滤 → 返回 { metas: [...] }
```

**关键点**：
- 每个源的 catalog 独立
- `extra.search` 由 manifest 里 `catalogs[].extra` 声明
- 不做"热门浏览"（源不提供稳定热门接口）

### 5.2 通路 2：外部 imdbid 拉流

```
Stremio UI（Cinemeta 的影片页）
  └─ 用户点击某一集
       └─ GET /stream/series/tt1234567:2:5.json
            └─ handleStream → parseStreamId → { baseId: "tt1234567", season: 2, episode: 5 }
                 └─ streamFromImdb
                      ├─ 1. resolveByImdb(tt1234567, "series", season=2)
                      │     └─ TMDB /find/{imdb_id} + /alternative_titles
                      ├─ 2. 三源并行 cachedSearch(meta.name)
                      ├─ 3. rankCandidates（打分）
                      ├─ 4. 高置信（≥0.85）→ cachedDetail → resolveOneSource
                      │     ├─ direct 线路 → 直接返回
                      │     └─ share 线路 → resolveShare → 真实 m3u8
                      └─ 5. 返回 streams
                           [{ name: "暴风｜bfzym3u8",
                              url: "https://your-app/hls/clean?url=...&src=bfzy" }]
```

**关键点**：
- 低置信候选**记录到日志但不返回**（避免误导用户）
- 中置信（0.60–0.85）记录到 `lowCandidates`，实际返回空（保留给后续 UI 扩展）
- 所有可播放流都指向 `/hls/clean` 入口

### 5.3 播放时的 HLS 清洗

```
播放器
  └─ GET /hls/clean?url=<m3u8>&src=bfzy
       └─ cleanHls
            ├─ fetchManifest（带 UA/Referer）
            ├─ 判断 master / media
            │    ├─ master → rewriteMaster（子清单指向 /hls/clean，保留 sign）
            │    └─ media → 按源正则剔除广告片段
            ├─ 风险检测（片段减少 >30% → 降级返回原清单）
            └─ 分片 URL 绝对化（不中转，播放器直连源站）
```

---

## 6. Stremio 协议层

### 6.1 `manifest.json`

**生成位置**：`src/addon/manifest.js`

**结构**：
```json
{
  "id": "wangqifei.eu.org.catvod",
  "version": "0.1.0",
  "name": "CatVod Multi-Source",
  "description": "多源影视聚合（技术研究）",
  "types": ["movie", "series"],
  "resources": [
    "catalog",
    "meta",
    { "name": "stream", "types": ["movie", "series"], "idPrefixes": ["tt", "bfzy:", "ffzy:", "lz:"] }
  ],
  "catalogs": [
    { "type": "movie", "id": "bfzy-movie", "name": "暴风 · 电影",
      "extra": [{ "name": "search", "isRequired": false }, { "name": "skip", "isRequired": false }] },
    { "type": "series", "id": "bfzy-series", "name": "暴风 · 剧集", "extra": [...] }
  ],
  "behaviorHints": { "configurable": true }
}
```

**注意**：
- `catalogs` 数量 = 启用源数 × 2（movie + series）
- `idPrefixes` 必须包含 `tt`（接收外部 addon 的 stream 请求）
- `configurable: true` 时 Stremio UI 显示齿轮图标

### 6.2 `/catalog/:type/:id.json`

**id 格式**：`{srcId}-{type}`（如 `bfzy-movie`）

**支持 extra**：`search`、`skip`（`skip` 目前未用于分页，源站单次返回足够）

**响应**：
```json
{
  "metas": [
    {
      "id": "bfzy:movie:20717",
      "type": "movie",
      "name": "流浪地球",
      "poster": "https://...",
      "releaseInfo": "2019",
      "description": "已完结"
    }
  ]
}
```

**Cache-Control**：`public, max-age=1800, s-maxage=1800, stale-while-revalidate=600, stale-if-error=3600`

### 6.3 `/meta/:type/:id.json`

**id 格式**：
- 内部 id：`{srcId}:{type}:{vodId}`（如 `bfzy:series:27312`）
- 外部 IMDb：`tt1234567`

**series 必须返回 `videos`**（每个 video 含 `id` / `title` / `season` / `episode`）：
```json
{
  "meta": {
    "id": "bfzy:series:27312",
    "type": "series",
    "name": "庆余年第一季",
    "videos": [
      { "id": "bfzy:series:27312:1:1", "title": "第01集", "season": 1, "episode": 1 }
    ]
  }
}
```

**movie 不返回 `videos`**（规范：单 video，id = meta id）。

### 6.4 `/stream/:type/:id.json`

**id 格式**：
- movie：`{srcId}:movie:{vodId}` 或 `tt1234567`
- series：`{srcId}:series:{vodId}:{season}:{episode}` 或 `tt1234567:{season}:{episode}`

**响应**：
```json
{
  "streams": [
    {
      "name": "暴风｜bfzym3u8",
      "title": "庆余年第一季 第02集",
      "url": "https://your-app/hls/clean?url=<encoded>&src=bfzy",
      "behaviorHints": { "notWebReady": false }
    }
  ]
}
```

**`notWebReady: true`**：表示链接不是 m3u8（share 解析失败降级的原链接），Stremio 可能提示用外部播放器。

---

## 7. 源适配器机制（重点）

### 7.1 适配器接口

每个 adapter 必须实现：

```javascript
export const adapterName = {
  id: "bfzy",                                    // 必填：与 sources.json 一致
  label: "暴风",                                  // 必填：展示名
  capabilities: { search: true, detail: true, shareResolve: false },

  // 搜索（用于 catalog 通路）
  // @param {object} cfg sources.json 中该源的配置（含 ua / referer / timeoutMs / lines）
  // @param {string} keyword 用户搜索词
  // @returns {Promise<Array<{ vod_id, vod_name, vod_year, vod_pic, type_name, vod_remarks }>>}
  async search(cfg, keyword) { ... },

  // 拉取播放地址（用于 stream 通路）
  // @param {object} cfg
  // @param {string} vodId 源站 detail 接口的 ids 参数
  // @param {{ episode?: number }} opts 集数（movie 不传）
  // @returns {Promise<Array<{
  //   lineName: string,
  //   title: string,
  //   url: string,
  //   isDirect: boolean,
  //   nonDirect?: boolean,
  //   sourceLabel: string
  // }>>}
  async resolveStream(cfg, vodId, opts) { ... }
};
```

### 7.2 通用 MacCMS 适配器（三源共用）

**位置**：`src/sources/maccmsBase.js`

| 函数 | 用途 |
|---|---|
| `maccmsSearch(cfg, keyword)` | 调 `{baseUrl}/?ac=search&wd={keyword}`，映射精简字段 |
| `maccmsDetail(cfg, vodId)` | 调 `{baseUrl}/?ac=detail&ids={vodId}`，返回原始 item |
| `parsePlayUrl(from, url)` | 拆分 `$$$`（线路）、`#`（集）、`$`（标题/URL），返回 `[{ lineName, episodes: [{ title, url }] }]` |
| `isMovie(type_name, episodes)` | 判定是否电影（type_name 含"电影/片" 或 单集 HD 开头） |
| `parseEpisodeNumber(title)` | 从 `第01集` 提取数字 `1` |

**探针已验证的字段结构**（2024 年）：
- `bfzy` search：全字段 ✅
- `ffzy` search：**仅返回 `vod_id` / `vod_name` / `type_name` / `vod_remarks`**，其余字段缺失
- `lz` search：全字段 ✅

> **重要**：ffzy search 后必须 detail 才能拿到 poster/year，因此 stream / meta 通路都走 `cachedDetail`。

### 7.3 share 页面解析

**位置**：`src/sources/shareResolver.js`

**场景**：ffzy 的 `feifan` 线路、lz 的 `liangzi` 线路返回 `https://vip.ffzy-online2.com/share/<hash>` 形式的分享页，需要二次解析出真实 m3u8。

**原理**（探针验证）：share 页面是 HTML，`<script>` 里有：
```javascript
const url = "/20250420/49523_116b8961/index.m3u8?sign=015bc..."
```

**提取策略**（通用正则）：
```javascript
const URL_VAR_RE = /(?:const\s+url|url)\s*=\s*["']([^"']+?\.m3u8[^"']*)["']/;
const M3U8_RE = /["']([^"']+?\.m3u8[^"']*)["']/;
const ABS_M3U8_RE = /(https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*)/;
```

**结果拼接**：相对路径 → `origin + path`（自动带上 `?sign=xxx`）。

**缓存**：
- 成功 → `share:{srcId}:{hash}`，TTL 3 分钟（sign 有时效）
- 失败 → 负缓存 3 分钟（避免反复打 share 页面）

### 7.4 缓存包装

**位置**：`src/sources/cached.js`

| 函数 | 缓存 key | TTL |
|---|---|---|
| `cachedSearch(entry, keyword)` | `search:{srcId}:{keyword}` | 30 分钟 |
| `cachedDetail(entry, vodId)` | `detail:{srcId}:{vodId}` | 30 分钟 |

两层缓存：
- L1 内存（TTL = L2 × 0.1，防瞬时并发）
- L2 Upstash（跨实例共享）

Inflight 去重：同一 key 的并发请求只穿透一次。

### 7.5 注册表

**位置**：`src/sources/registry.js`

```javascript
import { bfzy } from "./adapters/bfzy.js";
import { ffzy } from "./adapters/ffzy.js";
import { lz } from "./adapters/lz.js";

const ADAPTERS = { bfzy, ffzy, lz };

export function buildRegistry(sourcesConfig) {
  const map = new Map();
  for (const cfg of sourcesConfig) {
    const adapter = ADAPTERS[cfg.id];
    if (!adapter) continue;
    map.set(cfg.id, { adapter, cfg });
  }
  return {
    get(id) { return map.get(id); },
    all() { return [...map.values()]; },
    enabled() { return [...map.values()].filter((e) => e.cfg.enabled); },
  };
}
```

**新增源时这里必须加一行**。

---

## 8. 元数据与匹配引擎

### 8.1 TMDB 元数据

**位置**：`src/metadata/tmdb.js`

**流程**：
1. `GET /3/find/{imdb_id}?external_source=imdb_id` → 拿 `tmdbId`
2. `GET /3/{movie|tv}/{tmdbId}/alternative_titles` → 拿别名（只保留含中文的）
3. 返回标准化模型：
```javascript
{
  tmdbId, type, name, originalName,
  aliases: [...],           // 含中文的所有标题
  year, season, overview, poster,
  originalLanguage, originCountry
}
```

**缓存**：
- 成功 → `tmdb:{imdbId}:{type}:{season}`，TTL 7 天
- 404 / 空结果 → 负缓存 1 小时
- 网络错误 → **不缓存**（下次重试）
- 无 key → 不缓存（配了 key 立即生效）

**用户自定义 Key**：`userConfig.tmdbKey` 优先于环境变量。

### 8.2 匹配打分

**位置**：`src/metadata/matcher.js`

**默认权重**：
```javascript
{
  title: 0.5,        // 标题相似度（meta.name + aliases 取最大）
  year: 0.2,         // 年份强校验
  type: 0.1,         // 电影/剧集类型
  season: 0.2,       // 季匹配（仅 series）
  aliasBonus: 0.1    // 多别名且标题相似度 > 0.7 时的加分
}
```

**默认阈值**：
```javascript
{ high: 0.85, medium: 0.60 }
```

**相似度算法**：字符 bigram Dice 系数。

**标题清洗**（`normalizeTitle.js`）：
- 剥离语言后缀：`粤语` / `国语` / `英语` / ...
- 剥离季：`第二季` / `Season 2` / `S2`
- 归一化：去空格 / 标点 / 小写

**例子**：
| meta | 候选 | 分数 | 级别 |
|---|---|---|---|
| 庆余年（2024, s2） | 庆余年第二季粤语 | 1.000 | high |
| 庆余年（2024, s2） | 庆余年第一季（2019） | 0.700 | medium |
| 庆余年（2024, s2） | 庆余年之大夏战狼 | 0.622 | medium |
| 庆余年（2024, s2） | 流浪地球 | 0.100 | low |

---

## 9. HLS 广告清洗

### 9.1 清洗流程

**位置**：`src/hls/cleaner.js`

```
cleanHls(url, srcId, { addonBaseUrl, sourceCfg })
  ├─ 1. fetchManifest（带 UA/Referer/超时/重试）
  ├─ 2. 判断 master / media
  │     ├─ master → rewriteMaster
  │     │     ├─ 子清单 URL 改为 /hls/clean?url=<abs>&src=<srcId>
  │     │     ├─ 保留父 sign（URL query 继承）
  │     │     └─ 非 m3u8 子资源只绝对化
  │     └─ media → 三段清洗
  │           ├─ a. 按源正则剔除广告片段
  │           ├─ b. 全局广告域名黑名单剔除
  │           └─ c. 分片 URL 绝对化
  ├─ 3. 风险检测（片段减少 > 30% → 降级原样返回）
  └─ 4. 返回清洗结果
```

### 9.2 规则编译

**位置**：`src/hls/rules.js` 的 `compileRule(raw)`

**三条编译规则**：

| 输入 | 编译为 | 说明 |
|---|---|---|
| 纯数字 `"17.19"` | `/#EXTINF:\s*17\.19[^\n]*\n[^\n]*(?:\n\|$)/g` | 匹配该时长的片段整段删 |
| 含 `#` 开头或正则元字符 | 原样 `new RegExp(raw, "g")` | 完整正则 |
| 纯字面量 `"更多"` | `/#EXTINF[^\n]*更多[^\n]*\n[^\n]*(?:\n\|$)/g` | 命中 `#EXTINF` 行含该关键词的片段整段删 |

### 9.3 规则组查找优先级

**位置**：`src/hls/rules.js` 的 `findSourceGroup(url, sourceId)`

1. **sourceId → adRuleGroup**：从 `sources.json` 读每个源的 `adRuleGroup` 字段，精确匹配 `adRules.json` 的 `rules[].name`
2. **host 匹配 fallback**：遍历 `rules[].hosts`，含 `/` 时按 host+path 前缀，纯 host 时按后缀/包含

**为什么需要 sourceId 优先？**
- bfzy 直链 host 是 `p.bvvvvvvvvv1f.com`，**不含 `bfzy`**，host 匹配失败
- lz share 解析后 host 是 `v.lzcdn28.com`，**不匹配 `vip.lz` / `.cdnlz` / `hd.lz`**
- 只有靠 `sources.json` 的 `adRuleGroup` 显式映射才可靠

### 9.4 降级策略

| 触发条件 | 降级动作 | 日志 |
|---|---|---|
| 拉 manifest 失败 | 返回 307 重定向到原 URL | `[hls] fetch failed` |
| 片段减少 > 30% | 返回原清单（仅绝对化） | `[hls] high risk, degrade` |
| 命中 > 50 条规则 | 标记中风险，但不降级 | `[hls] hits > 50` |
| 无规则组匹配 | 只做广告域名黑名单 + 绝对化 | `[hls] no rules group matched` |

---

## 10. 缓存体系

### 10.1 分层架构

**位置**：`src/cache/`

```
getJSON(key)
  ├─ L1 内存命中 → 返回（TTL = L2 × 0.1，通常 60s 内）
  ├─ L1 未命中 → L2 Redis
  │    ├─ Redis 可用 → get
  │    └─ Redis 冷却中 → 跳过
  └─ 都未命中 → 返回 null（业务层会去打源站并 setJSON 写回）
```

### 10.2 Key 命名规范

```
{APP_PREFIX}:{TYPE_KEY}
```

**示例**：
```
catvod:prod:tmdb:tt0111161:movie:1
catvod:prod:search:bfzy:庆余年
catvod:prod:detail:bfzy:27312
catvod:prod:share:ffzy:116b896114ff71245852cace1f9f69c5
```

`APP_PREFIX` 可含 `:`，代码拼接时**不再额外添加 `:`**（避免 `catvod:prod::tmdb...`）。

### 10.3 TTL 配置

**位置**：`src/cache/ttl.js`

```javascript
export const TTL = {
  TMDB_META: 604800,      // 7 天
  SOURCE_DETAIL: 1800,    // 30 分钟
  SEARCH_RESULTS: 1800,   // 30 分钟
  STREAM_RESOLVE: 180,    // 3 分钟（share 解析）
};

export const NEG_TTL = {
  STREAM_403: 180,        // 3 分钟
  SUBTITLE_EMPTY: 3600,   // 1 小时
  TMDB_404: 3600,         // 1 小时
  TMDB_NETWORK: 120,      // 2 分钟
};
```

### 10.4 冷却降级

**触发**：Redis 连续 3 次超时 > 500ms
**动作**：进入 60 秒冷却期，期间跳过 L2 直接走 L1
**日志**：`[cache] redis cooldown 60000ms (fail=3)`

**本地开发建议**：把 `src/cache/index.js` 的 `REDIS_TIMEOUT_MS` 从 500 调到 1500，避免频繁触发冷却。

### 10.5 空结果与负缓存策略

- **空数组不写缓存**（`setJSON` 过滤 `[]`），避免负优化
- **负缓存用对象标记**：`{ __negative: true, reason: "not-found" }`，`getJSON` 时识别返回 `null`
- **适用场景**：
  - TMDB 404 / 空结果 → 1 小时
  - share 解析失败 → 3 分钟
  - 无效 imdbid 反复请求 → 只打一次 TMDB

---

## 11. 日志与调试系统

### 11.1 日志格式

**位置**：`src/logger.js`

**默认彩色格式**：
```
2024-11-14 13:52:04.807 [INFO] [req:83a3ef] [tmdb] tt0111161 movie s1 → cache hit
```

**JSON 格式**（`LOG_JSON=true`）：
```json
{"time":"2024-11-14 13:52:04.807","level":"info","traceId":"83a3ef...","msg":"[tmdb] tt0111161 movie s1 → cache hit"}
```

**级别**：
- `debug`：原始入参、源原始返回、匹配打分明细、清洗前后清单、正则命中
- `info`：搜索命中、匹配成功、流返回、缓存命中/未命中
- `warn`：低置信匹配、疑似误删、译名差异、源异常、Redis 超时
- `error`：源超时、解析失败、未捕获异常

### 11.2 traceId 追踪

**位置**：`src/utils/traceId.js`

- 每个请求自动生成 16 位 traceId
- 通过 `AsyncLocalStorage` 传递（无需手动传参）
- 响应头返回 `x-trace-id`，便于和客户端日志对齐

**用法**：
```javascript
import { currentTraceId } from "./utils/traceId.js";
const id = currentTraceId(); // "83a3ef..."
```

### 11.3 调试接口

| 接口 | 用途 | 示例 |
|---|---|---|
| `GET /debug/sources?keyword=庆余年` | 各源健康检测 | `curl .../debug/sources \| jq` |
| `GET /debug/match?imdbid=tt0111161&type=movie&season=1` | 匹配链路全透明 | 返回 TMDB 元数据 + 各源候选 + 每候选打分明细 |
| `GET /debug/hls-clean?url=<encoded>&src=bfzy` | HLS 清洗预览 | 返回原始 / 命中规则 / 清洗后 / 风险 |
| `POST /debug/reload-rules` | 热重载广告规则 | `curl -X POST .../debug/reload-rules` |
| `GET /debug/cache` | 缓存后端状态 | 返回 `{ backend, prefix, ok }` |
| `GET /health` | 健康检查 | 返回 `{ ok: true, ts }` |

### 11.4 复现问题的标准流程

1. 在 Stremio 触发问题，记下响应头 `x-trace-id`
2. 服务端日志 grep traceId：`grep "83a3ef" logs`
3. 用 `/debug/match` 或 `/debug/hls-clean` 复现
4. 把以下信息一并贴出：
   - 请求 curl
   - traceId
   - 完整日志
   - 调试接口返回

---

## 12. 新增一个源：完整指南

### 12.1 前置探测

**探针脚本**：`scripts/probe.js` 和 `scripts/probe-share.js`

```bash
# 1. 探测搜索/详情结构
node scripts/probe.js "庆余年"
# 输出 sources.{id}.search.itemKeys 和 has_vod_play_url

# 2. 探测 share 页面（如果有 share 线路）
node scripts/probe-share.js
# 输出 m3u8Candidates 和 isHtml / isJson
```

**判断标准**：
- `has_vod_play_url: "MISSING"` → search 不返回播放地址，必须走 detail
- `m3u8Candidates` 非空 → share 页面可解析
- `withHeaders.status` 与 `bare.status` 不同 → manifest 层有防盗链

### 12.2 步骤 1：`config/sources.json` 添加配置

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

**`lines` 的判定**：
- 如果 detail 返回的 `vod_play_from` 里线路名对应的 URL 是 `.m3u8` 结尾 → `direct`
- 如果是 `/share/xxx` → `share`

### 12.3 步骤 2：新建 adapter 文件

**标准 MacCMS 源**（`src/sources/adapters/newsrc.js`）：

```javascript
import { maccmsSearch, maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../maccmsBase.js";
import { resolveShare } from "../shareResolver.js";

export const newsrc = {
  id: "newsrc",
  label: "新源",
  capabilities: { search: true, detail: true, shareResolve: true },

  async search(cfg, keyword) {
    return maccmsSearch(cfg, keyword);
  },

  async resolveStream(cfg, vodId, { episode } = {}) {
    const item = await maccmsDetail(cfg, vodId);
    if (!item) return [];

    const lines = parsePlayUrl(item.vod_play_from, item.vod_play_url);
    const movie = isMovie(item.type_name, lines[0]?.episodes || []);
    const out = [];

    for (const line of lines) {
      const mode = cfg.lines?.[line.lineName]?.mode || "direct";
      const ep = selectEpisode(line.episodes, movie ? null : episode);
      if (!ep) continue;

      let finalUrl = ep.url;
      let nonDirect = false;

      if (mode === "share") {
        const r = await resolveShare(ep.url, {
          ua: cfg.ua, referer: cfg.referer, timeoutMs: cfg.timeoutMs, srcId: "newsrc",
        });
        if (r.ok) finalUrl = r.m3u8;
        else nonDirect = true;
      }

      out.push({
        lineName: line.lineName,
        title: ep.title,
        url: finalUrl,
        isDirect: !nonDirect,
        nonDirect,
        sourceLabel: `${this.label}｜${line.lineName}`,
      });
    }
    return out;
  },
};

function selectEpisode(episodes, episode) {
  if (!episodes.length) return null;
  if (!episode) return episodes[0];
  return episodes.find((e) => parseEpisodeNumber(e.title) === episode) || null;
}
```

**自定义接口源**：自己实现 `search` 和 `resolveStream`，返回结构必须符合 [7.1 适配器接口](#71-适配器接口)。

### 12.4 步骤 3：注册到 registry

`src/sources/registry.js`：

```javascript
import { bfzy } from "./adapters/bfzy.js";
import { ffzy } from "./adapters/ffzy.js";
import { lz } from "./adapters/lz.js";
import { newsrc } from "./adapters/newsrc.js";   // ← 加这一行

const ADAPTERS = { bfzy, ffzy, lz, newsrc };    // ← 加到这里
```

### 12.5 步骤 4：`config/adRules.json` 添加规则组

```json
{
  "name": "新源",
  "hosts": ["newsrc", "newsrccdn"],
  "regex": [
    "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:3\\.000000,[\\s\\S]*?#EXT-X-DISCONTINUITY",
    "#EXTINF.*?\\s+.*?ad.*?\\.ts"
  ]
}
```

### 12.6 步骤 5：验证

```bash
# 1. 语法检查
node --check src/sources/adapters/newsrc.js

# 2. 重启
npx vercel dev

# 3. 源健康
curl -s "http://127.0.0.1:3000/debug/sources" | jq '.sources[] | select(.id=="newsrc")'

# 4. 搜索
curl -s "http://127.0.0.1:3000/catalog/series/newsrc-series/search=庆余年.json" | jq '.metas | length'

# 5. 拉流
curl -s "http://127.0.0.1:3000/stream/series/newsrc:series:12345:1:2.json" | jq

# 6. 清洗预览
curl -s "http://127.0.0.1:3000/debug/hls-clean?url=<分片URL>&src=newsrc" | jq '{risk, degraded, hits}'

# 7. 全量健康检查
node scripts/health.js
```

### 12.7 常见接入问题

| 现象 | 原因 | 修复 |
|---|---|---|
| catalog 里看不到新源 | `registry.js` 忘注册 / `enabled: false` | 检查 registry 和 sources.json |
| search 返回 0 条 | keyword 需 URL encode / 源站封 UA | 检查 `encodeURIComponent` 和 `sources.json` 的 UA |
| stream 返回空 | detail 里 `vod_play_url` 为空 | 用 probe 脚本确认字段名 |
| 所有线路都是 `non-direct` | share 页面结构变了 | 更新 `shareResolver.js` 的正则 |
| 清洗后视频变短 | 正则过激 | 缩小正则范围，参考 [13.2](#132-常见广告特征) |

---

## 13. 广告规则维护指南

### 13.1 调试规则的标准流程

```bash
# 1. 拿到一条真实 m3u8 URL（从 /stream 返回里复制 url 参数）
# 2. 预览清洗效果
curl -s "http://127.0.0.1:3000/debug/hls-clean?url=<encoded>&src=bfzy" | jq '{
  type, risk, degraded,
  hits, originalSegments, cleanedSegments,
  originalHead, cleanedHead
}'
```

**字段解读**：
- `type`：`master` / `media` / `error`
- `risk`：`low` / `medium` / `high`
- `degraded`：是否因风险过高而降级返回原清单
- `hits`：命中的规则列表（每条含 `rule` 和 `removed` 片段数）
- `originalSegments` / `cleanedSegments`：清洗前后片段数

### 13.2 常见广告特征

| 特征 | 示例正则 |
|---|---|
| 固定时长的独立片段 | `#EXT-X-DISCONTINUITY\r*\n*#EXTINF:3\.[\s\S]*?#EXT-X-DISCONTINUITY` |
| 特定文件名 | `#EXTINF.*?\s+.*?adjump.*?\.ts` |
| 纯数字时长 | 直接写 `"17.19"`，编译为 `#EXTINF:?17\.19` |
| 时长 + 序号组合 | 写完整正则，如 `#EXTINF:6\.666667,[\s\S]*?1171057.*?\.ts` |

### 13.3 热重载

修改 `config/adRules.json` 后：

```bash
curl -X POST "http://127.0.0.1:3000/debug/reload-rules"
# {"ok":true,"groups":21,"ads":40}
```

**无需重启**。

### 13.4 风险阈值调整

`src/hls/cleaner.js` 顶部：

```javascript
export const DEFAULT_HLS_CONFIG = {
  maxReduction: 0.3,   // 片段减少 > 30% → 高风险降级
  maxHits: 50,         // 单次命中 > 50 条 → 中风险
  enableAdDomains: true,
};
```

**调整原则**：
- 源的正则过激（删掉正常片段）→ 降低 `maxReduction`
- 源广告太多（删少了）→ 提高 `maxReduction` 或新增正则

### 13.5 规则冲突排查

如果多条正则命中同一段：
- `/debug/hls-clean` 的 `hits` 里能看到每条规则分别 `removed` 多少
- 优先保留覆盖更广的，删掉重叠的

---

## 14. 配置页与 URL 参数

### 14.1 配置页

**访问**：`https://your-app.vercel.app/configure`

**能力**：
- 勾选启用的源（默认全开）
- 线路黑名单（每行一个关键词，如 `lzm3u8`）
- 自定义 TMDB API Key

### 14.2 URL 参数格式

配置页生成：
```
https://your-app.vercel.app/manifest.json?cfg=<base64url>
```

**base64url 编码**（`configure.js`）：
```javascript
btoa(unescape(encodeURIComponent(JSON.stringify(cfg))))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
```

**解码**（`createApp.js` 的 `parseCfg`）：
```javascript
const base64 = cfgB64.replace(/-/g, "+").replace(/_/g, "/");
const binary = Buffer.from(base64, "base64").toString("utf-8");
const cfg = JSON.parse(binary);
```

### 14.3 支持的配置字段

```javascript
{
  sources?: string[],     // 启用的源 id 列表（缺省全开）
  blacklist?: string[],   // 线路黑名单关键词
  tmdbKey?: string        // 用户自定义 TMDB key
}
```

### 14.4 配置的持久化

**Stremio 会自动保留 query 参数**：安装带 `?cfg=xxx` 的 manifest 后，后续所有 catalog / meta / stream 请求都会自动带上 `cfg`。

**黑名单生效位置**：`src/addon/stream.js` 的 `resolveOneSource` 里：
```javascript
function isBlacklisted(lineName, title, blacklist) {
  if (!Array.isArray(blacklist) || blacklist.length === 0) return false;
  const probe = `${lineName} ${title || ""}`;
  return blacklist.some((kw) => kw && probe.includes(kw));
}
```

**自定义 TMDB Key**：`resolveByImdb(imdbId, type, { userConfig })`，`userConfig.tmdbKey` 优先于环境变量。

---

## 15. 部署指南

### 15.1 Vercel 生产部署

**前提**：
- GitHub 仓库已有最新代码
- Vercel 账号
- Upstash Redis（可选但推荐）
- TMDB API Key

**步骤**：

1. **推代码到 GitHub**
```bash
git add .
git commit -m "feat: ready for prod"
git push origin main
```

2. **Vercel 导入项目**
   - vercel.com → Add New → Project → 选仓库
   - Framework Preset：**Other**
   - Root Directory：**留空**（不要填 `catvod`）

3. **配置环境变量**（Project Settings → Environment Variables）

| Key | Value |
|---|---|
| `APP_PREFIX` | `catvod:prod` |
| `TMDB_API_KEY` | `xxxx...` |
| `UPSTASH_REDIS_REST_URL` | `https://...` |
| `UPSTASH_REDIS_REST_TOKEN` | `xxx...` |
| `ADDON_BASE_URL` | `https://your-app.vercel.app` |
| `LOG_LEVEL` | `info` |
| `LOG_JSON` | `true` |

4. **部署**

5. **线上验证**
```bash
BASE=https://your-app.vercel.app
curl -s $BASE/health | jq
curl -s $BASE/manifest.json | jq '.catalogs | length'
curl -s "$BASE/catalog/series/bfzy-series/search=%E5%BA%86%E4%BD%99%E5%B9%B4.json" | jq '.metas | length'
curl -s "$BASE/stream/movie/tt0111161.json" | jq '.streams | length'
curl -s "$BASE/configure" -o /dev/null -w "%{http_code}\n"   # 期望 200
```

### 15.2 关键配置

**`server.js`**（必须直接 `import express`）：
```javascript
import express from "express";
import { createApp } from "./src/createApp.js";

const app = createApp();
export default app;
```

**`vercel.json`**：
```json
{
  "functions": {
    "server.js": {
      "includeFiles": "config/**,public/**"
    }
  }
}
```

> **不要**用 `api/` 目录承载 Express 应用（会与 Vercel 零配置检测冲突）。
> **不要**用复杂的 `rewrites`（零配置模式下 Vercel 自动内省 Express 路由）。

### 15.3 本地开发

```bash
# 方式 1：vercel dev（推荐，最接近线上）
npx vercel dev

# 方式 2：node 直接跑（不处理 /configure 静态文件）
PORT=7001 node --env-file=.env.local src/localServer.js
```

### 15.4 Stremio 安装

- 桌面 / Web：Addons → Community → 粘贴 `https://your-app.vercel.app/manifest.json`
- 带配置：从 `/configure` 页面生成 `?cfg=xxx` 链接后安装

---

## 16. 常见问题 FAQ

### Q1：`/configure` 返回 404 或 502

**原因**：
1. `server.js` 没有直接 `import express`
2. `vercel.json` 有 `rewrites` 干扰
3. `api/` 目录存在冲突

**修复**：
- 删除 `api/` 目录
- `server.js` 里直接 `import express`
- `vercel.json` 只保留 `functions.includeFiles`
- `createApp.js` 里用 `express.static(PUBLIC_DIR)` + `app.get("/configure", ...)`
- `rm -rf .vercel && npx vercel link && npx vercel dev`

### Q2：`/stream` 返回空，Stremio 里无流

**排查**：
1. `/debug/match?imdbid=tt0111161&type=movie` 看 TMDB 元数据
2. `meta: null` → TMDB 网络不通或 key 无效
3. `candidates` 里各源 `ranked` 都低分 → 源里没这部片
4. 某个源 `error` → 该源失效

### Q3：Redis 一直 `redis-timeout`

**原因**：本地到 Upstash 网络慢，500ms 阈值太严。

**修复**：`src/cache/index.js` 的 `REDIS_TIMEOUT_MS` 从 500 调到 1500。

### Q4：HLS 清洗后视频变短 / 音频不同步

**原因**：正则删掉了正常片段。

**修复**：
1. `/debug/hls-clean` 看 `hits` 里哪条规则 `removed` 过多
2. 缩小该正则的匹配范围
3. 用 `POST /debug/reload-rules` 热重载
4. 调整 `maxReduction`（如 0.2）

### Q5：share 线路返回 `[non-direct]`

**原因**：share 页面结构变化（HTML 里提取不到 m3u8 路径）。

**修复**：
1. 手动 `curl <share URL>` 看 HTML
2. 检查 `shareResolver.js` 的三个正则是否还能匹配
3. 更新正则后重启

### Q6：TMDB 一直返回 404

**原因**：
1. `TMDB_BASE_URL` 少了 `/3`（检查 `src/metadata/tmdb.js` 里是否 `+ "/3"`）
2. TMDB key 被撤销
3. imdbid 本身无效

**排查**：`/debug/match?imdbid=tt0111161`，看返回的 `meta` 是否为 `null`。

### Q7：源全部失效

**原因**：MacCMS 站点经常换域名。

**修复**：
1. `/debug/sources` 看哪个源 `ok: false`
2. 更新 `config/sources.json` 的 `baseUrl`
3. 或用环境变量 `BFZY_BASE_URL=https://新域名/...` 覆盖
4. 重启生效

### Q8：Vercel 部署后 `/stream` 冷启动慢

**原因**：Serverless 冷启动 + 三源并行搜索。

**缓解**：
- 配 Upstash 缓存（命中后 < 100ms）
- 或使用 Vercel Pro 的 Fluid Compute（预置实例）

---

## 17. 性能优化建议

### 17.1 已实现的优化

| 优化点 | 位置 | 效果 |
|---|---|---|
| L1 + L2 双层缓存 | `src/cache/` | 高频请求 L1 命中 < 1ms |
| Inflight 去重 | `src/cache/index.js` | 并发请求只穿透一次 |
| 三源并行搜索 | `src/addon/stream.js` | 总耗时 ≈ 最慢源耗时 |
| Redis 冷却降级 | `src/cache/index.js` | Redis 抖动不阻塞业务 |
| 负缓存 | `src/metadata/tmdb.js` 等 | 无效 id 只打一次源站 |
| master 递归改写 | `src/hls/master.js` | 分片仍直连，无中转开销 |

### 17.2 待优化项

| 优化点 | 收益 | 难度 | 建议 |
|---|---|---|---|
| `/hls/clean` 短缓存 30s | 播放秒开 | 低 | **推荐** |
| TMDB `/find` 与 `alternative_titles` 并行 | 省 300-500ms | 低 | 可选 |
| `catalog` 分页缓存 | 分页请求零开销 | 中 | 待 `extra.skip` 需求明确后做 |
| Adapter 工厂化 | 新增源 5 行代码 | 中 | 源数 > 5 时做 |

### 17.3 `/hls/clean` 缓存优化示例

**位置**：`src/routes/hls.js`，把：
```javascript
res.set("Cache-Control", "no-cache");
```
改为：
```javascript
res.set("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=60");
```

**注意**：如果源站 `sign` 时效 < 30 秒（罕见），降到 10 秒。

---

## 附录 A：快速参考

### A.1 本地启动

```bash
npx vercel dev
# 或
PORT=7001 node --env-file=.env.local src/localServer.js
```

### A.2 全量健康检查

```bash
node scripts/health.js
node scripts/health.js --verbose
node scripts/regression-test.js http://127.0.0.1:3000
```

### A.3 常用调试命令

```bash
# 源健康
curl -s "http://127.0.0.1:3000/debug/sources" | jq

# 匹配链路
curl -s "http://127.0.0.1:3000/debug/match?imdbid=tt0111161&type=movie" | jq

# HLS 清洗预览
curl -s "http://127.0.0.1:3000/debug/hls-clean?url=<encoded>&src=bfzy" | jq

# 热重载规则
curl -X POST "http://127.0.0.1:3000/debug/reload-rules"

# 缓存状态
curl -s "http://127.0.0.1:3000/debug/cache" | jq
```

### A.4 关键文件路径

| 用途 | 文件 |
|---|---|
| 新增源配置 | `config/sources.json` |
| 新增广告规则 | `config/adRules.json` |
| 新增源 adapter | `src/sources/adapters/{id}.js` |
| 注册 adapter | `src/sources/registry.js` |
| 广告清洗主流程 | `src/hls/cleaner.js` |
| 规则编译 | `src/hls/rules.js` |
| 匹配打分 | `src/metadata/matcher.js` |
| 缓存 TTL | `src/cache/ttl.js` |

---

**文档结束**。如有疑问或建议，请提交 Issue 或 PR。

后续维护约定：
- 新增源：按第 12 章流程，代码 + 配置 + 测试截图一并提交
- 广告规则：先用 `/debug/hls-clean` 验证效果，再合并
- Bug 反馈：附完整请求路径 + `x-trace-id` + 对应日志片段