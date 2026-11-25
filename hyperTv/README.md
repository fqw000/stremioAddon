# HypeTv Stremio Addon

把 HypeTv 站点能力封装成标准 Stremio Addon：内置片库 / 自有 Xtream 账号 / M3U 列表 → 直播频道、电影、剧集目录与播放地址。

**同时接受两种 ID**：站内 ID（`htvb1v4564035`）与其他 addon 通用的 IMDb ID（`tt0133093`），manifest 的 `meta`/`stream` 已声明 `idPrefixes: [站内前缀, 'tt']`，因此可为其他 addon 提供流，并经 TMDB 映射补齐中文元数据。

## 接口探针结论（2026-11-25 实测）

| 项目 | 实测结果 | Addon 处理 |
|---|---|---|
| `/api/lists` | 2 个内置列表 | 配置页动态加载 |
| Xtream `get_live_streams` | 2036 个频道 | 映射为 `channel` 目录 |
| Xtream `get_vod_streams` | 43970 部电影，约 17 MB | 映射为 `movie` 目录，L1 缓存 30 分钟 |
| Xtream `get_series` | 9537 部剧集，约 10 MB | 映射为 `series` 目录，L1 缓存 30 分钟 |
| 电影播放 `/api/x/1/movie/-/-/{id}.mp4` | 206 / `video/mp4`，可播 | 直连或经 `/api/stream` 代理 |
| 剧集播放 `/api/x/1/series/-/-/{episode_id}.mp4` | `container_extension=mp4` 时可播 | 从 `get_series_info` 组装 `videos[]` |
| 部分剧集分集 `container_extension=null` | 源站返回 nginx 欢迎页 | 跳过该分集，避免无效流 |
| 内置列表直播 `live/-/-/{id}.m3u8` / `.ts` | 403，站点声明「仅部分账号开放」 | 默认关闭直播目录；开启时返回诊断流 |
| `/api/stream?u=...` | 支持任意 URL，MP4 206、M3U8 重写为代理地址 | 可选代理，解决 HTTPS/CORS/请求头 |
| `/api/fetch?u=...` | 可抓外部 M3U（86 KB 实测） | M3U 来源入口 |
| 语言参数 | 前端硬编码 `pt-BR`；后端 `?lang=zh` / `?language=zh-CN` / `Accept-Language` 均无效 | 中文元数据改由 TMDB `language=zh-CN` 提供 |
| TMDB 映射 | 站点无 ttid 查询接口；Cinemeta `/meta/{type}/{ttid}.json` 免 Key 可用 | ttid → 标准片名/年份 → 片库片名匹配；逆向用 TMDB search + external_ids |

## 本地运行

