# HypeTv Stremio Addon

把 HypeTv 站点能力封装成标准 Stremio Addon：内置片库 / 自有 Xtream 账号 / M3U 列表 → 直播频道、电影、剧集目录与播放地址。

**同时接受两种 ID**：站内 ID（`htvb1v4564035`）与其他 addon 通用的 IMDb ID（`tt0133093`），manifest 的 `meta`/`stream` 已声明 `idPrefixes: [站内前缀, 'tt']`，因此可为其他 addon 提供流，并经 TMDB 映射补齐中文元数据。

## 接口探针结论（2026-11-26 新域名实测）

| 项目 | 实测结果 | Addon 处理 |
|---|---|---|
| 域名 | `hypetv.mihawkdev.com` 已下线，现为 `https://hypetvbr.com` | 全部上游 URL 使用新域名 |
| `POST /api/dev {"code":"123"}` | 200，返回 `key` 与 2 个列表 | 内置 key 默认值，配置页可覆盖 |
| `/api/lists` | 新版返回 `[]` | 保留配置页内置的列表 1 / 2 选项 |
| Xtream `get_live_streams` | 2036 个频道 | 映射为 `channel` 目录 |
| Xtream `get_vod_streams` | 43970 部电影，约 10 MB | 映射为 `movie` 目录，L1 缓存 30 分钟 |
| Xtream `get_series` | 9537 部剧集，约 5 MB | 映射为 `series` 目录，L1 缓存 30 分钟 |
| 电影播放 `/api/x/k/{key}/1/movie/-/-/{id}.mp4` | 302 跳 CDN / `video/mp4`，可播 | 默认直连；旧 `/api/x/1/...` 已 404 |
| 剧集播放 `/api/x/k/{key}/1/series/-/-/{episode_id}.mp4` | `container_extension=mp4` 时可播 | 从 `get_series_info` 组装 `videos[]` |
| 部分剧集分集 `container_extension=null` | 新站用 `.mp4` 请求返回 206 / `video/mp4`（旧站返回 nginx 欢迎页） | 按 `.mp4` 兜底生成 `videos[]` 与播放地址 |
| 内置列表直播 `live/-/-/{id}.m3u8` / `.ts` | 403，站点声明「仅部分账号开放」 | 默认关闭直播目录；开启时返回诊断流 |
| `/api/stream?u=...` | 支持任意 URL，MP4 206、M3U8 重写为代理地址 | 可选代理，解决 HTTPS/CORS/请求头 |
| `/api/fetch?u=...` | 可抓外部 M3U（86 KB 实测） | M3U 来源入口 |
| 语言参数 | 前端硬编码 `pt-BR`；后端 `?lang=zh` / `?language=zh-CN` / `Accept-Language` 均无效 | 中文元数据改由 TMDB `language=zh-CN` 提供 |
| TMDB 映射 | 站点无 ttid 查询接口；Cinemeta `/meta/{type}/{ttid}.json` 免 Key 可用 | ttid → 标准片名/年份 → 片库片名匹配；逆向用 TMDB search + external_ids |

## 本地运行

```bash
cd /Users/wangqifei/Documents/stremio/stremioAddon/hyperTv
node server.js
# http://127.0.0.1:7000/configure  → 生成配置链接
# http://127.0.0.1:7000/manifest.json
```

Stremio 桌面端：`文件 → 通过 URL 安装插件`，粘贴配置页生成的 `stremio://...` 或完整 `http://127.0.0.1:7000/manifest.json?cfg=...`（需同一台机器）。

回归检查：

```bash
node health.js                         # 默认 http://127.0.0.1:7000
node health.js https://your-domain.com # 远程部署后
```
> 日志埋点相关断言依赖冷缓存：同一进程重复跑时字幕结果会命中内存缓存，不再产生上游日志。重跑前请重启服务。

