# HypeTv 数据接口文档

> 来源站点：`https://hypetv.mihawkdev.com`
> 整理时间：2026-11-24
> 整理方式：前端 JS 逆向（`assets/index-gyN57UV8.js`，485KB）+ 接口实测（curl）
> 说明：本文档记录的是该站点**前端实际调用**的接口契约。后端实现未开源，参数与响应结构来自逆向与实测，标注「实测」的条目均已用真实请求验证。

---

## 1. 整体架构

数据接口分三类：

| 类别 | 作用 | 路径前缀 |
|---|---|---|
| **转发代理** | 把外部流媒体/图片/列表 URL 编码进 `?u=` 由后端转发，突破 CORS 与 HTTPS 混合内容限制 | `/api/fetch`、`/api/stream`、`/api/img`、`/api/x/{id}` |
| **元数据增强** | 基于 TMDB 等数据源提供海报、相似推荐、预告片、剧情跳过点、评分、演职员等 | `/api/discover` 等 |
| **账户与设备** | Bearer Token 鉴权，多设备配对与远程控制 | `/api/conta/*` |

**统一约定**

- Base URL：`https://hypetv.mihawkdev.com/`（前端用 `new URL(path, document.baseURI)` 解析）
- 响应编码：`application/json;charset=utf-8`（代理类除外，透传目标 Content-Type）
- CORS：`access-control-allow-origin: *`，并暴露 `content-length, content-range, accept-ranges, content-type`
- 错误格式：`{ "error": "葡语错误信息" }`
- 认证：元数据/代理接口无需鉴权；账户接口用 `Authorization: Bearer <token>`

### 1.1 代理 URL 构造规则

```
api/{kind}?u={encodeURIComponent(目标URL)}&ua={User-Agent}&ref={Referer}&live=1
```

- `kind`：`fetch`（列表/文本）、`stream`（视频流）、`img`（图片）
- `u`：必填，目标地址
- `ua` / `ref`：可选，透传给源站的请求头（来自 M3U 的 `#EXTVLCOPT` 或 URL query）
- `live=1`：直播流标记

前端调度逻辑（`Ni()`）：**先直连、失败再走代理**。白名单域名（`image.tmdb.org`、`cdn.jsdelivr.net`、`upload.wikimedia.org`、`thumb.wikimedia.org`）直接请求；预处理时会嗅探返回内容，把错误 HTML（如 `INVALID_CREDENTIALS`、`EXPIRED`、`BANNED`、`MAX_CONNECTIONS`）转成葡语错误提示。

---

## 2. 端到端业务流程：片名 → 影片元数据 → 播放地址

> 这是理解整个接口体系的关键章节。**先明确一个反直觉的事实**：元数据接口（TMDB 系列）与播放地址**没有直接关系**——元数据的作用是「装饰」和「匹配」，真正的播放地址来自用户自己添加的 M3U/Xtream 列表。整条链路如下：

```
[用户添加列表] ──①──> [片库: name + play.url]  ← 播放地址的唯一来源
                            │
      用户输入片名搜索 ──②──>│ (纯前端匹配，无请求)
                            │
                            ├──③──> [元数据接口: 海报/评分/相似/预告/跳过点/系列]  ← 按 name 查询
                            │
                            └──④──> [播放: play.url → /api/stream 代理 → hls.js/mpegts.js]
```

### 步骤①：片库建立 —— 拿到「片名 + 播放地址」的绑定

用户添加列表有两种方式，二者都产出统一的条目结构 `{key, kind, name, group, logo, play:{url, alt, ...}}`：

**方式 A：M3U 列表**

请求：`GET /api/fetch?u={列表URL}`，返回 M3U 文本（见 3.1）。前端 `ba()` 逐行解析，`ja()` 组装。逆向得到的产出结构：

