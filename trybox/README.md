# TryBox Stremio Addon

TryBox 影视聚合 Stremio 插件，支持 Catalog / Search / Meta / Subtitle / Stream 完整链路，兼容 `tt` IMDb ID 与 `trybox_` 内部 ID 双格式。

![Visitors](https://visitor-badge.laobi.icu/badge?page_id=fqw000.tryboxStremio&left_text=Visitors)

## 功能特性

- **Catalog 浏览**：首页、电影、剧集、热门、流行、高分、剧集精选、经典剧集，共 8 个内容目录
- **搜索**：支持中文关键词搜索，覆盖 TryBox 全量内容（可独立开关）
- **Meta 详情**：完整展示影片信息，TV 类型自动聚合剧集列表（含分季信息）
- **字幕**：仅保留中英文，自动过滤其他语言，支持 ISO 639-1 语言码映射
- **Stream 播放**：聚合 TryBox 多源链接，**自动剔除含 IP 校验的 URL**（如需完整链接，请使用配套的 Nuvio Provider）
- **双 ID 兼容**：同时响应 `trybox_{tmdbId}` 和 `tt{imdbId}`，可与 Cinemeta 等外部 Addon 联动
- **三级缓存**：L1 内存 → Upstash Redis → Vercel CDN，显著降低响应时间
- **Token 自动刷新**：基于 Supabase 的滚动刷新机制，失效时 Bark 告警

## 快速开始

### 安装到 Stremio

浏览器访问 `https://your-domain/`，自动跳转到配置页；或直接访问：

```
https://your-domain/configure
```

配置后点击"安装到 Stremio"，或复制生成的 URL 手动安装。

### 手动安装

在 Stremio 中粘贴 Manifest URL：

```
https://your-domain/manifest.json
```

带自定义配置：

```
https://your-domain/manifest.json?cfg={base64url配置}
```

## 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `rt` | Refresh Token，用于自动刷新访问凭证 | 空（使用服务端默认） |
| `at` | Access Token，优先于 Refresh Token 使用 | 空 |
| `cats` | 启用的 Catalog 列表 | `['topRated', 'movie', 'tv']` |
| `feats` | 启用的功能列表 | `['catalog', 'meta', 'search', 'subtitle', 'stream']` |
| `subLang` | 字幕首选语言 | `zh` |
| `tk` | TMDB API Key，用于 `tt → tmdb` 转换 | 空（使用服务端内置） |

**功能开关说明**：

| UI 开关 | 实际启用的 feature | 备注 |
|---------|------------------|------|
| **Catalog + Meta** | `catalog`, `meta` | **绑定**：ID 链路依赖，必须同时启用或关闭 |
| **Search** | `search` | **独立**：可单独关闭 |
| **Subtitle** | `subtitle` | 独立 |
| **Stream** | `stream` | 独立 |

## 环境变量

部署到 Vercel 时需配置：

| 变量 | 说明 | 必填 |
|------|------|------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST 地址 | 是 |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis 认证令牌 | 是 |
| `APP_PREFIX` | Redis key 前缀（如 `tryboxStream:prod`） | 是 |
| `BARK_KEY` | Bark 告警 device key | 否 |
| `TMDB_KEY` | TMDB API Key（用于 `tt` 转换） | 否 |
| `LOG_LEVEL` | 日志级别（debug/info/warn/error） | 否 |

**`APP_PREFIX` 命名规范**：

| 环境 | 建议值 |
|------|--------|
| Production | `tryboxStream:prod` |
| Preview | `tryboxStream:preview` |
| Development | `tryboxStream:dev` |

**注意**：配套的 Nuvio Provider 必须使用**相同**的 `APP_PREFIX`，才能共享 Token。

## 部署

### Vercel 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/fqw000/tryboxStremio)

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器（端口 3000）
npx vercel dev

# 健康检测
node health.js
```

### 生产部署

```bash
npx vercel --prod
```

### 绑定自定义域名（推荐）

`*.vercel.app` 在国内访问不稳定。**必须绑定自定义域名**：

1. Vercel Dashboard → 项目 → Settings → Domains → 添加域名
2. DNS 配置：
   ```
   Type: CNAME
   Name: trybox（或你想要的子域名）
   Value: vercel-cname.xingpingcn.top（优选 CNAME）
   Proxy: DNS only（如果域名在 Cloudflare）
   ```
3. 等待生效，验证：
   ```bash
   curl -sI "https://trybox.your-domain.com/manifest.json" | head -5
   ```

## 项目结构

```
tryboxStremio/
├── api/
│   └── index.js              # Vercel Edge Function 入口
├── public/
│   ├── configure.html        # 配置页面
│   ├── configure.css         # 配置页样式（Apple 风格）
│   └── configure.js          # 配置页交互逻辑
├── src/
│   ├── constants.js          # 常量定义（URL、TTL、映射表）
│   ├── config.js             # 配置合并（?cfg= 解码 + 环境变量）
│   ├── cache.js              # 三级缓存（L1 内存 + Upstash + CDN）
│   ├── token.js              # Token 管理（滚动刷新 + Bark 告警）
│   ├── tmdb.js               # TMDB 辅助（tt → tmdb 转换）
│   ├── decode.js             # TryBox t/p/k/v/a 结构解码
│   ├── payload.js            # 请求 payload 构建
│   ├── headers.js            # 请求头构建（API / Stream 分离）
│   ├── http.js               # HTTP 客户端（4xx 不重试）
│   ├── logger.js             # 分级日志
│   ├── manifest.js           # Stremio Manifest 动态生成
│   ├── handler.js            # 路由分发器
│   └── handler/
│       ├── catalog.js        # Catalog + Search + Genre
│       ├── meta.js           # Meta 详情 + 剧集列表
│       ├── subtitle.js       # 字幕（仅中英文）
│       └── stream.js         # Stream（剔除 IP 校验链接）
├── health.js                  # 健康检测脚本（34 项测试）
├── vercel.json
└── package.json
```

## ID 体系说明

本项目涉及两套 ID：

| ID 类型 | 格式 | 用途 |
|---------|------|------|
| **TryBox ID** | `trybox_{tmdbId}` | Catalog / Meta / Stream 内部链路 |
| **IMDb ID** | `tt{imdbId}` | 与外部 Addon 联动、字幕接口 |

**双 ID 支持**：
- Catalog 和 Meta 只响应 `trybox_` 前缀（保持自有中文元数据）
- **Stream 和 Subtitle 响应 `trybox_` 和 `tt` 两种前缀**
- 收到 `tt` 时，通过 TMDB `find` API 转换为 `tmdbId`（缓存 7 天）

**联动效果**：用户从 Cinemeta 进入详情页时，Stremio 会用 `tt` ID 请求 Stream 和 Subtitle，本插件可正常响应，实现流播放和字幕加载。

## 缓存策略

| 数据 | L1 内存 | Redis | CDN |
|------|---------|-------|-----|
| Catalog | 60s | 5 分钟 | 5 分钟 |
| Meta | 60s | 30 分钟 | 30 分钟 |
| Episodes | 60s | 30 分钟 | — |
| Search | 60s | 10 分钟 | 5 分钟 |
| Subtitle | 60s | 10 分钟 | 5 分钟 |
| Stream（成功） | 60s | 3 分钟 | 1 分钟 |
| Stream（负面） | — | 5 分钟 | — |
| IMDb 映射 | 1 天 | 7 天 | — |

**Redis 冷却降级**：连续 3 次失败后进入 60 秒冷却，期间只用 L1 缓存。

## 健康检测

```bash
# 本地
node health.js

# 生产
BASE_URL=https://your-domain node health.js

# 跳过慢测试（Stream / Subtitle）
SKIP_SLOW=1 node health.js
```

检测覆盖 **34 项**：

- **Manifest**：默认配置、资源完整性、功能开关（5 项）
- **Catalog**：8 个 catalog × 各自的 type（10 项）
- **Search**：3 个中文关键词（3 项）
- **Genre**：4 个组合（4 项）
- **Meta**：movie + series（2 项）
- **Subtitle**：movie + series（2 项）
- **Stream**：movie + series（2 项）
- **tt ID**：manifest 声明、stream/subtitle 双格式（5 项）
- **Debug**：健康端点（1 项）

## 与 Nuvio Provider 联动

本项目配套 [TryBox Nuvio Provider](https://github.com/fqw000/tryboxStream-provider)，二者**共享同一份 Upstash Redis**：

- **Addon 是 Token 主管理者**：负责完整的三级刷新和 Bark 告警
- **Provider 是 Token 消费者**：优先从 Redis 读，读到无效才刷新并写回
- **两者 `APP_PREFIX` 必须一致**

**差异**：
- **Addon**：剔除含 IP 校验的 Stream 链接（避免在 Stremio 客户端播放失败）
- **Provider**：保留全部链接（Nuvio 支持携带 IP 的请求）

## 常见问题

**Q：为什么访问根路径 `/` 会跳转到 `/configure`？**

A：浏览器访问 `/` 时，根据 `Accept: text/html` 头 302 跳转到配置页。Stremio 客户端访问 `/` 时（`Accept: application/json`）仍返回 manifest。

**Q：Token 失效了怎么办？**

A：Addon 会依次尝试：内存 → 用户配置 → Redis → refresh_token 刷新 → 旧 access_token 刷新。全部失败时发送 Bark 告警。管理员需要手动更新 Redis 里的 Token。

**Q：如何手动更新 Token？**

A：参见配套的 `tokenAcquistionFlow.sh` 脚本，或参考：
```bash
curl -s -X POST "https://saichcuwzbncuqnqhuul.supabase.co/auth/v1/token?grant_type=refresh_token" \
  -H "Content-Type: application/json" \
  -H "apikey: {SUPABASE_ANON}" \
  -d '{"refresh_token":"你的refresh_token"}'
```

**Q：为什么 Stream 只返回 2 条，Provider 返回 11 条？**

A：Addon 剔除了含 `IP=` 参数的 HLS 链接（Stremio 客户端可能播放失败），只保留无 IP 校验的 RAW 链接。Provider 不剔除。

**Q：`tt` 转换失败怎么办？**

A：检查 `TMDB_KEY` 是否配置。如果失败，可能的原因：
- TMDB API 在国内不可达（需要代理或自建中转）
- TMDB API 限流
- 该 IMDb ID 在 TMDB 中没有对应记录

## 技术栈

- **运行时**：Vercel Edge Function（V8 Isolate）
- **缓存**：Upstash Redis（REST API）
- **部署**：Vercel
- **依赖**：零运行时第三方依赖（纯 Web 标准 API）

## License

MIT