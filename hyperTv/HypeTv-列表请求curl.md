# HypeTv 列表请求 curl 清单

> 全部基于对 `https://hypetv.mihawkdev.com` 的真实请求验证（验证时间 2026-11-23/24）。
> 响应均为 `application/json;charset=utf-8`，带 `access-control-allow-origin:*`。

---

## 1. 内置列表：清单

```bash
curl -sS 'https://hypetv.mihawkdev.com/api/lists'
```

实测响应：

```json
[{"id":"1","name":"Minha lista"},{"id":"2","name":"Lista-2"}]
```

> 注意：这是服务端当前配置，数量可变。

---

## 2. 内置列表：内容（Xtream 格式，关键）

⚠️ **直接请求 `/api/x/1` 会 404**。必须按 Xtream Codes 完整路径拼接，前端把内置列表伪装成一个 Xtream 账号：
`server = /api/x/{id}`，`username = password = "-"`。

### 2.1 验证账号（auth）

```bash
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-'
```

实测响应含 `user_info.auth=1`、`status=Active`、`max_connections=1`、`allowed_output_formats:[m3u8,ts,rtmp]`。

### 2.2 直播频道列表

```bash
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-&action=get_live_streams'
```

实测：HTTP 200，**653053 字节 / 2036 个频道**，数组含 `stream_id`、`name`、`stream_icon`、`category_id`、`epg_channel_id` 等字段。

```bash
curl -sS 'https://hypetv.mihawkdev.com/api/x/2/player_api.php?username=-&password=-&action=get_live_streams'
```

实测：HTTP 200，**503790 字节 / 1409 个频道**。

### 2.3 其它 action（同一模板换 action 即可）

```bash
# 电影
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-&action=get_vod_streams'
# 剧集
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-&action=get_series'
# 直播分类
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-&action=get_live_categories'
# 短节目单
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-&action=get_short_epg&stream_id=784811&limit=4'
# 剧集详情（每集地址由此生成）
curl -sS 'https://hypetv.mihawkdev.com/api/x/1/player_api.php?username=-&password=-&action=get_series_info&series_id=XXXX'
```

### 2.4 内置直播流地址模板（前端拼出来的，不是接口返回的）

```
http(s)://<站点>/api/x/1/live/-/-/{stream_id}.m3u8
http(s)://<站点>/api/x/1/live/-/-/{stream_id}.ts     ← alt 备用
```

例：`https://hypetv.mihawkdev.com/api/x/1/live/-/-/784811.m3u8`

---

## 3. 用户添加 M3U 链接：抓取列表原文

前端 `Ni()` 先直连，失败（CORS/混合内容）才走同源代理。代理端点：

```bash
# URL 需 URL-encode 后放进 u= 参数
curl -sS 'https://hypetv.mihawkdev.com/api/fetch?u=https%3A%2F%2Fiptv-org.github.io%2Fiptv%2Fcountries%2Fbr.m3u'
```

带自定义 UA / Referer（实测后端接收这两个参数）：

```bash
curl -sS 'https://hypetv.mihawkdev.com/api/fetch?u=https%3A%2F%2Fexample.com%2Flist.m3u8&ua=MyUA&ref=https%3A%2F%2Fexample.com%2F'
```

实测：返回完整 M3U 文本（巴西列表约 86KB）。

> 前端的 "Link M3U" 会**先尝试当 Xtream 自动识别**（`Sa(t)`），识别失败才当普通 M3U 走上面的 `/api/fetch`。

---

## 4. 用户添加 Xtream 账号：验证 + 拉列表

把自己的 Xtream 账号按标准协议请求（前端先直连，失败才经 `/api/fetch?u=` 代理）：

```bash
# 验证账号
curl -sS 'http://your-server:8080/player_api.php?username=USER&password=PASS'

# 直播频道
curl -sS 'http://your-server:8080/player_api.php?username=USER&password=PASS&action=get_live_streams'

# 电影
curl -sS 'http://your-server:8080/player_api.php?username=USER&password=PASS&action=get_vod_streams'

# 剧集
curl -sS 'http://your-server:8080/player_api.php?username=USER&password=PASS&action=get_series'
```

播放地址由前端拼出（不是接口返回）：

```
{server}/live/{u}/{p}/{stream_id}.m3u8|.ts
{server}/movie/{u}/{p}/{stream_id}.{container_extension|mp4}
{server}/series/{u}/{p}/{episode_id}.{container_extension|mp4}
```

---

## 5. 用户添加本地文件

无网络请求，浏览器读本地文件：

```js
const text = await file.text();     // File API
const catalog = ja(ba(text));        // 解析
await ii(id, text);                  // 存 IndexedDB
```

---

## 6. 列表内容的本地缓存（解释"抓包抓不到"）

- 列表原文存 **IndexedDB** 的 `texts` 表：写 `ii(id, text)`，读 `ri(id)`。
- 列表元信息 / 收藏 / 进度存 **localStorage**，前缀 `hypetv:v1:`：`Er()=Cr('playlists',[])`，`Dr=wr('playlists',…)`。
- 加载逻辑 `Ld()`：`r = await ri(id)`；只有 `r === undefined` 才 `Ni(url)` 请求；否则用缓存原文重新 `ja(ba(r))` 解析。

所以要抓"列表请求"，必须**先清空该站点的浏览器数据再重新添加列表**，那一刻才会出现 `/api/fetch?u=…` 或 `player_api.php` 请求。

---

## 7. 快速验证脚本（一次性看全部）

```bash
B=https://hypetv.mihawkdev.com
echo "== lists =="; curl -sS "$B/api/lists"
echo; echo "== x1 account =="; curl -sS "$B/api/x/1/player_api.php?username=-&password=-" | head -c 200
echo; echo "== x1 live count =="; curl -sS "$B/api/x/1/player_api.php?username=-&password=-&action=get_live_streams" | python3 -c "import sys,json; print(len(json.load(sys.stdin)),'canais')"
echo "== x2 live count =="; curl -sS "$B/api/x/2/player_api.php?username=-&password=-&action=get_live_streams" | python3 -c "import sys,json; print(len(json.load(sys.stdin)),'canais')"
```
