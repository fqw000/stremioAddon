
---

# 🤖 AI 助手开发 Stremio Addon 标准操作手册 (AI-SOP)

> **致 AI 助手**：当你接收到此文档时，请严格遵循以下所有规范。**禁止基于猜测编写代码**。任何数据映射必须基于探针测试的真实结果。遇到不确定的字段，必须要求用户提供探针抓包数据或官方 API 文档。

---

## 阶段零：AI 协作契约（先于一切业务规范）

1. **逐模块交付**：禁止一次性输出全量项目代码。按「探针 → adapter → resolver/matcher → 单个 handler → manifest → 缓存 → configure → health」的顺序逐模块交付；每次只改一个文件、一个函数，修改现有文件时必须给出**文件路径 + 查找上下文 + 替换代码块**，禁止顺手重构其他文件。
2. **缺信息就问，不猜**：缺信息时提出**最小必要问题集（不超过 3 个）**；涉及底层字段映射时，**没有探针结果就只输出探针脚本，不写解析代码**；报错日志不完整时，先要求完整堆栈与触发路径，禁止基于半截日志改代码。
3. **先定位，后修改**：报错时先输出「可能原因列表 + 验证方法」，用户确认后再改代码；**禁止为了“先跑通”而临时绕过 SOP**（如临时返回 `null`、临时关闭 CORS、临时跳过缓存前缀）。
4. **动手前复述红线**：每次修改涉及**缓存、Stream、ID 映射**时，先复述对应的红线条目再动手，防止长会话遗忘约束。
5. **交付前逐项自检**：每个 handler 交付前，必须回答——空结果返回的是 `[]` 还是 `null`？是否经过 `prefixKey`？是否设置了 `cacheMaxAge` / 负缓存？`idPrefixes` 是否被误用于 catalog？Stream 是否过滤了空 `url`？

> 本契约与阶段一至八的业务规范**同等效力**。契约约束「怎么干活」，业务规范约束「干什么活」。

---

## 阶段一：项目架构与基础设施

**技术栈**：GitHub（代码托管） + Vercel（运行环境） + Upstash Redis（持久化缓存）。

**运行时约束**：**全程使用 Vercel Edge Runtime**（非 Node.js Runtime）。Edge Runtime 是 V8 沙箱，不支持 `fs`、`path` 等 Node.js 内置模块。所有网络请求必须使用原生 `fetch`，并配合 `AbortController` 实现超时控制。

**Edge 资源边界（以官方文档为准）** ：

> Vercel Edge Function 的硬性时间边界是：**必须在 25 秒内开始发送响应**，之后可以流式传输数据，**流式传输总时长上限为 300 秒**；内存限制为 **128 MB**。I/O 等待不直接消耗 CPU 预算，但 `matcher.js` 中的标题清洗、拼音转换、Jaccard 计算属于**同步 CPU 操作**，应控制候选池规模（建议单次不超过 **20 个候选**），避免因同步计算拖慢首字节响应。如果匹配复杂度超出预算，应将匹配计算下沉到轻量外部服务，Edge 只负责 I/O 和缓存。

### 1. 目录结构规范（Vercel 最佳实践）

Vercel 会为 `api/` 目录下的每个文件创建一个独立的 Serverless Function。**默认推荐使用单一入口模式**，以避免创建过多函数并利用 Fluid Compute 复用实例：

```text
项目根/
├── api/
│   └── index.js              # 默认唯一入口，使用 fetch Web Standard 导出
├── public/                   # 静态资源（configure.html/css/js）
├── src/                      # 所有业务逻辑模块（必须放在 api/ 外部）
│   ├── handler/
│   │   ├── index.js          # 路由分发
│   │   ├── catalog.js        # Catalog & Search 处理
│   │   ├── meta.js           # Meta 处理
│   │   ├── stream.js         # Stream 处理
│   │   └── subtitles.js      # Subtitles 处理
│   ├── config.js             # 配置合并层
│   ├── cache.js              # L1/L2 缓存体系
│   ├── adapter.js            # 底层 API 网络请求封装
│   ├── resolver.js           # ID 双向映射核心
│   ├── matcher.js            # 多信号加权打分算法
│   └── helper.js             # 工具函数
├── health.js                 # 健康检查与回归测试脚本
└── vercel.json               # 路由重写（/configure 和 /api/index）
```