当前结果：默认配置 **78/78 通过**（manifest/CORS、目录、meta 详情字段、videos/defaultVideoId、stream 官方字段与 URL、**新版 `/api/x/k/{key}/{id}` 路径与电影/剧集 302→CDN 可访问、空扩展名分集生成 videos/播放地址（含代理模式）、debug 不注入诊断流 / 显式开启后可用**、官方路径搜索与中文搜索、字幕仅中英且走代理可下载、`subtitleLang` 真实过滤、subtitles extra 路径段、站内 ID 字幕映射、**剧集 `:S:E` 字幕、无季集兜底、站内剧集/分集 ID 字幕、query 季集**、中文海报、`idPrefixes` 含 `tt` 与顶层声明、**stream 内嵌字幕下发**、ttid 的 meta/stream 映射、debug 诊断流与诊断页、**manifest 版本与强制重新校验、中文搜索 `?search=` 兼容、默认不记录日志（debug 关闭）、未开 debug 的日志页提示、日志「事项」分区、不再重复 config 行、分区含路径/参数/配置、上游接口详情（URL/状态/耗时/字节）、日志页轮询不写日志、日志页增量/暂停/详情/事项渲染、配置页只留 debug 开关、health 日志统计**、葡语译名精确匹配、开发者码换 key）。另用本地模拟 TMDB 代理验证两条凭据链路：
- **免密 + 自定义代理**（`tmdbKeyless=true`、无 Key）：ttid meta 返回「黑客帝国 / imdb_id=tt0133093 / 中文简介/类型」，目录条目补中文。
- **自定义代理 + Key**（代理 URL 自带 `?token=...`）：中文搜索 `黑客帝国` 与 `tt0133093` 均能命中站内片源。

## 配置

配置以 base64url JSON 放在 `?cfg=` 中，不落库、不上传。字段：

```json
{
  "source": { "type": "hypetv", "listId": "1", "key": "cfc467d74225f369b541d032" },
  "catalogs": { "live": false, "vod": true, "series": true },
  "useProxy": false,
  "tmdbApiKey": "",
  "tmdbProxy": "https://api.tmdb.org/3",
  "tmdbKeyless": false,
  "language": "zh-CN",
  "enrichCatalog": true,
  "subtitleLang": "both",
  "subtitleProxy": true,
  "debug": false
}
```

**默认已内置用户提供的可用 Key 与 `https://api.tmdb.org/3`**，因此安装后 meta 详情、目录前 30 条与海报默认就是中文，无需再填 Key。留空 `tmdbApiKey` 表示沿用默认值（不会清空）。

TMDB 三种凭据模式（**路径拼接会保留代理自带查询参数，并自动补全官方域名的 `/3`**）：
1. **带 Key**：`tmdbApiKey` 填自己的 Key，`tmdbProxy` 可留默认或填自定义接口。
2. **免密代理**：`tmdbKeyless=true`，代理端内置 Key，请求不传 `api_key`；适合自建/公共免密反代。
3. **自定义代理 + Key**：`tmdbProxy` 填任意 base（如 `https://你的域名/api?token=xxx`），仍可叠加 `tmdbApiKey`；插件按 `${base}/${endpoint}` 正确拼接 `find/tt…`、`search/movie`、`movie/{id}` 等。

- `tmdbApiKey`：用户配置 > 环境变量 `TMDB_API_KEY` / `TMDB_KEY` > 空。
- `tmdbProxy`：默认 `https://api.tmdb.org/3`，支持环境变量 `TMDB_PROXY`。官方域名会自动补 `/3`；自定义代理按填写路径原样拼接。
- `tmdbKeyless`：环境变量 `TMDB_KEYLESS=1` 亦可开启。无可用 TMDB 凭据时，中文标题/简介/海报由 `src/tmdb-web.js` 解析 `www.themoviedb.org?language=zh-CN` 网页兜底（免 Key）；仍失败才回退 Cinemeta 英文。
- `language`：`zh-CN`（默认）/ `pt-BR` / `original`。
- `enrichCatalog`：TMDB 可用时给目录每页前 30 条补中文标题/简介/海报，并发 3、15 秒总超时与 7 天缓存；失败保留原站数据。TMDB 中文网页兜底遇 403/429 会自动熔断 5 分钟，避免目录页高并发时逐条刷屏、且每条白等 9 秒超时；熔断期间中文元数据仍由 TMDB API `zh-CN` 提供。
- `subtitleLang`：`both`（默认，中英都保留）/ `zh`（仅中文，简+繁）/ `en`（仅英文）。**真实过滤**：非中英语种在 `describe()` 就返回 null，配置白名单再二次过滤。返回的 `lang` 统一用 BCP-47（`zh-CN` / `zh-TW` / `en`）——客户端（Nuvio）按 BCP-47 归一语言，「简体中文(zh-CN)」偏好与 `zho` 对不上，会导致 CC 列表整片空白。
- **中文覆盖**：`zho/zht/zhe/chi/zh`、`zh-Hans/zh-Hant`、`zh-CN/zh-TW/zh-HK/zh-SG`、`cn/hk/tw`、`Chinese (Traditional)`、`繁体/简体`、`chs/cht` 全部识别；排序为 **中英双语 → 简体 → 繁体 → 英文**，每档上限 6/10/10/3 条、总数 24 条（旧版每语种 3 条，中文稍多就被裁掉）。`Bengali` 不会被 `eng` 误判。
- `subtitleProxy`：`true`（默认）时**只对 `rezesubs.com` 的文件**走同源 `/api/subtitle?u=…` 代理（缺 Referer 会 403，代理自动补 `Referer: https://core.vidzee.wtf/` 并重试一次）；OpenSubtitles 的 `subs5.strem.io` 直连即可，不再绕代理。设为 `false` 全部直连（rezesubs 可能 403）。
- `debug`：`false`（默认）。配置页只有这一个开关，它控制日志与回显：
  1. **运行日志**：只有 debug 请求才写内存缓冲、才在 `/api/logs?format=html` 里可见（关闭时日志页给出「未开启」提示，不记录任何东西）；
  2. **请求回显**：debug 请求在日志页按「事项」分区展示路径 / 参数 / 配置 / 每个上游接口的 URL、状态、耗时、响应字节，并在终端带颜色输出。环境变量 `HYPETV_DEBUG=1` 亦可开启。