```js
// 单条直播/电影条目
{
  key: "1001Noites.br@SD",        // 由 URL 生成的稳定 key
  kind: "live" | "movie" | "series",
  name: "1001 Noites (480p)",     // ← 片名（来自 #EXTINF Rest）
  group: "Shop",                  // 来自 group-title / #EXTGRP
  logo: "https://i.imgur.com/...",// 来自 tvg-logo
  tvgId: "1001Noites.br@SD",      // 来自 tvg-id，供 EPG 用
  play: {
    url: "https://.../1001noites.m3u8", // ← 播放地址（#EXTINF 下一行）
    title: "1001 Noites (480p)",
    subtitle: "Shop",
    live: true,
    headers: { ua: "...", ref: "..." }  // 来自 #EXTVLCOPT
  }
}
```

M3U 解析规则（`#EXTINF` 属性 → 字段）：

| M3U 标签/属性 | 映射到字段 | 说明 |
|---|---|---|
| `#EXTINF` 后的文本 | `name` | 片名，为空时回退 `tvg-name`、再回退 URL 末段 |
| `tvg-id` | `tvgId` | EPG 匹配键 |
| `tvg-logo` | `logo` | 台标/海报 |
| `group-title` / `#EXTGRP` | `group` | 分类，空值为「Sem categoria」 |
| `#EXTVLCOPT:http-user-agent` | `headers.ua` | 播放时透传 |
| `#EXTVLCOPT:http-referrer` | `headers.ref` | 播放时透传 |
| `url-tvg` / `x-tvg-url` | `epgUrl` | EPG 源地址 |

剧集条目由 `ja()` 按「分组 + 规范化剧名」聚合成 `series`，其 `series.episodes[]` 每集都带独立的 `play.url`。

**方式 B：Xtream Codes 列表**

用户输入 `http://servidor/get.php?username=…&password=…`，`Sa()` 解析出 `{server, username, password}`，随后：

```
GET {server}/player_api.php?username={u}&password={p}&action=get_live_streams   → 直播
GET {server}/player_api.php?username={u}&password={p}&action=get_vod_streams    → 电影
GET {server}/player_api.php?username={u}&password={p}&action=get_series         → 剧集
GET {server}/player_api.php?username={u}&password={p}&action=get_live_categories → 分类
```
（这些请求同样经 `Ni()` 判断是否要加 `/api/fetch?u=` 代理前缀）

播放地址构造规则（`Da.url()` + `section()`）：

| 类型 | 播放地址模板 | alt 备用 |
|---|---|---|
| 直播 | `{server}/live/{u}/{p}/{stream_id}.{m3u8\|ts}` | 另一格式（m3u8↔ts） |
| 电影 | `{server}/movie/{u}/{p}/{stream_id}.{container_extension}` | 无 |
| 剧集 | `{server}/series/{u}/{p}/{episode_id}.{container_extension}` | 无 |

`set/series/movie` 的 `user/password` 都做了 `encodeURIComponent`；直播格式优先 `m3u8` 还是 `ts` 由 `account()` 读 `user_info.allowed_output_formats` 决定。

剧集详情另请求（点开某部剧时）：
```
GET {server}/player_api.php?username={u}&password={p}&action=get_series_info&series_id={id}
```
返回 `episodes` 按季/集排序，每集 `{season, episode, title, play:{url,...}}`。
电影详情：`action=get_vod_info&vod_id={id}`；EPG 短指南：`action=get_short_epg&stream_id={id}&limit=4`。

### 步骤②：用户输入片名 —— 纯前端匹配，不产生请求

搜索框（`placeholder:"Buscar filmes, séries e canais"`）的输入是本地过滤：`Pi()` 做 NFD 去音标 + 小写归一化，配合 FNV-1a 哈希（`Fi()`）建索引。这一步**不调用任何接口**。

### 步骤③：片名 → 影片元数据 —— 按 `name` 查询增强服务

这是元数据接口的主战场。**前端把片名（及可选的 year、tmdb）作为查询参数**，各接口各自返回一类元数据。以下均为实测：