**关键说明**：
- 单一入口是**默认推荐**，不是绝对强制。如果使用新版 `@stremio-addon/sdk`（0.x），可直接使用其 `createRouter(addonInterface)`，返回标准 `Web Standard Request -> Response` 处理器，无需强制合并为单文件。
- 无论采用单入口还是多入口，都必须通过 `vercel.json` 的 `rewrites` 正确映射路由，避免产生过多冷启动实例。
- `handler/` 目录下的模块通过 `import` 被入口引用，不会被 Vercel 识别为独立函数。

### 2. Redis 共用与 APP_PREFIX 标准

所有项目共用同一个 Upstash 数据库，必须通过 `APP_PREFIX = {项目名}:{环境}` 进行隔离。

- `cache.js` 必须封装 `prefixKey(...parts)`，所有 Redis 读写必须经过此函数。
- **Edge Runtime 下 Redis 必须通过 HTTP REST 访问**，推荐 `@upstash/redis` 或直接 `fetch`。禁止在 Edge 代码中引入任何依赖 TCP 的 Redis 客户端（如 `ioredis`、`node-redis`）。
- **分布式锁**：对于一次性操作（如 Token 刷新、重大缓存清理），必须使用 Redis 分布式锁（`SET key value NX EX 60`）。即使多个 Edge 实例并发处理，也只有一个实例执行实际写操作，其余实例轮询等待结果，防止资源浪费或状态冲突。
- **锁轮询约束**：轮询等待必须设置总超时（建议不超过 **2–3 秒**），并采用指数退避（如 100 ms → 200 ms → 400 ms），避免在 Edge 内高频空转。如果超时仍未拿到锁，应降级为直接放行一次读操作，而不是无限等待。

---

## 阶段二：探针测试与数据摸底（强制前置步骤）

**操作指令**：在编写任何 `adapter.js` 解析逻辑前，**必须**先生成 `probe.js`，让用户运行并反馈真实结构。

### 探针标准要求

1. **日志完善**：打印请求 URL、耗时、HTTP 状态码、**`Content-Type`** 和**响应体大小**，避免底层 API 返回 HTML 错误页或超大 JSON 打爆 Edge 内存。
2. **结构展示**：`console.log(JSON.stringify(data.items[0], null, 2))`，展示顶层字段和数组内对象的字段名。
3. **汇总结论**：探针输出末尾，AI 必须结合结果明确指出哪个底层字段对应 Stremio 的哪个字段。

---

## 阶段三：五大核心模块映射规范

### 1. Catalog 与 Search

- **分页标准**：Stremio 的标准分页大小是 **100**。`skip` 值会是 100 的倍数。如果返回**少于 100 条**，Stremio 会认为目录结束，不再请求更多。
  - **实现建议**：`page = Math.floor(skip / 100) + 1`。如果底层 API 每页返回不足 100 条，需在适配层做**多页聚合**，凑满 100 条后再返回。
- **`extra` 参数声明**：如果 Catalog 支持搜索或分类筛选，必须在 `manifest.catalogs[].extra` 中声明：

  ```json
  "extra": [
    { "name": "search", "isRequired": false },
    { "name": "genre", "isRequired": false },
    { "name": "skip", "isRequired": false }
  ]
  ```

- **`idPrefixes` 说明**：官方文档明确 `idPrefixes` 对 `catalog` 资源不生效——catalog 请求的 `id` 是 catalog 的自定义 ID，不受 `tt` 等前缀过滤。`idPrefixes` 只影响 `meta` 和 `stream` 的路由。

### 2. Meta