- `diagnosticStream`：`false`（默认，配置页无此开关）。**诊断信息不再通过 stream 列表返回**：即使 `debug=true`，`/stream` 也不会出现「诊断信息」流。仅在 `cfg` 中显式加 `"diagnosticStream": true` 或设置环境变量 `HYPETV_DIAGNOSTIC_STREAM=1` 时，匹配失败 / 直播 403 / 字幕链路才会额外返回一条带 `/api/diagnose?d=…` 的流。诊断数据不含账号密码。
- **字幕随流下发**：`/stream` 返回的每个 stream 对象都附带 `subtitles`（官方 Stream Object 字段）。客户端只在真正开播时才请求 `/subtitles`，浏览列表时不发请求，内嵌后即使客户端不发字幕请求也能在播放器里选到中英字幕。冷启动最多等 6 秒（源站详情 → TMDB → OpenSubtitles；vidzee 只在已缓存时复用，避免拖慢首播），超时跳过、不影响 `/subtitles` 兜底。

### 运行日志

**终端默认就输出 INFO 级日志**（每个请求一段），内存缓冲始终记录最近 2000 条；开启 debug 的请求额外输出 DEBUG 明细（上游接口逐条）。每个请求被渲染成一个「事项」分区，分区内是该请求的完整链路：路径 / 参数 / 配置 → 业务步骤 → **每个上游接口的完整 URL、状态码、响应类型、响应字节、耗时** → 结果与统计：

```
========= 字幕 · GET /subtitles/movie/htvb1v4564043.json?cfg=*** =========
12:05:41.189 [INFO ] [subtitle] 开始 id=htvb1v4564043 subtitleLang=both
12:05:41.190 ========= 字幕 · ID 解析（movie htvb1v4564043） =========
12:05:41.191 [DEBUG] [upstream] GET https://hypetvbr.com/api/x/k/cfc467d7…/1/player_api.php?...&action=get_vod_info&vod_id=4564043 → 200 type=application/json resp=2.8KB 268ms [源站 API]
12:05:41.459 [DEBUG] [subtitle] 源站详情片名="Os Reis da Rua" tmdb_id=1266 o_name=Street Kings
12:05:43.140 [DEBUG] [tmdb] GET https://api.tmdb.org/3/movie/1266/external_ids?api_key=*** → 200 resp=114B 1681ms [TMDB API]
12:05:43.141 [INFO ] [subtitle] ID 解析命中 imdbId=tt0421073 via=vod-tmdb_id(1266)
12:05:43.142 ========= 字幕 · 上游查询 OpenSubtitles =========
12:05:44.472 [DEBUG] [subtitle] GET https://opensubtitles-v3.strem.io/subtitles/movie/tt0421073.json → 200 resp=28.7KB 1330ms [OpenSubtitles]
12:05:44.472 [INFO ] [subtitle] 上游返回 87 条，中英 10 条（无季集）
12:05:44.472 [INFO ] [subtitle] 过滤后 3 条 {"eng":3}（上游 87 条，白名单 zho/zht/eng）
12:05:44.480 [INFO ] [http] ← 200 subtitles subtitles=3 langs=eng imdb=tt0421073 上游=87条 795B 4047ms
12:05:44.480 ========= 完成 · 200 =========
```