| 接口 | 用片名做什么 | 请求示例 | 返回（实测摘要） |
|---|---|---|---|
| `GET /api/art` (POST) | 按片名查海报/背景 | `{"items":[{"name":"The Matrix","year":"1999","kind":"movie"}]}` | `{"results":[{"image":"…w342/lDqMDI3x…jpg","backdrop":"…w780/tlm8…jpg"}]}` |
| `GET /api/similar` | 按片名找相似推荐 | `?kind=movie&name=The%20Matrix` | `{"titles":[{"title":"O Exterminador do Futuro: Gênesis","original":"Terminator Genisys","year":"2015"},…]}` |
| `GET /api/trailer` | 按片名找预告片 | `?kind=movie&name=The%20Matrix` | `{"youtube":"FVI84Dfx2-I"}` |
| `GET /api/ratings` | 按片名找评分 | `?kind=movie&name=The%20Matrix&year=1999&tmdb=603&d=0` | `{"ratings":null}` |
| `GET /api/skip` | 按片名+时长找跳过点 | `?kind=movie&name=The%20Matrix&d=0` | `{"segments":{"credits":{"start":7765,"end":8152.1}}}` |
| `GET /api/saga` | 按片名找系列电影 | `?name=x` | `{"saga":{"name":"X: Coleção","parts":[…3 部]}}` |
| `GET /api/pessoa` | 按演员名+角色找人物 | `?name=x&role=at` | `{"person":{"name":"X","photo":"…","credits":[…]}}` |
| `POST /api/airing` | 按片名找最新播出集 | `{"items":[{"name":"…","year":"…"}]}` | `{"results":[{"last":{…}},{"next":{…},"last":{…}}]}` |
| `GET /api/discover` | 预置片单（无需片名） | 无参数 | `{"rows":[{"titles":[{"title":"A Odisseia","original":"The Odyssey","year":"2026"},…]}]}` |

**关键：`rs()` 匹配逻辑**（逆向）——把元数据返回的 `titles[]` 片名与本地片库条目做匹配，才把「推荐片名」变成「可点击播放的本地条目」：

```js
function rs(titles, catalog, exclude, limit=20) {
  // 归一化两边片名（NFD 去音标 + 小写），建立 片名→条目 的 Map
  // 对每个推荐 title：用 title / original 两种名字查 Map
  // 年份容差：|本地year - 推荐year| <= 1 才认可
  // 匹配成功 → 返回本地条目（带 play.url），排除自身，凑满 limit 个
}
```

也就是说：`discover` / `similar` 给出的是**纯名字**，前端用 `rs()` 把它们和本地片库里 `{name + play.url}` 的条目对上，才能出现「点推荐→播放」。若本地片库没有这部片，推荐就只是文字，不可播放。`us()` 进一步要求匹配数 ≥ 4（排行榜 ≥ 10，`ss=10`）才展示该推荐行。

### 步骤④：播放地址 → 实际拉流

从条目里取出 `play.url`，前端 `Vl()` 生成**候选地址列表**（按引擎与直连/代理排列），再逐个尝试（`Hl()`）：

```
候选构造 Vl(play):
  for url in [play.url, ...play.alt]:
    engine = zl(url) 判断：
      ?output=hls/m3u8 或 .m3u8      → "hls"
      ?output=ts/mpegts 或 .ts/.mts  → "mpegts"
      .mp4/.mkv/.webm/...            → "native"
      未知且直播 → 尝试 [mpegts, hls]；未知且点播 → [native, mpegts]
    为每个 engine 生成：
      - 直连候选（若可直连）
      - 代理候选 → /api/stream?u={url}&ua={}&ref={}&live=1
```

**实测**：`GET /api/stream?u=https%3A%2F%2F…%2Fbr.m3u`（带 `ua/ref` 同理）→ `200`，`content-type: application/vnd.apple.mpegurl`。

播放器引擎（`Hl()` 逆向）：

