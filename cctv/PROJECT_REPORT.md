# 央视片库 Stremio Addon 项目报告

> 版本：v3.4.0　|　报告日期：2026-11-28　|　项目标识：`org.workbuddy.cctvdoc`
> 本报告完整记录项目的外部数据接口、Stremio 协议接口、功能模块实现、数据结构、缓存与日志机制及验证结果。

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [外部数据接口（央视侧）](#3-外部数据接口央视侧)
4. [内部接口（Stremio Addon 协议）](#4-内部接口stremio-addon-协议)
5. [功能模块实现细节](#5-功能模块实现细节)
6. [数据结构与字段映射](#6-数据结构与字段映射)
7. [缓存、并发与容错](#7-缓存并发与容错)
8. [日志与诊断系统](#8-日志与诊断系统)
9. [配置与部署](#9-配置与部署)
10. [验证结果](#10-验证结果)
11. [已知问题与限制](#11-已知问题与限制)
12. [附录](#12-附录)

---

## 1. 项目概述

### 1.1 背景与目标

将央视网（CNTV）公开片库的内容接入 Stremio，供家庭电视（MiTV 4A，Android TV）观看。核心目标：

- 把央视纪录片、电视剧、动画片、特别节目整理为 Stremio 的 **剧集（series）** 资源；
- 每个专辑作为一部剧集，展开后为分集列表；
- 每集提供 **超清/高清/标准/流畅** 四档 HLS 播放源；
- 支持按子分类筛选与跨全库关键词搜索；
- 仅解析公开播放地址，不存储、不转存任何视频内容。

### 1.2 技术栈

| 层次 | 技术 |
|------|------|
| 运行时 | Node.js v22 |
| Web 框架 | Express（由 `stremio-addon-sdk` 间接提供） |
| 核心 SDK | `stremio-addon-sdk`（`addonBuilder` + `getRouter`） |
| HTTP 客户端 | Node 原生 `fetch`（Node 18+） |
| 数据解析 | 正则 + `URLSearchParams` + `Buffer` base64url |
| 缓存 | 进程内 `Map`（TTL 过期） |
| 配置 | Stremio 标准 URL 路径配置 + 静态 `configure.html` |
| 日志 | 自研结构化日志模块（默认关闭，按需开启；内存环形缓冲 + 控制台 + 文件） |

### 1.3 版本演进

| 版本 | 主要变更 |
|------|----------|
| 1.0.0 | 初始实现，`movie` 类型，单档流 |
| 2.0.0 | 改为 `series` 模型，四档清晰度，完整 meta，分类过滤 |
| 2.0.x | 增加结构化日志、请求追踪、分页（修复目录不显示）、诊断端点 |
| **3.0.0** | 新增电视剧/动画片/特别节目三类目录与子分类，新增全库 search，更名为「央视片库」 |
| **3.0.1** | 修复新版专辑页 JS 数组分集解析；修正虚标 1080P，改用 master m3u8 真实分辨率（最高 720P）；日志回显完整请求路径与 stream URL |
| **3.0.2** | 修复特别节目无播放源：单集内容改用 API 的 `video.url`（VIDE 页）作为条目；修复裸 VIDE 文件名被误补成无效域名的问题 |
| **3.1.0** | 新增「央视4K专区」目录（仅电视剧/科教，87 条）；通过 `videoinfoByGuid` + `getVideoListByAlbumIdNew` 还原完整分集（含每集缩略图）；新增 `cctv.4k.` ID 前缀；4K 流实测真实 1080P（4000kbps） |
| **3.2.0** | 修复花屏：`asp/enc/hls/` 分片码流损坏，全部改用 `hls.cntv.lxdns.com/asp/hls/` 稳定路径并逐档探测；4K 拆为电视剧4K/纪录片4K/科教4K 三个独立 catalog；修复从搜索进入的多集内容只有 1 集：`getAlbumMeta` 单集页统一经 API 展开完整分集（共用 `expandAlbumFromApi`），实测《山海经奇》搜索进入可得完整 16 集+缩略图 |
| **3.3.0** | **根治花屏 + 真画质**：查明花屏根因是央视 H5e 加密（wasm 按 NALU 加密 TS 分片），并非码流损坏。内嵌官方 wasm 解密器 `lib/vendor/h5e_bundle.js`，新增本地 HLS 解密代理端点（`/h5e/m3u8/...`、`/h5e/ts/...`）与串行解密封装 `lib/h5e-decryptor.js`。stream 每集返回两组源：稳定源（480x270/640x360/4K真1080P）+ 原画源（解密后真 720P/1080P，0 解码错误）。解决了"真画质 vs 花屏"的取舍。 |
| **3.4.0** | **用户配置 + 可观测性**：新增 `/configure` 配置页，8 个 catalog 与 6 组画质独立开关；manifest 按配置动态过滤，catalog/stream handler 按配置生效。日志系统改为默认完全关闭，支持按请求 debug 开启与进程级手动开启；新增参考 hyperTv 的实时日志页（事项分区、增量轮询、详情展开）。新增 `health.js` 端到端健康检查（38 项 PASS），逐步骤定位配置、接口、代理、解密与日志问题。修复 yxg「全部」筛选传参错误（`area=全部` 返回 0 条，改为空字符串）。 |
| **3.5.0** | **VPS 部署适配**：configure 增加「stream 总开关」与「解密代理开关」；总开关关闭时 manifest 移除 stream 资源、handler 返回空，交给本地 provider。修复老旧分集 URL 的日期路径过期问题（源站返回 JS 跳转桩页，`httpGetPage` 自动跟随最多 5 跳）。stream 新增 `步骤 2a/2b/2c` 精准失败日志与 `REDIRECT` 日志。新增独立央视 provider `nuvioProvider/providers/cctv.js`（电视本地解析、规避 IP 校验）。 |
| **3.6.0** | **三开关解耦**：新增「加密 URL 开关」作为父开关——关闭时 h5e 加密源整体移除，代理开关随之失效；开启时由代理开关决定返回 VPS 代理 URL 还是原始 `asp/h5e/` URL（后者带 `behaviorHints.h5eEncrypted=true`，交电视端原生解密层）。configure 页增加开关联动禁用态。健康检查升级至 45 项，新增三开关四种组合回归用例，并修复 manifest 版本写死断言、stream 偶发抖动误报、UPSTREAM 日志冷门 meta 触发等稳定性问题。 |
| **3.6.1** | **日志驱动的可用性修复**：分析 3222 行运行日志发现两类"大量无法播放"。① 4K 专辑 meta 崩溃：`resolveEpisodePage` 重构后只返回 `htmlLength` 不再返回 `html`，但 `get4KAlbumMeta:616` 仍用 `page.html.match()`，导致 21 次 meta 返回 null；修复为随返回值携带 `html`。② 画质过滤砍光：用户只勾 `stable_1080`+`h5e_1080`，而多数节目最高仅 720P，`before:8→after:0` 致无法播放；新增降级兜底——勾选档位在源中均不存在时返回该集最高画质档位，并在 configure 页加醒目提示。`httpGet` 增加网络级错误（fetch failed/SSL 抖动）重试 1 次，HTTP 4xx 不重试。健康检查升至 47 项，新增 4K meta 不崩溃与画质降级兜底回归。 |
| **3.4.0 patch** | **部分老片无 stream + 画质排序**：央视对过期日期路径的分集 URL 不返回 HTTP 3xx，而是 169 字节的 `window.location.href='...'` JS 跳转桩页；原 fetch 层不执行 JS，导致 `guid` 解析失败、stream 静默返回 0。新增 `httpGetPage`（轻量桩页 JS/meta-refresh 跳转跟随，最多 5 跳，带 `REDIRECT` 日志）并用于 `getGuidFromEpisode` / `getAlbumMeta` / `get4KAlbumMeta`。`getStreamsForEpisode` 增加 `步骤 2a/2b/2c 失败` 精确日志（无 guid / API 异常 / 档位不可用，含完整 API URL）。stream 改为按真实分辨率降序输出（高画质置顶）。`health.js` 新增画质降序与过期 URL 跳转回归用例，最终 40 PASS。 |

---

## 2. 系统架构

### 2.1 分层结构

```
Stremio 客户端（电视 / 手机 / Web）
        │  HTTP GET
        ▼
┌───────────────────────────────────────┐
│ index.js  —  HTTP 层 / Addon 入口      │
│  · /configure 配置页 / 动态 manifest    │
│  · 配置解析中间件（路径 cfg / ?cfg=）    │
│  · requestLogger（默认关闭，按需开启）   │
│  · /api/logs 实时日志 / /_diagnostics   │
│  · /h5e/m3u8 + /h5e/ts 解密代理         │
│  · getRouter(builder.getInterface())    │
│  · catalog / meta / stream 三个 handler │
└───────────────┬───────────────────────┘
                │
┌───────────────▼───────────────────────┐
│ lib/cctv.js  —  业务解析层             │
│  · 片库抓取 / yxg API / 搜索聚合        │
│  · 专辑页解析 / 分集提取                │
│  · guid 提取 / 四档流构造               │
│  · ID 编解码                            │
└───────────────┬───────────────────────┘
                │
┌───────────────▼───────────────────────┐
│ lib/fetch.js  —  基础设施层            │
│  · httpGet / httpGetJson（超时/UA）     │
│  · cacheGet / cacheSet（TTL 缓存）      │
│  · mapLimit（并发池）                   │
└───────────────┬───────────────────────┘
                │
                ▼
     央视网 HTTP/JSON 数据源
```

### 2.2 文件清单

| 文件 | 职责 |
|------|------|
| `index.js` | Addon 入口：manifest 定义、Express 装配、配置解析、动态 manifest、catalog/meta/stream handler、H5e 解密代理、诊断与日志端点 |
| `lib/cctv.js` | 央视站点与 API 解析：四类 catalog 数据源、搜索、专辑 meta、分集与播放地址解析、ID 编解码；stream 附加 `_source/_code/_width/_height` 供画质过滤 |
| `lib/config.js` | 配置模型：catalog/quality/debug 开关、URL 路径配置编解码、manifest 过滤、stream 画质分组 |
| `lib/fetch.js` | HTTP 封装：超时控制、UA、TTL 内存缓存、并发池、UPSTREAM 结构化日志 |
| `lib/logger.js` | 默认关闭的结构化日志：AsyncLocalStorage 按请求开启、内存环形缓冲、事项分区、控制台与文件输出、脱敏 |
| `lib/log-page.js` | 实时日志页 HTML（未开启/已开启两态），参考 hyperTv 实现 |
| `lib/h5e-decryptor.js` + `lib/vendor/h5e_bundle.js` | wasm H5e 解密封装与官方 bundle |
| `public/configure.html` | 用户配置页：catalog/画质/日志开关，生成 Stremio 安装链接 |
| `health.js` | 端到端健康检查脚本，逐步骤定位问题并输出 PASS/FAIL/SKIP |
| `README.md` | 安装与使用说明 |
| `PROJECT_REPORT.md` | 本报告 |
| `CCTV_API_REFERENCE.md` | 央视接口独立参考文档 |
| `package.json` | 依赖声明（`stremio-addon-sdk`） |
| `logs/addon.log` | 运行日志（仅在日志开启后写入） |

### 2.3 数据流

1. **浏览目录**：Stremio 请求 `catalog` → 按 catalog id 选择数据源 → 抓取/读取缓存 → 按 `skip` 分页 → 返回 metas。
2. **查看详情**：Stremio 请求 `meta` → 解码 ID 得专辑 URL → 抓专辑页 → 提取标题/封面/简介/分集 → 返回 videos。
3. **播放**：Stremio 请求 `stream` → 解码分集 ID 得单集 URL → 抓单集页提取 guid → 调播放 API 得 m3u8 → 构造四档地址返回。
4. **搜索**：Stremio 请求带 `search` 的 catalog → 聚合四类数据 → 本地关键词过滤 → 分页返回。

---

## 3. 外部数据接口（央视侧）

### 3.1 接口总览

| # | 接口 | 类型 | 用途 | 缓存 |
|---|------|------|------|------|
| A | `jishi.cctv.com/doc/.../index.shtml` | HTML | 纪录片栏目列表 | 6 小时 |
| B | `api.cntv.cn/list/getVideoAlbumList` | JSON | 电视剧/动画片/特别节目列表 | 6 小时 |
| C | `tv.cctv.com/.../VIDA*.shtml` | HTML | 专辑详情 + 分集列表 | 12 小时 |
| D | `tv.cctv.com/.../VIDE*.shtml` | HTML | 单集页，提取 guid | 12 小时 |
| E | `vdn.apps.cntv.cn/api/getHttpVideoInfo.do` | JSON | guid 换 HLS 地址 | 30 分钟（结果层） |
| F | `hls.cntv.lxdns.com` / `newcntv.qcloudcdn.com` | HLS | m3u8 播放流 | 不缓存 |
| G | `api.cntv.cn/NewVideo/getLastVideoList4K` | JSON | 4K 专区片单（电视剧/科教） | 6 小时 |
| H | `api.cntv.cn/video/videoinfoByGuid` | JSON | 4K guid 换 album_id / 专辑信息 | 12 小时（结果层） |
| I | `api.cntv.cn/NewVideo/getVideoListByAlbumIdNew` | JSON | 4K 完整分集列表（含缩略图） | 12 小时（结果层） |

### 3.2 接口 A：纪录片栏目页

纪录片数据来自纪实频道 21 个栏目页，静态 HTML 中嵌有 `<li>` 列表。

**基础 URL**：`https://jishi.cctv.com`

**栏目路径映射**（`CATALOG_SOURCES`）：

| key | 路径 | 说明 |
|-----|------|------|
| `rwdl` | `/doc/cctv9/lm/rwdl/index.shtml` | 人文历史 |
| `military` | `/doc/list/lx/military/index.shtml` | 军事 |
| `explore` | `/doc/list/lx/explore/index.shtml` | 探索 |
| `social` | `/doc/list/lx/social/index.shtml` | 社会 |
| `nature` | `/doc/list/lx/Nature/index.shtml` | 自然 |
| `jj` | `/doc/list/fl/jj/index.shtml` | 经济 |
| `yzam` | `/doc/list/fl/yzam/index.shtml` | 宇宙奥秘 |
| `hkht` | `/doc/list/fl/hkht/index.shtml` | 航空航天 |
| `kgfx` | `/doc/list/fl/kgfx/index.shtml` | 考古发现 |
| `whys` | `/doc/list/fl/whys/index.shtml` | 文化艺术 |
| `xzaj` | `/doc/list/fl/xzaj/index.shtml` | 刑侦案件 |
| `zn` | `/doc/list/fl/zn/index.shtml` | 灾难 |
| `dw` | `/doc/list/fl/dw/index.shtml` | 动物 |
| `ty` | `/doc/list/fl/ty/index.shtml` | 体育 |
| `yl` | `/doc/list/fl/yl/index.shtml` | 娱乐 |
| `zw` | `/doc/list/fl/zw/index.shtml` | 植物 |
| `ly` | `/doc/list/fl/ly/index.shtml` | 旅游 |
| `dz` | `/doc/list/fl/dz/index.shtml` | 谍战 |
| `nx` | `/doc/list/fl/nx/index.shtml` | 女性 |
| `qs` | `/doc/list/fl/qs/index.shtml` | 青少 |
| `other` | `/doc/list/lx/other/index.shtml` | 其他 |

**解析规则**（`parseAlbumList`）：
- 逐个匹配 `<li>...</li>` 块；
- 链接正则：`href="(https?://tv\.cctv\.com/\d{4}/\d{2}/\d{2}/VIDA\w+\.shtml)"`；
- 标题来源：`<h3><a title="...">` → `<a title="..." href="...VIDA">` → `.text > a` → `<a href="...VIDA">文本</a>`；若标题本身是 VIDA ID 则视为无效；
- 封面来源：`<img data|src="//....jpg|png|jpeg">`，协议相对 URL 补全为 `https:`；
- 按 URL 去重。

**Stremio 展示分类映射**（`CATEGORIES`，共 10 项）：

| id | 名称 | 聚合的栏目 key |
|----|------|---------------|
| `all` | 全部 | 全部 21 个栏目 |
| `rwdl` | 人文历史 | rwdl, whys, kgfx |
| `people` | 人物 | rwdl |
| `military` | 军事 | military, xzaj |
| `explore` | 探索 | explore, yzam, hkht |
| `social` | 社会 | social, xzaj, zn |
| `nature` | 自然 | nature, dw, zw |
| `politics` | 时政 | rwdl, jj |
| `economy` | 经济 | jj |
| `tech` | 科技 | yzam, hkht |

> 说明：现行央视页面中「人物」「时政」无独立有效栏目页，映射到最接近的人文历史/经济栏目。

### 3.3 接口 B：yxg 专辑列表 API

电视剧/动画片/特别节目来自 `tv.cctv.com/yxg` 栏目页的 AJAX 接口，返回结构化 JSON，比 HTML 解析稳定。

**端点**：`GET https://api.cntv.cn/list/getVideoAlbumList`

**请求参数**：

| 参数 | 说明 | 示例 |
|------|------|------|
| `channelid` | 栏目 ID（见下表） | `CHAL1460955853485115` |
| `area` | 地区筛选（地区类栏目用） | `欧美` / 空 |
| `sc` | 类型筛选（特别节目用） | `军事` / 空 |
| `fc` | 固定分类名 | `电视剧` |
| `year` | 年份筛选 | 空 |
| `letter` | 首字母筛选 | 空 |
| `p` | 页码，从 1 开始 | `1` |
| `n` | 每页条数（代码固定 24） | `24` |
| `serviceId` | 固定值 | `tvcctv` |
| `topv` | 固定值 | `1` |
| `t` | 返回格式 | `json` |

**栏目配置**（`YXG_TYPES`）：

| typeId | 名称 | channelid | fc | 子分类维度 | 子分类选项 |
|--------|------|-----------|----|-----------|-----------|
| `tv` | 电视剧 | `CHAL1460955853485115` | 电视剧 | 地区（`area`） | 全部/内地（大陆）/港澳台/欧美/其他 |
| `animation` | 动画片 | `CHAL1460955899450127` | 动画片 | 地区（`area`） | 全部/内地（大陆）/港澳台/欧美 |
| `special` | 特别节目 | `CHAL1460955953877151` | 特别节目 | 类型（`sc`） | 全部/新闻/经济/综艺/体育/军事/影视/科教/戏曲/青少/音乐/社会/文化/公益/其他 |

**响应结构**：

```json
{
  "data": {
    "total": 1160,
    "list": [
      {
        "title": "《爱在山海间》",
        "brief": "以苏可为代表的援藏医疗队进驻西部藏区……",
        "image": "https://p1.img.cctvpic.com/photoAlbum/vms/image/3918….jpg",
        "image2": "https://p1.img.cctvpic.com/photoAlbum/vms/image/3918….jpg",
        "image3": "https://p1.img.cctvpic.com/photoAlbum/vms/image/3918….jpg",
        "url": "https://tv.cctv.com/2026/09/28/VIDAMniIPhrsBrSROetQt5RF260928.shtml",
        "area": "内地（大陆）",
        "year": "2026",
        "sc": "农村",
        "fc": "电视剧",
        "actors": "巩峥,张燕（张馨予）,曲尼次仁",
        "count": "20",
        "vsetid": "VSET1k3j0u75u3bvp5kmm0i777",
        "id": "VIDAMniIPhrsBrSROetQt5RF260928",
        "focus_date": 1790601185000,
        "video": {
          "url": "https://tv.cctv.com/2026/10/26/VIDE76ZCgAlPXkyYuW2uv5Lp261026.shtml",
          "id": "VIDE76ZCgAlPXkyYuW2uv5Lp261026",
          "title": "《爱在山海间》 第1集",
          "image": "https://p1.img.cctvpic.com/fmspic/2026/10/26/d2288f0c3c154f62988805fb8db5ff8c-1.jpg"
        }
      }
    ]
  }
}
```

**字段映射**（`getYxgCatalog`）：

| API 字段 | 内部字段 | 说明 |
|----------|----------|------|
| `url` | `url` | 专辑页地址，仅保留匹配 `VIDA\w+.shtml` 的项 |
| `title` | `title` | 标题 |
| `image2` / `image` | `poster` | 封面，优先 image2 |
| `brief` | `description` | 简介 |
| `area` | `area` | 地区（参与搜索） |
| `year` | `year` | 年份（参与搜索） |
| `actors` | `actors` | 主演（参与搜索） |
| `count` | `count` | 集数 |

**数据量实测**：电视剧 1160 部、动画片 1136 部、特别节目 2000 部。

> 抓取页数：常规目录 6 页（144 条/分类），搜索聚合 8 页（192 条/类型）。

### 3.4 接口 C：专辑页（VIDA）

**URL 格式**：`https://tv.cctv.com/YYYY/MM/DD/VIDA<id>.shtml`

**解析内容**（`getAlbumMeta`）：

| 项目 | 提取方式 |
|------|----------|
| 标题 | `<title>` 文本，去除 `_CCTV节目官网…`、`_央视网…` 后缀 |
| 封面 | `<meta property="og:image" content="...">`，兼容两种属性顺序 |
| 简介 | `<meta name="description" content="...">`，兼容 `content` 带引号/不带引号两种写法（`parseMetaTag`） |
| 分集 | 页面中所有 `VIDE` 链接，由 `parseEpisodes` 提取 |

**分集提取正则**（`parseEpisodes`）：
1. `href="(…/VIDE\w+.shtml)"[^>]*title="([^"]*)"`
2. `title="([^"]*)"[^>]*href="(…/VIDE\w+.shtml)"`

按 VIDE ID 去重，标题为空时回退为「第 N 集」。

### 3.5 接口 D：单集页（VIDE）

**URL 格式**：`https://tv.cctv.com/YYYY/MM/DD/VIDE<id>.shtml`

**解析内容**（`getGuidFromEpisode`）：

```js
/var\s+guid\s*=\s*"([0-9a-f]{32})"/i   // 优先
/guid\s*=\s*"([0-9a-f]{32})"/i         // 兜底
```

提取 32 位十六进制的 CNTV 视频 GUID，作为接口 E 的 `pid`。

### 3.6 接口 E：播放地址 API

**端点**：`GET https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=<guid>`

**关键返回字段**：

| 字段 | 说明 |
|------|------|
| `hls_url` | HLS 主地址，形如 `https://<域名>/asp/hls/main/0303000a/3/default/<guid>/main.m3u8?maxbr=…` |
| `video.chapters4/3/2/1` | 旧版 MP4 分章字段，**当前 `url` 已被央视置空**，仅作降级兜底 |

> 重要发现：央视 MP4 直链字段已全部置空，仅 HLS 可用。因此 addon 完全基于 HLS 构造播放源。

### 3.7 接口 F：HLS 多码率播放流

**关键修正（v3.0.1）**：早期版本从 `hls_url` 的简化 CDN 路径构造四档地址，但**实测这些路径返回的全是低清源**——用 ffprobe 下载分片验证，所谓"超清 1080P"实际只有 480×270。真正的多码率 master 藏在 API 返回的 `manifest.hls_enc_url` / `hls_h5e_url` 中。

**现行实现**（`parseMasterPlaylist` + `buildQualityStreams`）：

1. 优先请求 `manifest.hls_enc_url`（`dhls.cntv.kcdnvip.com/asp/enc/hls/...`）
2. 解析 master m3u8 中的 `#EXT-X-STREAM-INF:BANDWIDTH=…,RESOLUTION=…` 得到**真实分辨率**
3. 按码率降序返回全部档位，名称按真实分辨率标注

**真实 master m3u8 内容示例**（enc 路径，9 行四档）：

```
#EXT-X-STREAM-INF: BANDWIDTH=460800, RESOLUTION=480x270
/asp/enc/hls/450/.../450.m3u8
#EXT-X-STREAM-INF: BANDWIDTH=870400, RESOLUTION=640x360
/asp/enc/hls/850/.../850.m3u8
#EXT-X-STREAM-INF: BANDWIDTH=1228800, RESOLUTION=1280x720
/asp/enc/hls/1200/.../1200.m3u8
#EXT-X-STREAM-INF: BANDWIDTH=2048000, RESOLUTION=1280x720
/asp/enc/hls/2000/.../2000.m3u8
```

**四档真实分辨率对照**（ffprobe 实测分片）：

| 码率 | master 声明 | 实测分辨率 | addon 名称 |
|------|------------|-----------|-----------|
| `2000` | 1280x720 | 1280×720 | 高清 720P 高码率 |
| `1200` | 1280x720 | 1280×720 | 高清 720P 1229kbps |
| `850` | 640x360 | 640×360 | 流畅 640x360 |
| `450` | 480x270 | 480×270 | 流畅 480x270 |

**结论**：央视源片**最高只有 720P，不存在 1080P**。两档 720P（2000/1200kbps）分辨率相同、码率不同。降级路径（enc 不可用时）会解析 `hls_url`，此时只有 450 一档，如实标注 480×270。

**关键修正（v3.2.0）：花屏根因与稳定路径**

v3.0.1～v3.1.0 直接使用 `manifest.hls_enc_url` 的 `asp/enc/hls/` 分档地址，用户报告播放画面"花色"马赛克。排查结论：

- `asp/enc/hls/` 的分片虽 HTTP 200、TS 同步字节正常（0x47/188 间隔），但 **H264 码流实际损坏**：`ffmpeg` 抽帧时大量报 `top block unavailable for requested intra mode` / `error while decoding MB`，解码画面为全灰或花屏；
- 对比 `hls.cntv.lxdns.com/asp/hls/{code}/` 稳定路径的同 guid 分片，ffmpeg 抽帧画面清晰正常、无解码错误。

**现行实现**：master 仅用于读取"有哪些档位"，实际 URL 一律用稳定域名 `hls.cntv.lxdns.com` + `/asp/hls/{code}/` 重建，并在返回前逐档探测可用性（m3u8 头部 `#EXTM3U` + `.ts` 存在）。4K 内容在稳定路径只有 `4000`（1920×1080）一档，普通内容有 `2000/1200/850/450` 四档。缓存 key 升级为 `streams:v4:stable:` 以避开旧的花屏结果。

| 路径 | HTTP | TS 解码 | 结论 |
|------|------|---------|------|
| `dhls.cntv.*/asp/enc/hls/` | 200 | 花屏/解码报错 | 不可用 |
| `hls.cntv.lxdns.com/asp/hls/` | 200 | 画面正常 | **采用** |

**关键修正（v3.2.0 续）：档位号虚标真相**　用户指出"网页超清/高清比我们的清晰"，实测证实该判断正确。用 ffprobe 对普通内容逐档测真实分辨率：

| 档位号（标称码率）| master 声明 | 稳定路径实测真实分辨率 |
|---|---|---|
| 2000 | 1280×720 / 2048kbps | **480×270**（虚标）|
| 1200 | 1280×720 / 1229kbps | **480×270**（虚标）|
| 850 | 640×360 / 870kbps | 640×360（真实）|
| 450 | 480×270 / 461kbps | 480×270（真实）|
| 4000（4K 内容）| 1920×1080 / 4096kbps | 1920×1080（真实）|

- **真相**：档位号是"标称码率"，不是真实分辨率。稳定路径下普通内容的 2000/1200 档实际都只有 480×270；此前将其标为"高清 720P"属于虚标。
- **网页为何更清晰**：网页端 `h5e` 路径（如 `dh5ws01.v.cntv.cn/asp/h5e/hls/1200/...`）的 1200 档经 ffprobe 确为**真 1280×720**；但该加密路径码流在 VLC/ffmpeg 下花屏（`non-existing SPS 0` / `error while decoding MB`，抽帧全灰），网页播放器可容错解码。
- **不可两全**：真画质（enc/h5e）→ VLC 花屏；不花屏（稳定路径）→ 普通内容 480×270。电视端 Stremio 使用标准播放器，与 VLC 同属严格解码，故只能采用稳定路径。
- **现行处理**：`TIER_RESOLUTION` 表按实测真实分辨率修正（2000/1200 改为 480×270）；`qualityName` 对低于 720P 的档位附加档位号 `[2000]/[1200]/[850]/[450]` 供区分，标签不再虚标。4K 内容走 4000 档，仍是真实 1080P，不受影响。

---

## 4. 内部接口（Stremio Addon 协议）

### 4.1 Manifest

**端点**：`GET /manifest.json`

核心配置：

```json
{
  "id": "org.workbuddy.cctvdoc",
  "version": "3.0.0",
  "name": "央视片库",
  "resources": ["catalog", "meta", "stream"],
  "types": ["series"],
  "idPrefixes": ["cctv.s.", "cctv.e."],
  "catalogs": [ /* 5 个目录，见 4.2 */ ]
}
```

### 4.2 Catalog 目录清单

| catalog id | 名称 | extra 参数 | isRequired |
|------------|------|-----------|------------|
| `cctv_doc` | 央视纪录片 | `genre`（10 选项）+ `skip` | 否 |
| `cctv_tv` | 央视电视剧 | `地区`（5 选项）+ `skip` | 否 |
| `cctv_animation` | 央视动画片 | `地区`（4 选项）+ `skip` | 否 |
| `cctv_special` | 央视特别节目 | `类型`（15 选项）+ `skip` | 否 |
| `cctv_4k_tv` | 电视剧4K | `skip` | 否 |
| `cctv_4k_doc` | 纪录片4K | `skip` | 否 |
| `cctv_4k_science` | 科教4K | `skip` | 否 |
| `cctv_search` | 央视片库搜索 | `search` + `skip` | **search 为必填** |

所有目录 `type` 均为 `series`，`optionsLimit: 1`（单选）。

### 4.3 端点路由

SDK 路由格式：`/:config?/:resource/:type/:id/:extra?.json`，其中 `config` 是 `encodeURIComponent(JSON.stringify(cfg))`。

| 端点 | 示例 | 返回 |
|------|------|------|
| 配置页 | `/configure` | HTML 配置界面 |
| 动态 manifest | `/<config>/manifest.json` | 按配置过滤后的 manifest 对象 |
| 实时日志（HTML） | `/<config>/api/logs?format=html` | 实时日志页面；未开启时显示开启指引 |
| 实时日志（JSON） | `/<config>/api/logs?level=DEBUG&limit=400&since=0&q=` | `{ ok, debug, total, buffered, logs }` |
| 日志开关 | `/api/logs?enable=1` / `?disable=1` / `?clear=1` | 进程级开关或清空缓冲 |
| manifest | `/manifest.json` | 默认全量 manifest 对象 |
| catalog（无 extra） | `/catalog/series/cctv_doc.json` | `{ metas: [...] }` |
| catalog（带 extra） | `/catalog/series/cctv_tv/地区=欧美&skip=0.json` | `{ metas: [...] }` |
| search | `/catalog/series/cctv_search/search=海洋.json` | `{ metas: [...] }` |
| meta | `/meta/series/cctv.s.<base64url>.json` | `{ meta: {...} }` |
| stream | `/stream/series/cctv.e.<base64url>.<index>.json` | `{ streams: [...] }` |
| 诊断（本项目自定义） | `/_diagnostics` | JSON 自检报告 |
| H5e 代理 m3u8（本项目自定义） | `/h5e/m3u8/<base64url(原始m3u8 URL)>` | 播放列表（分片 URL 重写为本地代理）|
| H5e 代理 ts（本项目自定义） | `/h5e/ts/<base64url(原始ts URL)>` | 解密后的 TS 二进制（`video/mp2t`）|

### 4.3.1 H5e 解密代理（v3.3.0 核心）

**问题本质**：央视 h5e/hls 路径（`dh5ws*.v.cntv.cn/asp/h5e/hls/...`）的 TS 分片经 **H5e 加密**——wasm 模块按 NALU 改写视频数据，密钥状态含播放器标签。这解释了为什么 TS 结构完整、SPS/PPS 都在，但 VLC/ffmpeg 严格解码仍报 `non-existing SPS 0` / `error while decoding MB`、画面纯灰：**不是码流损坏，是加密**。

**解法**：内嵌官方 wasm 解密模块 `lib/vendor/h5e_bundle.js`（3.2MB，data URI 自带 H5player.json，无网络依赖），暴露 `H5EBridge.beginSession()` / `decryptSegment(b64)`。Stremio 播放器不会自己调用 JS 解密，故在 addon 侧做透明代理：

```
播放器 → /h5e/m3u8/<b64>  → 下载原始 m3u8，把每个分片 URL 改写为 /h5e/ts/<b64>
播放器 → /h5e/ts/<b64>    → 下载加密 TS → wasm 解密 → 返回 video/mp2t
```

- `lib/h5e-decryptor.js`：`beginSession()` 建立会话，Promise 队列串行化所有 `decryptSegment`（wasm 全局 session 不允许并发）；解密失败回退原片。
- 代理 host 自动取客户端访问 addon 的 host（最近一次非 localhost 请求的 Host 头），可用 `ADDON_HOST` 环境变量显式指定。
- **实测验证**：花屏分片解密前 ffprobe 6 个解码错误、抽帧纯灰；解密后 0 错误、1280x720 清晰画面。4K 内容 1080P 分片解密后 1920x1080、0 错误。5 分片并发请求全部 200。
- 来源：`h5e_bundle.js` 来自 MyTVB 项目（github.com/qianxuntudou-ops/MyTVB）assets/h5e/，其内嵌官方 worker 与 node CLI 字节级一致。

### 4.4 分页机制（关键修复）

> **背景**：早期版本一次性返回全部 2018 条 metas（约 604KB），导致 Stremio 首页不显示目录。经查 SDK 文档确认：Stremio 标准页大小为 100，返回少于 100 条视为目录结束。

**实现**：
- manifest 所有 catalog 增加 `{ name: 'skip', isRequired: false }`；
- handler 按 `skip` 切片：`metas.slice(skip, skip + PAGE_SIZE)`；
- `PAGE_SIZE` 默认 100，可用 `CATALOG_PAGE_SIZE` 环境变量调整；
- 日志中记录 `skip`、`sentCount`、`hasMore`，便于追踪翻页。

### 4.5 ID 编解码方案

采用 base64url 编码 URL，规避特殊字符并保证 ID 前缀匹配 manifest 的 `idPrefixes`。

| 类型 | 格式 | 示例（截断） |
|------|------|-------------|
| 剧集 | `cctv.s.` + base64url(专辑URL) | `cctv.s.aHR0cHM6Ly90di5jY3R2LmNvbS8yMDI2...` |
| 4K 剧集 | `cctv.4k.` + base64url(4K单集URL) | `cctv.4k.aHR0cHM6Ly90di5jY3R2LmNvbS8yMDI0...` |
| 分集 | `cctv.e.` + base64url(单集URL) + `.` + 序号 | `cctv.e.aHR0cHM6Ly90di5jY3R2LmNvbS8yMDI2....1` |

编码：`Buffer.from(url).toString('base64url')`
解码：`Buffer.from(id.slice(7), 'base64url').toString('utf8')`

> 分集 ID 中的序号仅用于 `releaseInfo` 展示，播放时按 URL 解析，不依赖序号。

---

## 5. 功能模块实现细节

### 5.1 Catalog handler

**分发逻辑**（`loadAlbumsForCatalog`）：

```
catalogId === 'cctv_search'  → searchCatalog(keyword)
catalogId === 'cctv_doc'     → getCatalog(genre 映射后的 category)
catalogId ∈ FOURK_TYPES      → get4KCatalog(typeId)
catalogId ∈ YXG_TYPES        → getYxgCatalog(typeId, 子分类值, 6)
其他                          → 空数组 + WARN 日志
```

**meta 构造**：
```js
{
  id: encodeSeriesId(al.url),
  type: 'series',
  name: al.title || (VIDA ID 回退) || '央视节目',
  poster: al.poster,
  posterShape: 'poster',
  description: al.description || '央视网节目'
}
```

**健康度诊断**（每次响应记录）：重复 ID 数、ID 前缀分布、样本 ID/名称、无封面数、首条完整 meta。

### 5.2 Meta handler

1. 按 ID 前缀分流：`cctv.4k.` → `decode4KSeriesId`，其余 → `decodeSeriesId`；失败返回 `{ meta: null }`；
2. 4K 条目走 `get4KAlbumMeta(url)`；其余走 `getAlbumMeta(url)`。两者**共用通用展开函数** `expandAlbumFromApi(guid, serviceId)`：`videoinfoByGuid` → `album_id` → `getVideoListByAlbumIdNew` 分页拉完整分集（含缩略图）。关键修正：普通 `getAlbumMeta` 遇到单集页（VIDE）时也先走 API 展开——这样从**搜索**进入的多集内容（ID 为 `cctv.s.`）也能拿到完整剧集，而非只有 1 集；展开失败才回退为单集；
3. 分集映射为 Stremio videos（4K 条目附带 `thumbnail: ep.image`）：
   ```js
   { id: encodeVideoId(ep.url, i+1), title: ep.title || `第 ${i+1} 集`,
     season: 1, episode: i+1, released: '',
     ...(ep.image ? { thumbnail: ep.image } : {}) }
   ```
4. 组装 meta，含 `releaseInfo: "N 集"`、`videos`、`links: []`。

### 5.3 Stream handler

1. `decodeVideoId(args.id)` 得单集 URL + 序号；
2. `getStreamsForEpisode(url)`：
   - 抓单集页提取 guid；
   - 调接口 E 得 `hls_url`；
   - `buildQualityStreams` 构造四档；
   - 若构造失败，降级使用 `video.chaptersX[0].url`（单档「标准」）；
3. 每档附加 `behaviorHints: { notWebReady: false }`；
4. 返回四条流，名称写入 `name` 字段供用户区分。

### 5.4 Search 实现

央视无公开搜索 API（实测 `api.cntv.cn/search/*`、`NewVideo/search` 均返回 `path not found` 或拒绝访问），采用**本地聚合过滤**：

1. 并行加载四类数据源：纪录片全量 + 三类 yxg 各 8 页；
2. 对每条记录拼接 `title + description + actors + area + year`，转小写后 `includes(keyword)` 匹配；
3. 按 URL 去重，取前 300 条；
4. 经 catalog handler 统一分页返回。

**实测**：「海洋」→ 10 条，「西游记」→ 3 条，「汽车」→ 6 条。

### 5.5 子分类过滤

- 纪录片：`genre` 值按 id 或 name 匹配 `CATEGORIES`；
- 电视剧/动画片：`地区` 值填入 API 的 `area` 参数；
- 特别节目：`类型` 值填入 API 的 `sc` 参数；
- 过滤后数据独立缓存（key 含 filter 值）。

---

## 6. 数据结构与字段映射

### 6.1 内部 Album 对象

```js
{
  url: string,          // 专辑页 URL（必填）
  title: string,        // 标题
  poster?: string,      // 封面
  description?: string, // 简介（yxg 来源有）
  area?: string,        // 地区（yxg）
  year?: string,        // 年份（yxg）
  actors?: string,      // 主演（yxg）
  count?: string        // 集数（yxg）
}
```

### 6.2 Stremio Meta / Video / Stream

参见 5.1、5.2、5.3 节的代码片段。

---

## 7. 缓存、并发与容错

### 7.1 缓存策略

| 缓存项 | key 前缀 | TTL |
|--------|----------|-----|
| 纪录片 catalog | `catalog:v2:` | 6 小时 |
| yxg catalog | `yxg:v1:` | 6 小时 |
| 专辑 meta | `album:v2:` | 12 小时 |
| 播放流 | `streams:v2:` | 30 分钟 |
| HTTP 文本（专辑页/单集页） | `http:` | 12 小时 |

> 播放地址由 CDN 动态签发，30 分钟过期后自动重新解析。

### 7.2 并发控制

`mapLimit(items, limit, mapper)` 通用并发池：
- 纪录片栏目页抓取：并发 6；
- yxg 分页抓取：并发 4；
- 搜索聚合：并发 4；
- 单任务异常被捕获并标记为 `{ __error: true }`，不中断整体。

### 7.3 容错设计

- 单个栏目/分页抓取失败 → 返回空数组，不影响其他来源；
- 专辑页 404（源站失效条目）→ meta 返回 null，日志记录 `HTTP 404`；
- 诊断端点自检时遍历前 8 张专辑，自动跳过失效项；
- 播放流构造失败 → 降级使用旧版 chapters 字段；
- 所有 handler 外层 try/catch，异常记录堆栈并返回空结果，避免服务崩溃。

---

## 8. 配置、日志与诊断系统

### 8.1 用户配置系统（v3.4.0）

配置以 Stremio 标准路径形式写入安装链接：`/<encodeURIComponent(JSON.stringify(cfg))>/manifest.json`。`lib/config.js` 负责：

- `catalogs`：8 个 catalog 独立开关，默认全量；关闭后 manifest 不列出，catalog handler 直接返回空数组。
- `qualities`：6 组画质开关，按真实分辨率分组（稳定源 1080P/640x360/480x270；网页解密源 1080P/720P/480P 以下），stream handler 在生成代理 URL 之前过滤。
- `debug`：默认 `false`；为 `true` 时该安装链接产生的请求才写日志。
- 兼容 hyperTV 风格的 `?cfg=<base64url(JSON)>`，中间件会改写为 SDK 标准路径。

`public/configure.html` 提供勾选界面并生成安装链接、日志链接；刷新配置后需卸载重装 addon。

### 8.2 日志模块（默认关闭）

v3.4.0 起日志**默认完全关闭**：不输出终端、不写文件、不进内存缓冲。开启方式：

1. 配置页勾选 debug（按请求开启，使用 `AsyncLocalStorage` 隔离并发请求）；
2. `/api/logs?enable=1` 进程级临时开启，`?disable=1` 关闭，重启后恢复关闭；
3. 环境变量 `LOG_ENABLED=1` 启动时开启（排障用，一般不需要）。

日志模块能力：

- **级别**：TRACE / DEBUG / INFO / WARN / ERROR；`LOG_LEVEL` 只控制开启后的终端输出（默认 INFO）。
- **事项分区**：每个请求输出一条 `========= METHOD path =========` 分区标题，后续日志按 reqId 归拢。
- **内存环形缓冲**：最多 3000 条，供实时日志页增量轮询；日志页自身不写日志。
- **脱敏**：`cfg/password/token/api_key/secret` 等字段值替换为 `<redacted>`；URL 类字段完整保留。
- **序列化**：`fmt()` 控制长度与深度，`fullUrl/url/upstreamUrl/streamUrls` 等字段不截断。

### 8.3 记录内容

| 类别 | 内容 |
|------|------|
| HTTP | 完整 URL、query、IP、UA、状态码、耗时、字节数、响应摘要 |
| UPSTREAM | 每个源站接口完整 URL、HTTP 状态、字节数、耗时、缓存命中、异常堆栈 |
| CATALOG | 步骤 1/3 数据源读取、步骤 2/3 meta 生成、步骤 3/3 分页输出 |
| META | 步骤 1/3 ID 解码、步骤 2/3 专辑与分集解析、步骤 3/3 输出 |
| REDIRECT | 老旧分集 URL 的 JS 跳转链：原始 URL、最终 URL、跳数 |
| STREAM | 步骤 1/4 分集 URL、步骤 2a JS 跳转跟随、步骤 2b 播放 API、步骤 2c 档位探测；失败时输出精确原因与完整 API URL；步骤 3/4 画质过滤、步骤 4/4 代理改写 |
| H5EPROXY | m3u8 改写前后完整 URL、TS 下载字节数、wasm 解密结果与耗时 |
| ERROR | 异常消息与完整堆栈 |

### 8.4 实时日志页

`/api/logs?format=html` 提供与 hyperTv 相似的实时日志界面：事项分区、级别/关键词过滤、显示详情、暂停、清空、按序号增量轮询；未开启时显示明确指引而非空白页。JSON 接口支持 `level/limit/since/q/clear`。

### 8.5 命令行健康检查 `health.js`

逐项执行 47 项检查，失败项直接打印具体步骤与接口 URL：

1. configure 页面、manifest 版本/CORS/8 catalog/configurable；
2. 配置过滤：关闭 catalog 返回空、启用 catalog 有数据；
3. catalog 结构、ID 去重与前缀、`skip` 分页、`search` 路径；
4. meta 分集、简介长度、分集 ID 前缀；
5. stream 非空、稳定源与解密源、画质名称、画质降序、过期日期 URL 自动跟随 JS 跳转、配置过滤生效；
6. H5e m3u8 改写、TS 下载、`X-CCTV-Decrypt`、ffprobe 分辨率与标签一致；
7. 央视播放 API、4K 列表 API、yxg 列表 API；
8. 日志默认关闭、debug 开启、事项分区、UPSTREAM 完整 URL、实时日志页 HTML。

### 8.6 在线自检 `/_diagnostics`

返回 JSON 简版自检报告：manifest、纪录片/4K/yxg 数量与样本、meta 解析、搜索结果、日志状态。深度排查请用 `health.js`。

---

## 9. 配置与部署

### 9.1 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `7120`（用户运行目录） |
| `LOG_ENABLED` | 启动时是否开启日志（一般不需要） | `0` |
| `LOG_LEVEL` | 日志开启后的终端输出级别 | `INFO` |
| `LOG_DIR` | 日志目录 | `./logs` |
| `CATALOG_PAGE_SIZE` | catalog 每页条数 | `100` |
| `ADDON_HOST` | 显式指定解密代理 host | 自动取请求 host |

### 9.2 启动

```bash
cd /Users/wangqifei/Documents/stremio/stremioAddon/cctv-doc-addon
npm install
node index.js
```

### 9.3 Stremio 安装

地址：`http://<主机IP>:7120/manifest.json`

> 升级到 v3.0.0 后需**卸载旧插件并清空缓存**再重新安装，否则旧 manifest 缓存会导致新目录不显示。

---

## 10. 验证结果

| 验证项 | 结果 |
|--------|------|
| manifest | v3.4.0，默认 8 个目录（含三个 4K 独立目录），extra 含 genre/地区/类型/search/skip；声明 configurable，idPrefixes 含 `cctv.4k.` |
| 纪录片 catalog | 2018 部，首页返回 100 条（skip 分页生效） |
| 电视剧 catalog | 全部 100 条/页；地区=欧美 30 条 |
| 动画片 catalog | 100 条/页 |
| 特别节目 catalog | 类型=军事 100 条/页 |
| search | 「海洋」10 条、「西游记」3 条、「汽车」6 条 |
| meta（电视剧《爱在山海间》） | 20 集，简介 237 字 |
| stream（电视剧分集） | 4 档：超清/高清/标准/流畅 |
| 超清流可访问性 | HTTP 200，`#EXTM3U` 有效 |
| 4K catalog | 全部 87 条（电视剧 83 / 科教 4），Stremio 路径 `genre=电视剧` / `genre=科教` 过滤正确 |
| 4K meta | 《考古公开课》4K 53 集（53/53 带缩略图）；《山海经奇》4K 16 集（16/16 带缩略图）；《绝密使命》32 集 |
| 4K stream | 两档真实画质：超清 1080P 高码率（4000kbps）、高清 720P 高码率（2048kbps） |
| 诊断端点 | 四类数据源 + 4K 三类 + 搜索全部 OK |
| 配置页 | `/configure` 返回 200；catalog/画质开关可生成 `/<config>/manifest.json` 安装链接 |
| 动态 manifest | 只勾选纪录片时仅返回 `cctv_doc`，关闭的 catalog 返回空数组 |
| 画质过滤 | 只勾选 `stable_270` 时 stream 仅返回 480x270 稳定源，无网页源 |
| 画质排序 | stream 按真实分辨率降序输出，高画质（1080P/720P/640x480）排在低画质之前 |
| 过期分集 URL | `VIDE1355592894134663` 旧日期路径跟随 JS 跳转到真实页后返回 4 条 stream（修复前为 0） |
| H5e 解密代理 | m3u8 200 且分片改写为 `/h5e/ts/`；TS 200、`X-CCTV-Decrypt=ok`；ffprobe 实测分辨率与标签一致 |
| 日志系统 | 默认 `debug=false / globalEnabled=false`；debug 链接产生事项分区与 UPSTREAM 完整 URL；实时日志页 200 |
| 命令行健康检查 | `node health.js`：47 PASS / 0 FAIL / 0 SKIP（含三开关四种组合、4K meta、画质降级回归） |
| 用户运行目录代码 | 语法检查通过，临时端口 7131 端到端实测正常 |

---

## 11. 已知问题与限制

1. **源站失效条目**：少量早期专辑页返回 404 或空页（2.5KB），点开会显示 0 集。属央视源站数据问题，日志会记录 `HTTP 404 for ...`。如需在 catalog 阶段过滤，会增加首次加载时间。
2. **分类近似映射**：「人物」「时政」无独立有效栏目页，已映射到最接近栏目。
3. **搜索为本地过滤**：受限于央视无公开搜索 API，且仅覆盖已抓取页数（纪录片全量 + yxg 各 8 页），非全站实时搜索。
4. **HLS 依赖央视 CDN**：播放地址动态签发，缓存过期后需重新解析；码率档位的可用性取决于源站是否提供对应转码。
5. **4K 专辑页不可用**：接口 G 返回的 VIDA 链接实测全部 404，addon 依赖动态接口 H/I 还原分集；若该接口变更，条目会退化为 1 集。
6. **配置缓存**：配置写在安装链接中，修改勾选后必须重新生成链接并卸载重装 addon，否则 Stremio 会继续使用旧 manifest 缓存。
7. **日志默认关闭**：这是有意为之；排障需勾选 debug 或使用 `/api/logs?enable=1` 临时开启，日志仅保留最近 3000 条。
8. **合规边界**：仅供家庭个人观看，不存储/转存视频内容，请遵守相关版权规定。

---

## 12. 附录

### 12.1 关键代码位置

| 功能 | 文件:行 |
|------|---------|
| manifest 定义 | `index.js:37-69` |
| catalog handler | `index.js:110-169` |
| meta handler | `index.js:172-216` |
| stream handler | `index.js:219-246` |
| 请求日志中间件 | `index.js:279-333` |
| 诊断端点 | `index.js:341-418` |
| 栏目映射 | `lib/cctv.js:10-32` |
| yxg 配置 | `lib/cctv.js:50-80` |
| ID 编解码 | `lib/cctv.js:127-147` |
| 纪录片抓取 | `lib/cctv.js:182-210` |
| yxg 抓取 | `lib/cctv.js:216-276` |
| 搜索聚合 | `lib/cctv.js:280-313` |
| 专辑解析 | `lib/cctv.js:340-360` |
| 4K 片单抓取 | `lib/cctv.js` · `get4KCatalog` |
| 4K 完整分集解析 | `lib/cctv.js` · `get4KAlbumMeta` |
| 4K ID 编解码 | `lib/cctv.js` · `encode4KSeriesId` / `decode4KSeriesId` |
| 流构造 | `lib/cctv.js:371-409` |
| HTTP/缓存/并发池 | `lib/fetch.js` |
| 日志模块 | `lib/logger.js` |

### 12.2 依赖

```json
{ "dependencies": { "stremio-addon-sdk": "..." } }
```

> Express 由 SDK 间接提供，Node 原生 `fetch` 无需额外依赖。

---

*报告完*