- **`========= 事项 =========`**：请求进来一个分区、结束一个分区。分区标题带完整路径（中文已解码、`cfg`/`api_key` 已脱敏），分区内后续日志按 reqId 归拢，日志页渲染成带左侧紫条的分隔条，排查时按段读而不是从几百行里捞。
- **不再重复 `[config]`**：旧版每条请求都输出一行 `[DEBUG] [config] source=… lang=… logLevel=…`，信息量为零且刷屏。现在配置只出现在分区标题的详情里（勾选「显示详情」可见）。
- **终端颜色分类**：DEBUG 灰、INFO 白、WARN 黄、ERROR 红；`http` 蓝、`subtitle` 紫、`upstream`/`tmdb` 青、`catalog`/`meta`/`stream` 绿；状态码 2xx 绿 / 3xx 青 / 4xx 黄 / 5xx 红。`NO_COLOR=1` 或非 TTY 时自动退回纯文本。
- **响应统计**：请求级统计响应体字节与总耗时；上游接口统计状态、`content-type`、真实响应字节（chunked 无 `content-length` 时按克隆体量测）、耗时。

**日志页（`/api/logs?format=html&cfg=<配置>`）**：

- **必须带 debug 的 cfg**：配置页生成安装链接后，同页的「打开运行日志」链接会自动带上同一份 `cfg`。没有 debug 的链接打开只显示「调试模式未开启 + 三步开启指引」，不返回任何日志。
- **日志页自身的轮询请求完全不写日志**（`NOOP_LOGGER`），按 `since=<seq>` 增量追加，不会把业务日志刷掉；缓冲 2000 条。
- 级别下拉框在日志页里选（DEBUG+ / INFO+ / WARN+ / ERROR），配置页不再暴露日志级别。
- **暂停接收 / 继续接收**（暂停后仍可「立即刷新」）、**显示详情**（渲染 `path` / `params` / `config` / `status` / `bytes` / `elapsed` / `upstream` 等结构化字段）、**只看字幕**一键过滤、关键词搜索、清空、自动滚动；页面顶部回显本次链接的 source / 语言 / 字幕配置 / debug 状态；时间统一 UTC+8。
- `GET /api/logs?cfg=…&q=subtitle&level=debug&limit=400` 返回 JSON，支持 `since` 增量、`clear=1` 清空；debug 关闭时返回 `{ debug:false, logs: [], hint }`。
- `GET /health` 附带 `logs`（累计/缓冲条数、控制台级别）与 `tmdbWeb`（网页兜底是否处于熔断）。

**脱敏与级别**：`cfg` / `api_key` / `password` / `token` / `u` 等参数值不会出现在日志里；同一类错误（如 TMDB 网页 403）限频汇总。终端输出级别由环境变量 `LOG_LEVEL` 决定（默认 `info`，仅 debug 请求会打到终端），`NO_COLOR=1` 关闭颜色。

三种 `source`：

- `hypetv`：`{ "type": "hypetv", "listId": "1", "key": "…" }` — 站点内置列表；`key` 留空即用服务端内置值（可用环境变量 `HYPETV_KEY` 覆盖）
- `xtream`：`{ "type": "xtream", "server": "http://host:8080", "username": "u", "password": "p" }` — 自有账号，直播完整可用
- `m3u`：`{ "type": "m3u", "url": "https://.../list.m3u" }` — 经 `/api/fetch` 抓取

`useProxy=true` 时所有播放地址经 `https://hypetvbr.com/api/stream?u=...` 转发；MP4 直连更快，HLS/TS 建议保留代理。配置页会按来源自动切换直播目录默认值。

## 接口与 ID