- **必须字段**：`id`、`type`、`name`。
- **扩展字段**：`poster`、`background`、`description`、`releaseInfo`、`cast`、`director`、`runtime`。
- **剧集必须返回 `videos` 数组**：`[{ id: "前缀_epId", title: "第1集", season: 1, episode: 1, released: "..." }]`。
- **`behaviorHints.defaultVideoId` 的位置**：这是 **Meta Object** 的属性，**不能**出现在 Catalog 响应的 Meta Preview Object 中。
- **Stream ID 的决策逻辑**（Stremio Core 官方逻辑）：
  1. 如果 `MetaItem.preview.behavior_hints.default_video_id` 存在，用它。
  2. 如果 `default_video_id` 不存在，且 `MetaItem.videos` 存在，使用当前选中视频的 `id`。
  3. 如果既无 `default_video_id` 也无 `videos`，使用 `MetaItem.preview.id`。

### 3. Stream

- **URL 清洗**：必须使用 `url.split('#')[0]` 剥离 `#expires=xxx` 等 Hash。
- **空结果**：必须返回 `{ streams: [] }`，**不能返回 `null`**，否则客户端会报错。
- **`behaviorHints` 关键字段**：
  - **`bingeGroup`**：用于连播时自动选择同一分组，格式如 `{addonName}-{quality}`（例如 `myaddon-720p`）。`behaviorHints.group` 与 `bingeGroup` 在功能上等价，但 `bingeGroup` 是官方文档和社区更明确、更常用的字段名，**推荐统一使用 `bingeGroup`**。
  - `notWebReady`：如果 URL 不是 HTTPS 或不是 MP4 格式，必须设为 `true`。
  - `proxyHeaders`：使用时**必须同时设置** `notWebReady: true`。
- **`proxyHeaders` 客户端兼容性**：如果流依赖 `proxyHeaders` 传递鉴权头，需提示用户优先使用 Stremio Desktop / Android / iOS Lite。Stremio Web 可能丢弃这些头部，导致播放失败。必要时提供一条不带鉴权的备用流，或将该流标记为仅限支持客户端。
- **`externalUrl` 要求**：返回 `externalUrl` 时，确认该 URL 是 **HTTPS**。Stremio 远程 Addon 要求 HTTPS，非 HTTPS 的 `externalUrl` 可能被客户端拦截。
- **IP 校验流**：如果流地址绑定了请求 IP，Addon 端必须过滤，改用本地 Nuvio Provider 方案。
- **空 `url` 防御**：返回前必须检查 `stream.url` 非空，过滤掉 `url` 为空的流。

### 4. Subtitles（多级降级方案）

必须通过 `imdbId` 查询（底层 ID 需先反向映射）。降级链路：
1. L1: `trybox.app` 聚合接口
2. L2: `OpenSubtitles` API（需要 Key）
3. L3: `SubDL` API（需要 Key）

- **语言码**：必须使用 **ISO 639-2** 三位字母代码（如 `zho`、`eng`）。如果发送的码无效，Stremio 会直接显示该文本。
- **空结果**：返回 `{ subtitles: [] }`。

---

## 阶段四：ID 双向转换与多信号加权匹配（核心算法）

如果底层使用非 `tt` 编号，必须实现双向映射。

### 1. 正向映射：IMDb (`tt`) → 底层 ID

1. **元数据获取**：根据 `tt` 查 TMDB，获取 `title`、`original_title`、`cast`、`seasons`。
2. **候选标题生成**：调用 TMDB `alternative_titles`，取前 6 个纯中文或混合标题。
3. **并发搜索与去重**：使用内存 `Inflight Map` 防止多端并发重复穿透。并行用多个标题搜底层 API，合并去重候选池。
4. **多信号加权打分（`matcher.js`）** ：
   - **标题相似度**：权重 0.50。去除噪声词、转拼音、Jaccard 分词计算。
   - **演员交集**：权重 0.35。如果目标演员和候选演员交集为 0 且标题 < 0.80，**直接硬淘汰**。
   - **年份校验**：权重 0.15。**剧集优先用目标季的播出年（seasonYear）** 匹配。
   - **季数硬门槛**：如果底层标题明确标注“第二季”，而目标是第一季，**直接淘汰**。