| engine | 加载方式 | 关键配置 |
|---|---|---|
| `hls` | 动态 `import('./hls-D6a35TnA.js')`（hls.js） | `enableWorker:true, liveSyncDurationCount:4, manifestLoadingTimeOut:8000, manifestLoadingMaxRetry:0, levelLoadingMaxRetry:4` |
| `mpegts` | 动态 `import('./mpegts-C6cdt3u0.js')`（mpegts.js） | `isLive, liveSync, stashInitialSize:1MB, liveSyncTargetLatency:10` |
| `native` | 原生 `<video>` | 直接 `canPlayType` 检测 |

**回退策略**：候选按顺序尝试，直播提示「Sintonizando…」，失败依次提示「Tentando pelo proxy…」「Tentando de outro jeito…」；点播在播放失败时会把主地址也改走 `/api/stream` 代理重试。HLS 遇 `MEDIA_ERROR` 会 `recoverMediaError()` 恢复一次，之后 fatal 错误按网络/格式分别提示。

### 业务流程总结表

| 阶段 | 输入 | 接口请求 | 返回/产出 | 是否网络请求 |
|---|---|---|---|---|
| ① 建片库 | 列表 URL 或 Xtream 凭据 | `GET /api/fetch?u=…` 或 `player_api.php?action=…` | M3U 文本 / Xtream JSON → `{name, play.url}[]` | 是 |
| ② 搜索片名 | 用户输入关键字 | 无 | 本地过滤结果 | **否** |
| ③ 取元数据 | `name`(+year/tmdb/kind) | `/api/art|similar|trailer|ratings|skip|saga|pessoa|airing|discover` | 海报/推荐/预告/评分/跳过点/系列 | 是 |
| ③′ 名字↔条目 | 元数据 titles + 本地片库 | 无（`rs()` 前端匹配） | 可播放的本地条目 | **否** |
| ④ 播放 | `play.url`(+alt/headers) | `GET /api/stream?u=…` | 流数据 → hls.js/mpegts.js 解码 | 是 |

---

## 3. 转发代理接口

### 3.1 `GET /api/fetch`

抓取外部 M3U 列表或文本元数据。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `u` | string(URL) | 是 | 目标地址 |
| `ua` | string | 否 | 覆盖 User-Agent |
| `ref` | string | 否 | 覆盖 Referer |
| `live` | `1` | 否 | 直播标记 |

**实测**
```bash
curl 'https://hypetv.mihawkdev.com/api/fetch?u=https%3A%2F%2Fiptv-org.github.io%2Fiptv%2Fcountries%2Fbr.m3u&ua=TestUA&ref=https%3A%2F%2Fexample.com'
```
```
HTTP 200, 86098 bytes
#EXTM3U
#EXTINF:-1 tvg-id="1001Noites.br@SD" tvg-logo="..." group-title="Shop",1001 Noites (480p)
...
```

### 3.2 `GET /api/stream`

代理视频流（HLS/TS/MP4）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `u` | string(URL) | 是 | 流地址 |
| `ua` / `ref` | string | 否 | 透传请求头 |
| `live` | `1` | 否 | 直播流 |

**实测**：`GET /api/stream?u=...m3u8` → `200`，`content-type: application/vnd.apple.mpegurl`
> 注意：带 `Range: bytes=0-50` 请求时仍返回 **200 全量**，响应未提供 `206` / `content-range` / `accept-ranges` 头，**未真正实现分段传输**。播放器侧由 hls.js / mpegts.js 处理分片。

### 3.3 `GET /api/img`

代理图片，实测返回 `content-type: image/jpeg`。白名单域名（TMDB/Wikimedia/jsDelivr）在前端直连，不经此接口。

### 3.4 `GET /api/x/{id}`

站点内置 Xtream 列表入口，配合 `GET /api/lists` 使用。前端把返回的列表映射为 `server: new URL('api/x/'+id, baseURI)`、`username: '-'`、`password: '-'` 的 Xtream 账号。
> 实测 `/api/x/3` 返回 `404`，可能因 id 无效或需特定参数。

---

## 4. 元数据增强接口（GET）