- `GET /manifest.json?cfg=...`
- `GET /catalog/{channel|movie|series}/htv_{live|movie|series}.json`，搜索按官方协议走路径参数：`/catalog/movie/htv_movie/search=黑客帝国.json`、`/catalog/movie/htv_movie/search=Matrix&skip=100.json`；**同时兼容 `?extra=`、`?search=` / `?skip=` 等直接 query 参数**（部分 Web / TV 壳会这么发，旧版完全忽略导致中文搜索「没反应」）。搜索结果直接复用 TMDB 中文候选补标题/海报，并把富化超时压到 2.5 秒，避免整页 15 秒补强把搜索请求拖到客户端超时。
- `GET /meta/{type}/{id}.json` —— 详情合并 Xtream `get_vod_info` / `get_series_info` 的 cast/director/genres/runtime/plot 与 TMDB 中文字段；剧集返回 `videos[]` + `defaultVideoId`
- `GET /stream/{type}/{id}.json` —— `{id}` 可为站内 ID 或 `tt` 开头的 IMDb ID；`name` 为格式/画质（如 `MP4`），`title`/`description` 为线路说明，不再显示插件名
- `GET /subtitles/{movie|series}/{id}[/{extra}].json` —— 仅返回中文（`zh-CN`/`zh-TW`）与英文（`en`），双上游：OpenSubtitles v3 镜像（按 IMDb ID）+ vidzee（按 TMDB ID，`/subs/movie/{tmdb}`、`/subs/tv/{tmdb}/{s}/{e}`，中文字幕更全）。**剧集必须走 `:S:E` 路径**：`tt0903747:1:1` / `htvb1s16829:1:1`；实测 `tt0903747:1:1.json` 返回 89 条，而 `?season=1&episode=1` 与不带季集的 `tt0903747.json` 均返回 0 条。`id` 支持站内 ID、`ttid`、`ttid:S:E`、`htvb1s…:S:E`、分集 ID `htvb1e…`；剧集不带季集时自动按第 1 季第 1 集、或从 `get_series_info` 取首集兜底。按官方 SDK 支持 `extra` 路径段与 `?extra=`（含 `filename` / `videoHash` / `videoSize` / `season` / `episode`），不会把 extra 误当成 ID；客户端若把季集放在 `?season=2&episode=3`，插件会转成 `:2:3` 路径请求上游。站内 ID 优先用 `get_vod_info.tmdb_id` → TMDB `external_ids` 反查 IMDb ID，失败再退回葡语片名 / `o_name` / `filename` 片名匹配；映射结果按条目缓存 7 天，避免葡语片名冷启动拖慢字幕请求。
- `GET /api/subtitle?u=<原字幕URL>` —— 字幕代理，服务端 curl UA 转发并返回 UTF-8 SRT；上述 subtitles 返回的 URL 默认已走此代理
- `GET /api/diagnose?d=<base64url>` —— 诊断页，把匹配步骤 / TMDB 标题 / 字幕统计等信息渲染成可复制页面（仅在 debug 模式下由插件生成链接）
- `GET /api/logs?format=html&cfg=…` —— 运行日志实时查看页（**需带 debug 的 cfg**，否则只显示「未开启」提示）；`GET /api/logs?cfg=…&q=subtitle&level=debug&limit=400` 返回 JSON，支持 `since` 增量与 `clear=1` 清空（详见「运行日志」）
- `GET /search/{query}.json?type=movie|series` —— 便捷搜索入口；官方搜索仍通过 catalog 的 `extra.search` 完成，支持中文片名与 `ttid` 查询
- `GET /configure`（配置页）、`/health`（运行状态 + 日志统计 + TMDB 网页熔断状态）

### 字幕在 nuvio 中不可见的排查结论