5. **结果返回**：取归一化打分最高且大于阈值的候选，**成功缓存 7 天**。

**边界测试要求**：`matcher.js` 的单元测试至少覆盖“标题相同但季数不同”和“演员交集为 0 但标题 > 0.80”两个用例，对应硬淘汰规则。

### 2. 反向映射：底层 ID → IMDb (`tt`)

- **流程**：拿底层标题和年份去 TMDB 搜索 -> 获取 `imdb_id`。
- **兜底**：如果带年份搜不到，必须 **“去掉年份重试”**。
- **缓存**：成功缓存 7 天；失败必须缓存 **1 小时**，防止反复重试打爆 TMDB。

---

## 阶段五：缓存体系的统一性标准

缓存必须分 L1（内存 Map）+ L2（Redis），严格遵守：

1. **成功缓存**：Catalog/Meta 5–30 分钟，Stream 3 分钟，ID 映射 7 天。
2. **Negative Cache（负缓存，绝不允许负优化）** ：当 API 返回空或 403 时，**必须写入短效缓存**。例如 Stream 403 缓存 180 秒，空字幕缓存 1 小时，防止用户反复请求把源站或第三方 API 刷爆。
3. **Redis 冷却降级**：连续 3 次 Redis 超时（>500ms），触发 60 秒冷却降级为纯内存运行，不阻塞用户。
4. **Inflight 去重**：`adapter.js` 必须实现内存级 `inflight Map`，当 Stremio 瞬时并发触发同一搜索/请求时，只放行 1 个穿透底层。
5. **分布式锁**：对于一次性操作（如 Token 刷新），使用 `SET NX EX` 实现 Redis 锁，确保多实例并发时只有一个实例执行写操作。轮询等待必须指数退避并设置总超时，超时降级放行一次读操作。
6. **HTTP 缓存头**：Edge Function 返回响应时，必须设置 `Cache-Control: public, s-maxage=xxx`。
7. **`cacheMaxAge` 优先级**：Handler 返回值中的 `cacheMaxAge`（秒）会设置 `Cache-Control: max-age=$cacheMaxAge`，并**覆盖** `serveHTTP` 中设置的全局缓存时间。全局缓存只作为兜底，不要依赖全局值来控制单个资源的 TTL。
8. **`staleRevalidate` 与 `staleError`**：Handler 还可返回 `staleRevalidate`（秒）设置 `stale-while-revalidate`，`staleError`（秒）设置 `stale-if-error`。对于 Catalog 和 Meta 这类可容忍短暂陈旧的数据，合理使用 `staleRevalidate` 可以显著降低用户感知的延迟。
9. **分页缓存键**：为 `skip` 分页单独设计缓存键（如 `catalog:{id}:skip:{n}`），避免不同页共享同一个缓存导致数据错乱。

---

## 阶段六：Configure 配置页规范

必须提供完善的 Configure 页面，实现用户级自定义。

1. **配置传递**：采用 `?cfg=<base64url>` 传递 JSON 配置。
2. **配置分层**：用户配置（如 API Key、勾选的 Channel） > 部署环境变量 > 代码默认常量。
3. **UI 需求**：允许勾选/取消默认目录；允许用户手动输入自定义 Channel（逗号分隔）；允许用户覆盖 API Key。
4. **配置合并**：布尔类默认开启，用户传 `false` 才关闭；标量类用户覆盖；数组类（如黑名单）用户增量叠加。

---

## 阶段七：调试、日志与健康检查