```bash
cd /Users/wangqifei/Documents/stremio/stremioAddon/hyperTvz
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

当前结果：默认配置 **54/54 通过**（manifest/CORS、目录、meta 详情字段、videos/defaultVideoId、stream 官方字段与 URL、官方路径搜索与中文搜索、字幕仅中英且走代理可下载、`subtitleLang` 真实过滤、subtitles extra 路径段、站内 ID 字幕映射、**剧集 `:S:E` 字幕、无季集兜底、站内剧集/分集 ID 字幕**、中文海报、`idPrefixes` 含 `tt` 与顶层声明、ttid 的 meta/stream 映射、debug 诊断流与诊断页、**运行日志接口 / 字幕链路埋点 / 日志查看页 / health 日志统计**、葡语译名精确匹配、真实播放）。另用本地模拟 TMDB 代理验证两条凭据链路：
- **免密 + 自定义代理**（`tmdbKeyless=true`、无 Key）：ttid meta 返回「黑客帝国 / imdb_id=tt0133093 / 中文简介/类型」，目录条目补中文。
- **自定义代理 + Key**（代理 URL 自带 `?token=...`）：中文搜索 `黑客帝国` 与 `tt0133093` 均能命中站内片源。

## 配置

配置以 base64url JSON 放在 `?cfg=` 中，不落库、不上传。字段：

```json
{
  "source": { "type": "hypetv", "listId": "1" },
  "catalogs": { "live": false, "vod": true, "series": true },
  "useProxy": true,
  "tmdbApiKey": "",
  "tmdbProxy": "https://api.tmdb.org/3",
  "tmdbKeyless": false,
  "language": "zh-CN",
  "enrichCatalog": true,
  "subtitleLang": "both",
  "subtitleProxy": true,
  "debug": false,
  "logLevel": "info"
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
- `subtitleLang`：`both`（默认，中英都保留）/ `zh`（仅中文，简+繁）/ `en`（仅英文）。**真实过滤**：非中英语种在 `langOf()` 置空，配置白名单再二次过滤；`zh` 只返回 `zho`/`zht`，`en` 只返回 `eng`，`both` 返回三类，每种最多 3 条。上游所有其他语种（葡语/德语/西语等）一律不返回。`zht`/`zh-tw` 归繁中，`zho`/`chi`/`zh`/`zhe`（简中双语）归简中；`en-US`/`English (US)` 归英文，`Bengali` 不会被 `eng` 误判。
- `subtitleProxy`：`true`（默认）时字幕 URL 走 addon 同源 `/api/subtitle?u=…` 代理，服务端用 curl UA 转发，规避 nuvio 等客户端的 UA / 防盗链 403；设为 `false` 则直连上游。实证 OpenSubtitles 的 `subs5.strem.io` 直连各 UA 可用，而 Vidzee 的 `rezesubs.com` 一律 403，已从上游移除。
- `debug`：`false`（默认）时不返回任何诊断流；配置页勾选「开发调试模式」后，匹配失败 / 直播 403 / 字幕链路会额外返回一条「诊断信息」流，`description` 与 `externalUrl` 均含 `/api/diagnose?d=…` 链接，可直接复制反馈。环境变量 `HYPETV_DEBUG=1` 亦可开启。诊断数据不含账号密码。
- `logLevel`：`info`（默认）/ `debug` / `warn` / `error`。控制台输出遵循环境变量 `LOG_LEVEL`（默认 `info`）；**任何级别的日志都会写入内存缓冲**，可在 `/api/logs?format=html` 查看，不受控制台级别限制。配置页选 `debug` 或勾选「开发调试模式」时，该请求会在终端强制输出完整链路（含字幕请求、IMDb ID 解析、上游返回条数）。

### 运行日志

插件对每个请求都记录「进入 → 命中资源 → 耗时 → 结果条数」，并对字幕链路做逐步埋点，**默认 INFO 级别无需开启 debug 即可在终端看到字幕是否被执行**：

```
[02:12:18.723] [INFO ] [http] (zbb8lj) → GET /subtitles/series/tt0903747:1:1.json
[02:12:18.723] [INFO ] [subtitle] (zbb8lj) 开始 type=series id=tt0903747:1:1 subtitleLang=both
[02:12:18.723] [INFO ] [subtitle] (zbb8lj) ID 解析 imdbId=tt0903747 via=ttid:S:E season=1 episode=1
[02:12:18.942] [INFO ] [subtitle] (zbb8lj) 上游返回 89 条，中英 7 条（季集 :1:1）
[02:12:18.942] [INFO ] [subtitle] (zbb8lj) 过滤后 3 条 [eng]（白名单 zho/zht/eng）
[02:12:18.942] [INFO ] [subtitle] (zbb8lj) 完成 id=tt0903747:1:1 返回 3 条字幕，代理=true
[02:12:18.943] [INFO ] [http] (zbb8lj) ← 200 subtitles subtitles=3 221ms
```

- `GET /api/logs?format=html` —— 浏览器实时查看页（3 秒自动刷新、级别过滤、关键字搜索、清空），排查客户端字幕时不必一直盯终端；`GET /api/logs?q=subtitle&level=debug&limit=400` 返回 JSON，支持 `since` 增量、`clear=1` 清空。
- `GET /health` 会附带 `logs`（累计/缓冲条数、控制台级别）与 `tmdbWeb`（网页兜底是否处于熔断）。
- 日志统一脱敏：`cfg` / `api_key` / `password` / `token` / `u` 等参数值不会出现在日志里；同一类错误（如 TMDB 网页 403）限频汇总，不会刷屏。
- 服务端全局开启详细日志：`LOG_LEVEL=debug node server.js`；也可临时请求 `/api/logs?logLevel=debug`（不影响其他请求的配置）。

三种 `source`：

- `hypetv`：`{ "type": "hypetv", "listId": "1" }` — 站点内置列表
- `xtream`：`{ "type": "xtream", "server": "http://host:8080", "username": "u", "password": "p" }` — 自有账号，直播完整可用
- `m3u`：`{ "type": "m3u", "url": "https://.../list.m3u" }` — 经 `/api/fetch` 抓取

`useProxy=true` 时所有播放地址经 `https://hypetv.mihawkdev.com/api/stream?u=...` 转发；MP4 直连更快，HLS/TS 建议保留代理。配置页会按来源自动切换直播目录默认值。

## 接口与 ID

- `GET /manifest.json?cfg=...`
- `GET /catalog/{channel|movie|series}/htv_{live|movie|series}.json`，搜索按官方协议走路径参数：`/catalog/movie/htv_movie/search=黑客帝国.json`、`/catalog/movie/htv_movie/search=Matrix&skip=100.json`；同时兼容 `?extra=`。
- `GET /meta/{type}/{id}.json` —— 详情合并 Xtream `get_vod_info` / `get_series_info` 的 cast/director/genres/runtime/plot 与 TMDB 中文字段；剧集返回 `videos[]` + `defaultVideoId`
- `GET /stream/{type}/{id}.json` —— `{id}` 可为站内 ID 或 `tt` 开头的 IMDb ID；`name` 为格式/画质（如 `MP4`），`title`/`description` 为线路说明，不再显示插件名
- `GET /subtitles/{movie|series}/{id}[/{extra}].json` —— 仅返回中文（`zho`/`zht`）与英文（`eng`），上游 OpenSubtitles v3 镜像。**剧集必须走 `:S:E` 路径**：`tt0903747:1:1` / `htvb1s16829:1:1`；实测 `tt0903747:1:1.json` 返回 89 条，而 `?season=1&episode=1` 与不带季集的 `tt0903747.json` 均返回 0 条。`id` 支持站内 ID、`ttid`、`ttid:S:E`、`htvb1s…:S:E`、分集 ID `htvb1e…`；剧集不带季集时自动按第 1 季第 1 集、或从 `get_series_info` 取首集兜底。按官方 SDK 支持 `extra` 路径段与 `?extra=`（含 `filename` / `videoHash` / `videoSize`），不会把 extra 误当成 ID。站内 ID 优先用 `get_vod_info.tmdb_id` → TMDB `external_ids` 反查 IMDb ID，失败再退回葡语片名 / `o_name` / `filename` 片名匹配；映射结果按条目缓存 7 天，避免葡语片名冷启动拖慢字幕请求。
- `GET /api/subtitle?u=<原字幕URL>` —— 字幕代理，服务端 curl UA 转发并返回 UTF-8 SRT；上述 subtitles 返回的 URL 默认已走此代理
- `GET /api/diagnose?d=<base64url>` —— 诊断页，把匹配步骤 / TMDB 标题 / 字幕统计等信息渲染成可复制页面（仅在 debug 模式下由插件生成链接）
- `GET /api/logs?format=html` —— 运行日志实时查看页；`GET /api/logs?q=subtitle&level=debug&limit=400` 返回 JSON，支持 `since` 增量与 `clear=1` 清空（详见「运行日志」）
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
src/logger.js         分级日志 / 请求 id / 内存环形缓冲 / 限频汇总 / 脱敏
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
- 内置列表部分新剧集的分集缺少 `container_extension`，源站播放地址返回 HTML，已跳过；Older 剧集（如 16829）可正常播放。
- 首次冷启动需拉取 17 MB 电影 / 10 MB 剧集列表，本地约 5~10 秒；Vercel Edge 的 25 秒首字节限制下建议配置 L2 缓存或缩小目录。
- 非 HTTPS 或 HLS/TS 流的 `behaviorHints.notWebReady=true`，建议使用 Stremio Desktop / Android / iOS Lite；Web 端依赖浏览器解码能力。

接口契约参考同目录的 `HypeTv-接口文档.md` 与 `HypeTv-列表请求curl.md`。