实测定位到以下根因，均已修复：
1. **manifest 缺顶层 `idPrefixes`** —— nuvio 等客户端只读顶层字段来决定是否发起字幕请求，已补齐 `['htvb1','tt']`。
2. **`parseId` 剧集 ID 字段错位** —— `htvb1e{剧集}_{分集}_{ext}` 解析时把分集 ID 当成剧集 ID、扩展名当成分集 ID，导致剧集字幕与分集播放失效，已修正。
3. **上游链接失效** —— Vidzee 返回的 `rezesubs.com` 字幕链接一律 403（防盗链，任意 UA 均失败），已从上游移除；仅保留实测可用的 `subs5.strem.io`，并新增同源字幕代理兜底。修复后 `tt30825738` 返回 8 条字幕（2 简中 / 3 繁中 / 3 英文），全部实测下载 200。
4. **IMDb ID 映射错误导致「无片源 / 无字幕」** —— HypeTv 片库标题为葡语，旧的英文/中文片名匹配会失败，或把 `The Good Dinosaur` 误匹配到 `Mike Birbiglia: The Good Life`。现通过 TMDB `translations` 补 pt-BR / pt-PT 译名做精确匹配，模糊匹配去掉冠词/介词并要求年份一致；例如 `tt1979388` 现在正确命中 `O Bom Dinossauro`。
5. **客户端只传 `extra.filename` 时无法映射** —— 字幕接口新增文件名片名兜底，避免 nuvio 仅给文件名时解析不出 IMDb ID。
6. **`subtitleLang` 只排序不过滤** —— 旧版 `curate()` 改的是返回顺序，选「仅中文」仍返回英文、选「仅英文」仍返回中文。现改为配置白名单真实过滤：`zh→zho/zht`、`en→eng`、`both→三类`。上游 98 条 24 种语言的 `tt0816692` 实测只保留 4 条 `zht/eng`。
7. **官方 SDK 的 subtitles extra 路径段被吞进 ID** —— Stremio/Nuvio 会请求 `/subtitles/{type}/{id}/{extra}.json`，旧正则把整段当作 ID 导致解析失败返回空。现与 catalog 一样解析可选 extra 段（支持 `k=v`、`extra=<json>`、`?extra=`），meta/stream 也忽略该段不再 404。
8. **站内 ID 靠葡语片名匹配不可靠** —— HypeTv `get_vod_info.info.tmdb_id` 可直接拿到 TMDB ID，经 `/movie/{id}/external_ids` 反查 IMDb ID；`htvb1v4564044` 现稳定映射到 `tt1979388`，比葡语标题搜索准确得多。
9. **剧集字幕上游格式用错（本次实测最关键）** —— OpenSubtitles v3 剧集字幕只认 `/subtitles/series/{ttid}:{S}:{E}.json` 路径：实测 `tt0903747:1:1.json` 返回 **89 条**（7 条英文），而 `tt0903747.json?season=1&episode=1` 与不带季集的 `tt0903747.json` 均返回 **0 条**。旧实现用查询参数，导致**所有剧集字幕恒为空**。现改为 `:S:E` 路径，并支持 `htvb1s…:S:E`、分集 ID 与无季集兜底；修复后 `tt0903747:1:1`、`htvb1s16829:1:1`、`htvb1e16829_4744071_mp4` 均返回可用字幕。
10. **站内剧集 ID 冷启动过慢 + 链路不可观测** —— 葡语片名首次解析要走 TMDB API + 中文网页兜底，实测 **15 秒**，客户端字幕请求很可能超时放弃；现把「站内条目 → IMDb ID」结果按条目 key 缓存 7 天（详情页与字幕接口共享），二次请求毫秒级。同时补齐完整运行日志：默认 INFO 即可看到字幕请求是否进来、ID 解析命中路径、上游返回条数、过滤结果与代理开关；TMDB 网页 403 也改为熔断 + 限频，不再刷屏。
11. **客户端缓存旧 manifest，根本不发 `/subtitles/` 请求** —— 服务端字幕接口实测各 ID 均正常（`tt5034838` 8 条、`tt0903747:1:1` 3 条），但日志里完全没有客户端发来的字幕请求。manifest `version` 长期停在 `1.0.2` 且带 5 分钟缓存，客户端可能一直沿用安装时的旧资源声明。现 `version` 已升至 `1.0.6`、响应改为 `Cache-Control: public, no-cache, max-age=60`，**升级后必须在客户端删除并重新安装 addon**（仅重启服务不会让客户端重拉 manifest）。
12. **日志页自轮询污染 + 中文搜索 `?search=` 被忽略** —— 旧版日志页每 3 秒轮询写 4 条日志（`→`/`config`/`logs`/`←`），600 条缓冲几分钟就被刷满，真正的字幕与搜索日志被顶掉，看起来像「subtitle 没被执行」「日志刷新后丢失」；旧 `parseExtra()` 只认 `?extra=` 与路径段，客户端发 `?search=黑客帝国` 时完全忽略搜索词、返回整页 100 条目录，表现为「中文搜索没响应」。现日志页请求零写入 + 增量追加 + 2000 条缓冲，extra 三路兼容（直接 query / `?extra=` / 路径段），搜索富化超时压到 2.5 秒。
13. **日志噪声掩盖真问题** —— 旧版每条请求都打一行 `[DEBUG] [config] source=… logLevel=…`（用户实测一段日志里 20+ 条一样的内容），且默认就把 INFO/DEBUG 写进缓冲，看不出「这次请求到底调了哪些底层接口」。现改为：每个请求一个 `========= 事项 =========` 分区，分区标题带完整路径与配置，分区内是业务步骤 + 所有上游接口（源站 / TMDB / OpenSubtitles）的完整 URL、状态、响应字节、耗时；请求结束时再打一个 `完成 · 200` 分区。日志页按级别/标签上色，状态码 2xx 绿、4xx 黄、5xx 红，支持「只看字幕」。