以下接口的查询参数由前端用 `URLSearchParams` 构造，`kind` 取 `live | movie | series`。

### 4.1 `GET /api/discover`

首页「发现」推荐位，无需参数，返回预置片单。前端单例缓存。

**实测**
```json
{"rows":[{"id":"top-movie","title":"Top 10 filmes da semana","caption":"em alta no mundo, dos que a lista tem","kind":"movie","ranked":true,"titles":[{"title":"A Odisseia","original":"The Odyssey","year":"2026"}, ...]}]}
```

### 4.2 `GET /api/similar`

| 参数 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | `movie` / `series`（**缺此项返回 400**） |
| `name` | 是 | 片名 |
| `year` | 否 | 年份，用于消歧 |
| `tmdb` | 否 | TMDB ID |

**实测** `?kind=movie&name=The%20Matrix`
```json
{"titles":[{"title":"O Exterminador do Futuro: Gênesis","original":"Terminator Genisys","year":"2015"}, ...]}
```

### 4.3 `GET /api/trailer`

参数同 3.2。**实测** `?kind=movie&name=The%20Matrix` → `{"youtube":"FVI84Dfx2-I"}`，前端拼成 `https://www.youtube-nocookie.com/embed/{id}?autoplay=1&rel=0&playsinline=1`。

### 4.4 `GET /api/saga`

查系列电影。参数：`name`（必填）、`year`、`tmdb`。**实测** `?name=x`
```json
{"saga":{"name":"X: Coleção","parts":[{"tmdb":760104,"title":"X: A Marca da Morte","year":"2022"}, ...3 部]}}
```

### 4.5 `GET /api/skip`

剧情跳过点（片头/回顾/片尾）。参数：`kind`（必填）、`name`（必填）、`year`、`tmdb`；剧集另加 `s`（季）、`e`（集）；`d` 为时长秒（>0 时返回）。

**实测** `?kind=movie&name=The%20Matrix&d=0`
```json
{"segments":{"credits":{"start":7765,"end":8152.101}}}
```
`segments` 可含 `intro`（Pular abertura）、`recap`（Pular recapitulação）、`post`（Pular pra cena pós-créditos）。

### 4.6 `GET /api/ratings`

评分。参数同 `skip` 的前缀（`kind`、`name`、`year`、`tmdb`、`d`）。**实测** `?kind=movie&name=The%20Matrix&year=1999&tmdb=603&d=0` → `{"ratings":null}`（该片无数据）。

### 4.7 `GET /api/pessoa`

- `GET /api/pessoa`：功能开关，实测 `{"enabled":true}`。
- `GET /api/pessoa?name={姓名}&role={角色}`：人物详情。**实测** `?name=x&role=at`
```json
{"person":{"name":"X","photo":"https://image.tmdb.org/t/p/w185/9phMdMcRFBoPjDraxBNh1DDuPpr.jpg","credits":[{"kind":"series","title":"...","year":2022}, ...]}}
```

### 4.8 `GET /api/apoiadores`

赞助/支持者列表，前端 TTL 缓存 175 秒。**实测** `{"supporters":[]}`。

### 4.9 `GET /api/lists`

内置 Xtream 列表清单。**实测**
```json
[{"id":"1","name":"Minha lista"},{"id":"2","name":"Lista-2"}]
```
前端 `?store` 参数（PWA store 模式）会跳过此请求。

---

## 5. 元数据增强接口（POST）

### 5.1 `POST /api/art`

批量查海报与背景图。前端把 180 秒内的请求合并成一次 POST。

**请求**
```json
{ "items": [ {"name":"The Matrix","year":"1999","kind":"movie"}, {"name":"Avatar","year":"2009","kind":"movie"} ] }
```
**实测响应**
```json
{"results":[
  {"image":"https://image.tmdb.org/t/p/w342/lDqMDI3xpbB9UQRyeXfei0MXhqb.jpg","backdrop":"https://image.tmdb.org/t/p/w780/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg"},
  {"image":"https://image.tmdb.org/t/p/w342/lRRMQhlOLM9xgvjKKFndOmptqKR.jpg","backdrop":"https://image.tmdb.org/t/p/w780/vL5LR6WdxWPjLPFRLe133jXWsh5.jpg"}
]}
```
`results` 与 `items` 顺序一一对应，无结果项为 `null`。