1. **调试透传**：Stremio 客户端不显示 `console.log`。如果 Stream 失败，必须在返回的 `streams` 中构造一条“诊断流”。诊断流不要使用 `addon|...` 这种非标准 scheme，建议返回纯文本 `externalUrl`，或直接返回一条 `name: "诊断"`、`title: "⚠️ 无流，请检查配置"` 的流，不提供可播放源。
2. **统一日志**：`api/index.js` 注入 `[HH:mm:ss.SSS]` 时间戳，各模块日志必须带前缀。
3. **`health.js` 持续回归**：必须覆盖 Manifest、Catalog、Search、Meta（区分电影/剧集）、Stream、Subtitles，并验证懒加载和缓存命中率。
4. **CORS 强制要求**：**所有响应必须包含 `Access-Control-Allow-Origin: *` 头**。Stremio 无法使用不支持 CORS 的 Addon。

---

## 阶段八：代码交付与红线规范

### 1. Manifest `resources` 字段的两种合法格式

`resources` 可以是**字符串数组**，也可以是**对象数组**。对象格式 `{ name, types, idPrefixes? }` 用于为**每个资源单独指定**支持的 `types` 和 `idPrefixes`；如果使用字符串简写，则应用 Manifest 顶层的 `types` 和 `idPrefixes`。

**示例**：如果 `stream` 只支持 `movie`，而 `meta` 同时支持 `movie` 和 `series`，应使用对象数组：

```json
"resources": [
  { "name": "stream", "types": ["movie"] },
  { "name": "meta", "types": ["movie", "series"] }
]
```

不要笼统地用字符串数组声明所有资源共享同一套 `types`，除非你的 Addon 确实对所有资源支持完全相同的媒体类型。

### 2. 代码修改规范

- **禁止直接输出全量长代码**。当需要修改现有文件时，使用精准替换法：指定文件路径、提供查找的上下文、给出替换的局部代码块。
- 或者提供 Python 替换脚本，用户运行后自动将修改写入文件。
- 与阶段零契约一致：每次只改一个文件、一个函数，修改前先定位、后动手。

### 3. 红线（绝对禁止）

1. **禁止**在 ID 前缀中使用冒号 `:`。
2. **禁止**在 Edge Runtime 引入第三方运行时库（`node-fetch`、`axios` 等）。
3. **禁止**绕过统一的缓存前缀函数直接操作 Redis。
4. **禁止**在 `Meta` 接口返回调试信息。
5. **禁止**对限流接口使用 `Promise.all` 并发调用。
6. **禁止**将空结果或失败结果长期缓存（避免“负优化”）。
7. **禁止**在 Catalog 响应中设置 `behaviorHints.defaultVideoId`（它是 Meta Object 的属性）。
8. **禁止**返回 `url` 为空的 Stream 对象（必须过滤）。
9. **禁止**在不支持 CORS 的情况下部署（远程 Addon 必须 HTTPS + CORS）。
10. **禁止**在 Edge 代码顶层使用 `await` 初始化重型依赖。Edge 的初始化发生在每次冷启动，顶层 `await` 会直接推高冷启动延迟。

### 4. 发布前必须核对

- [ ] `/manifest.json` 可访问且 CORS 头正确
- [ ] `resources` 与 `types` 声明与实际能力一致；如各资源支持的媒体类型不同，已使用对象数组格式精确声明
- [ ] `idPrefixes` 无误，且未用于过滤 catalog 请求
- [ ] 所有 Handler 在空结果时返回 `{ metas: [] }` / `{ streams: [] }` / `{ subtitles: [] }` 而非 `null`
- [ ] Stream 对象已过滤 `url` 为空的条目
- [ ] 诊断流不使用非标准 scheme
- [ ] 远程部署为 HTTPS，`Access-Control-Allow-Origin: *` 存在

### 5. 社区发布（可选）

如果用户希望将 Addon 发布到社区列表，指导其通过 `https://stremio.github.io/stremio-publish-addon/index.html` 提交。

---

*AI 须知：本 SOP 为最高开发准则。每次涉及底层适配的对话，请先在心里默念一遍：**探针摸清结构，匹配绝不猜测，缓存防止反噬，IP流交本地，锁防并发冲突，CORS必须开启。***

---