14. **「字幕只请求了一个影片」** —— 对照客户端源码（Nuvio `SubtitleRepositoryImpl`）：字幕只在**真正开播**时请求，浏览列表/切换影片不会发请求；因此日志里只出现最后一次播放的 `/subtitles`，不是插件漏请求。为了让「没发字幕请求」的客户端也能用，`/stream` 现在把字幕直接内嵌到 stream 对象（官方 `subtitles` 字段），Nuvio 会读 `stream.subtitles` 并直接出现在字幕列表；冷启动最多等 4 秒、结果缓存 1 小时，超时就跳过、不阻塞播放。
15. **中文字幕太少 + CC 列表空白（本轮）** —— 两个原因：① 返回的 `lang` 用 ISO-639-2（`zho`/`zht`），而 Nuvio 把「简体中文」偏好归一成 `zh-CN`，`matchesLanguageCode('zho','zh-cn')` 不成立 → 内嵌与 addon 字幕全被过滤，CC 列表空白；现统一输出 `zh-CN`/`zh-TW`/`en`。② 单一上游 OpenSubtitles 中文覆盖低（`tt0421073` 上游 87 条 0 条中文），现接入 vidzee（按 TMDB ID 索引，中文明显更多），并把每语种 3 条的上限放宽到「中英双语 6 / 简体 10 / 繁体 10 / 英文 3」，排序为中英双语 → 简体 → 繁体 → 英文。vidzee 文件在 rezesubs，需要 `Referer`，代理按 host 精确转发（OpenSubtitles 直连）。

16. **片源默认不再走代理** —— 源站 `302` 到 CDN，带 `Access-Control-Allow-Origin: *` 与 `Accept-Ranges`，客户端可直连播放；代理只作为「某些客户端播不动」时的兜底开关（`useProxy` 默认 `false`）。
17. **源站换域名 + 内置列表加 key** —— 旧域名 `hypetv.mihawkdev.com` 已 NXDOMAIN，新站 `https://hypetvbr.com` 的 `/api/lists` 返回 `[]`，内置列表从 `/api/x/{id}` 改为 `/api/x/k/{key}/{id}`；旧路径实测 404。现列表/详情/播放地址统一走带 key 的新路径，key 内置默认值（来自 `POST /api/dev {"code":"123"}`），配置页/环境变量 `HYPETV_KEY` 可覆盖；manifest 升至 `1.0.6`，重新安装后生效。
18. **剧集没有播放地址** —— `htvb1s23053`（Bluey Fancy Restaurant）等新剧集的分集 `container_extension=null`，旧实现沿用旧站结论直接跳过，导致 `meta.videos=0`、`/stream` 只剩诊断流。新站实测这些分集用 `.mp4` 请求返回 `206 video/mp4`（抽样 4 个剧集均一致），现已按接口文档用 `mp4` 兜底，`videos[]` 与播放地址都会生成。
19. **默认配置不再通过 stream 返回诊断信息（本轮）** —— 旧实现把 `debug` 同时用于日志和诊断流，配置页开启 debug 看日志时，播放器 stream 列表里会多出一条「诊断信息」。现拆成独立开关 `diagnosticStream`（默认 `false`）：`debug` 只控制日志与回显，诊断流需显式开启；配置页生成的链接默认不会注入诊断流。

**排查字幕时先看日志**：用配置页生成的「打开运行日志」链接（自带 `?cfg=`，已开 debug），在客户端播放影片后按「字幕」分区查看；或直接点「只看字幕」。
- 有 `→ GET /subtitles/...` → 看 `[subtitle]` 的 `ID 解析` / `上游返回 N 条，中英 M 条`：M=0 属上游无中英字幕（如 `tt0903747:1:1` 上游 89 条但只有英文，选「仅中文」就会空）。
- 完全没有 `/subtitles/...` → 客户端没发请求，按第 11 条**删除并重新安装 addon**，并在配置页重新生成安装链接。