### 5.2 `POST /api/epg`

抓 EPG 节目单。

**请求**
```json
{ "src": "XMLTV_URL", "channels": ["tvg-id"], "from": 1763900000, "to": 1763910000 }
```
**响应**：`{"rows":[{ "start":..., "end":..., "title":... }, ...]}`
**实测**：空参数 → `400 {"error":"Pedido inválido"}`；无效源 → `502 {"error":"Não deu pra falar com o servidor da lista"}`。

### 5.3 `POST /api/airing`

查询剧集最新播出信息。**请求** `{ "items": [ {"name":"...","year":"..."} ] }`

**实测**
```json
{"results":[
  {"last":{"season":1,"episode":1,"date":"2014-08-11","name":"Episódio 1"}},
  {"next":{"season":2,"episode":1,"date":"2027-05-21","name":"Episódio 1"},"last":{"season":1,"episode":13,"date":"2026-10-30","name":"O Chacra Raiz"}}
]}
```

---

## 6. 账户与设备接口

统一封装：`Vu(path, { method, body, token })`，`Authorization: Bearer {token}`，有 body 时带 `content-type: application/json`。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/conta/{path}` | 任意 | 账户通用入口，`{path}` 为子路径 |
| `/api/conta/tv?aparelho={id}&nome={name}` | GET | 设备配对状态，长轮询（`ld()`） |
| `/api/conta/tv` | POST | body `{para, ...}`，下发控制指令 |
| `/api/conta/tv/controle` | GET | 接收控制指令，长轮询 |
| `/api/conta/tv/estado` | POST | body `{aparelho, estado}`，上报播放状态 |

遥控指令集：`play / pause / seek / volume / mute / next / zap / exit`。

---

## 7. 其他

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/report` | POST | 错误上报，body 为 JSON。**实测** 返回 `204 No Content` |

---

## 8. 错误码

| HTTP | error 字段 | 含义 |
|---|---|---|
| 400 | `Pedido inválido` | 请求参数不合法（如 similar 缺 `kind`） |
| 404 | `Não encontrado` | 路径/资源不存在 |
| 502 | `Não deu pra falar com o servidor da lista` | 后端无法连接源站 |

代理类 `api/fetch` 的错误由前端 `ji()` 嗅探 HTML 内容识别，例如：
`INVALID_CREDENTIALS`→用户/密码无效、`EXPIRED`→订阅过期、`BANNED/BLOCKED/DISABLED`→源站封禁、`MAX_CONNECTIONS`→连接数超限。

---

## 9. 缓存策略（前端侧）

| 接口 | 策略 |
|---|---|
| similar / trailer / saga / skip / ratings / pessoa | `Map` 记忆化 Promise，失败即删除以便重试 |
| `/api/discover` | 单例缓存（`cs`） |
| `/api/apoiadores` | TTL 175 秒 |
| `/api/pessoa`（开关） | 单例缓存（`rl`） |
| `/api/art` | 180 秒窗口内批量合并请求 |

---

## 10. 对 IPTV 清洗项目的参考要点

1. **内容嗅探**：HTTP 200 不代表列表有效，须检测返回是否为 HTML 错误页（本项目 `iptv_cleaner_v2_strict.py` 测速环节可借鉴）。
2. **请求头透传**：部分源依赖 `ua`/`ref`，M3U 的 `#EXTVLCOPT` 需解析并透传。
3. **双线路回退**：Xtream 直播按 `allowed_output_formats` 决定优先 `m3u8` 还是 `ts`，并提供 `alt` 备用地址。
4. **Range 陷阱**：该站 `/api/stream` 并未真正实现 206 分段，测速时不要依赖 `content-range`。