ttid 调用示例：`/stream/movie/tt0133093.json`、`/meta/movie/tt0133093.json`。解析链路：TMDB `find`（或 Cinemeta）拿标准片名/年份 + `translations` 葡语译名 → 与片库片名索引精确匹配，失败再要求实词高度重合且年份一致的模糊匹配 → 返回站内播放地址。默认配置匹配失败返回空数组；开启 debug 后才返回带可复制诊断链接的「诊断信息」流。字幕是否可见还取决于上游 OpenSubtitles 是否真的有该片的中英字幕，可在 debug 字幕诊断流中看到「上游 N 条 / 保留 M 条 / 语种」。

ID（仅字母数字与下划线，无冒号）：

```
htvb1l784811                 内置列表 1 的直播频道
htvb1v4564035                内置列表 1 的电影
htvb1s16829                  剧集
htvb1e16829_4744071_mp4      分集（seriesId_episodeId_ext）
tt0133093                    IMDb ID（movie / series，走映射层）
```

前缀随来源变化：`htvb{listId}` / `htvx{hash}` / `htvm{hash}`，并在 manifest 的 `meta`/`stream` 资源 `idPrefixes` 中声明。

## 工程结构（Edge Runtime 兼容）

```
api/index.js          Vercel Edge 单入口
src/config.js         配置合并与来源前缀
src/cache.js          L1 内存 + 可选 L2 Upstash REST（统一 prefixKey / inflight / 负缓存）
src/logger.js         分级日志 / 事项分区 / 终端配色 / 请求 id / 环形缓冲(2000，仅 debug 写入) / 限频汇总 / 脱敏 / NOOP_LOGGER
src/http-log.js       上游出站 HTTP 统一日志（完整 URL / 状态 / 响应类型与字节 / 耗时）
src/adapter.js        原生 fetch 适配、M3U 解析、Xtream URL 构造、代理 URL
src/resolver.js       Stremio ID 解析（站内 ID / ttid 识别）
src/tmdb.js           TMDB/Cinemeta 映射与中文元数据（双向 ID、片名索引匹配）
src/tmdb-web.js       TMDB 中文网页兜底解析（免 Key 拿中文标题/简介/海报）
src/handler/*         catalog / meta / stream / subtitles / 路由分发
public/configure.html 配置页
server.js             本地 Node 开发服务器（Edge 之外）
health.js             端到端回归
vercel.json           Vercel 路由
```

部署到 Vercel：导入本目录，`vercel --prod`；`vercel.json` 已配置 `/configure` 重写与 Edge 运行时。可选设置 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 启用 L2 缓存（大目录只走 L1，避免单值超限）。

## 已知限制

- 内置列表的直播被源站 403 限制，无法在 Addon 侧绕过；需要直播请用自有 Xtream 账号或 M3U 来源。
- 默认 Key 来自用户提供的 `api.tmdb.org`；若失效可在配置页改填自己的 Key/代理，或勾选免密模式。无凭据时走 TMDB 中文网页兜底，最后才是 Cinemeta 英文。
- 极少数条目 TMDB 本身没有中文译名时保留原站标题；目录页中文补齐覆盖每页前 30 条（并行 + 15 秒总超时），详情页始终尝试中文。
- 字幕是否有中/英资源取决于上游 OpenSubtitles v3 镜像；无对应字幕时返回空数组，插件不会返回其他语种。剧集必须带 `:S:E` 查询（不带季集时自动兜底第 1 季第 1 集）；季集查询无中英字幕时会再试一次无季集查询，多数剧集上游仍返回 0 条，属上游限制。日志里的「上游返回 N 条，中英 M 条」可直接区分是 ID 映射失败还是上游确实没有中英字幕——例如 `tt0903747:1:1` 上游 89 条但只有 7 条英文、无中文，配置 `subtitleLang=zh` 时返回空属正常。
- TMDB 缓存键包含 Key/代理身份，避免无 Key 的失败结果污染带 Key 请求；映射成功缓存 7 天、失败缓存 1 小时。
- 内置列表部分剧集的分集缺少 `container_extension`；新域名实测 `.mp4` 兜底可正常播放（206 / `video/mp4`），已不再跳过。
- 首次冷启动需拉取约 10 MB 电影 / 5 MB 剧集列表，本地约 5~10 秒；Vercel Edge 的 25 秒首字节限制下建议配置 L2 缓存或缩小目录。
- 非 HTTPS 或 HLS/TS 流的 `behaviorHints.notWebReady=true`，建议使用 Stremio Desktop / Android / iOS Lite；Web 端依赖浏览器解码能力。

接口契约以 `doc/HypeTv-接口文档-新域名20261126.md` 为准（旧域名文档仅作历史参考）。
