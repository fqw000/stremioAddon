# CatVod Multi-Source Stremio Addon

多源影视聚合 Stremio addon（技术研究用途）。三条源：暴风（bfzy）、非凡（ffzy）、量子（lz）。

## 两条业务通路

1. **用户搜索/浏览**：Stremio → `/catalog/{src}-{type}` → 源 search → 独立 catalog items
2. **外部 imdbid 拉流**：Stremio → `/stream/{type}/ttXXX` → TMDB 元数据 → 各源 search → 打分 → 高置信 detail → `/hls/clean`

## 目录

```
src/
├─ app.js              Express app 工厂（无 listen）
├─ index.js            本地开发入口
├─ addon/              Stremio 协议层（manifest/catalog/meta/stream）
├─ sources/            源适配器（bfzy/ffzy/lz）+ share 解析 + 缓存包装
├─ metadata/           TMDB + matcher
├─ hls/                HLS 清洗（规则 + cleaner + master 递归）
├─ cache/              L1 内存 + L2 Upstash
├─ routes/             /hls/clean + /debug/*
└─ utils/              http / traceId
api/index.js           Vercel Serverless 入口
config/                sources.json / adRules.json
docs/                  部署 / 排查文档
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 本地 | 本地端口，默认 7100 |
| `APP_PREFIX` | **必填** | Redis 前缀，如 `catvod:prod` |
| `TMDB_API_KEY` | 推荐 | TMDB v3 API key |
| `TMDB_BASE_URL` | 可选 | TMDB 反代地址（本地网络差时用） |
| `UPSTASH_REDIS_REST_URL` | 可选 | 不配降级内存 LRU |
| `UPSTASH_REDIS_REST_TOKEN` | 可选 | 同上 |
| `ADDON_BASE_URL` | Vercel 必填 | 如 `https://xxx.vercel.app`，用于生成 `/hls/clean` 绝对地址 |
| `LOG_LEVEL` | 可选 | debug/info/warn/error，默认 info |
| `LOG_JSON` | 可选 | 生产建议 true |

## 接口

| 路径 | 说明 |
|---|---|
| `GET /manifest.json` | Stremio manifest |
| `GET /catalog/:type/:id.json` | 独立源 catalog（含 `extra.search`） |
| `GET /meta/:type/:id.json` | 内部 id meta |
| `GET /stream/:type/:id.json` | 两条通路：内部 id 或 imdbid |
| `GET /hls/clean?url=&src=` | HLS 清洗入口（生产流地址） |
| `GET /debug/match?imdbid=&type=&season=` | 匹配链路全透明 |
| `GET /debug/sources` | 各源健康 |
| `GET /debug/cache` | 缓存后端状态 |
| `POST /debug/reload-rules` | 热重载广告规则 |
| `GET /health` | 健康检查 |

## 本地开发

```bash
cp .env.example .env.local
# 编辑 .env.local 填 APP_PREFIX / TMDB_API_KEY / UPSTASH_*
PORT=7001 node --env-file=.env.local src/index.js
```

## 部署

见 `docs/deploy-vercel.md`。故障排查见 `docs/troubleshoot.md`。
```

**保存路径**：`docs/README.md`

---

### 2.6 `docs/deploy-vercel.md`（新建）

```markdown
# Vercel 部署指南

## 前置

- GitHub 仓库（本项目源码）
- Vercel 账号（Hobby 免费计划即可）
- TMDB API key（https://www.themoviedb.org/settings/api）
- Upstash Redis（https://console.upstash.com/，免费 500K commands/月）

## 一、推代码到 GitHub

```bash
git add .
git commit -m "deploy: vercel"
git push origin main
```

确认 `.gitignore` 包含 `.env` / `.env.local` / `node_modules`。

## 二、Vercel 导入项目

1. vercel.com → Add New → Project → 选你的 GitHub 仓库
2. Framework Preset：**Other**
3. Root Directory：仓库根目录（`vercel.json` 所在处）
4. Build & Output：全部留空（Vercel 自动识别 `api/index.js`）

## 三、配置环境变量

Project Settings → Environment Variables，逐条添加（Production / Preview / Development 全勾）：

| Key | Value 示例 | 说明 |
|---|---|---|
| `APP_PREFIX` | `catvod:prod` | Redis 前缀，多项目共用时必须唯一 |
| `TMDB_API_KEY` | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | TMDB v3 key |
| `UPSTASH_REDIS_REST_URL` | `https://xxx.upstash.io` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | `AXxx...` | Upstash REST Token |
| `ADDON_BASE_URL` | `https://your-app.vercel.app` | **必填**，HLS 子清单入口拼接依赖它 |
| `LOG_LEVEL` | `info` | 生产建议 info |
| `LOG_JSON` | `true` | 结构化日志便于 Vercel 日志搜索 |

**不要**在 Vercel 配 `TMDB_BASE_URL`（Vercel 到 TMDB 是通的）。

## 四、部署

点 Deploy，等 1-2 分钟。

部署完成后访问：
```
https://your-app.vercel.app/health
# → {"ok":true,"ts":...}
```

## 五、验证

```bash
BASE=https://your-app.vercel.app

# manifest
curl -s $BASE/manifest.json | jq '.catalogs | length'
# 预期 6

# catalog
curl -s "$BASE/catalog/series/bfzy-series/search=%E5%BA%86%E4%BD%99%E5%B9%B4.json" | jq '.metas | length'

# stream（内部 id）
curl -s "$BASE/stream/series/bfzy:series:27312:1:2.json" | jq '.streams[0].url'
# 预期：https://your-app.vercel.app/hls/clean?url=...&src=bfzy

# stream（imdbid 通路）
curl -s "$BASE/stream/movie/tt0111161.json" | jq '.streams | length'

# /hls/clean 真实播放
curl -s "$BASE/hls/clean?url=<encoded>&src=bfzy" | head -5
```

## 六、安装到 Stremio

Stremio 桌面/网页 → Addons → 右上角「Community」输入：
```
https://your-app.vercel.app/manifest.json
```

## 七、注意事项

1. **Hobby 10 秒超时**：`/stream` 通路三源并行 + TMDB，正常 3-6 秒，极端情况可能接近 10 秒。如果频繁超时，把 `src/sources/registry.js` 里的源超时从 8000ms 降到 5000ms。
2. **`ADDON_BASE_URL` 必填**：否则 master playlist 里的子清单入口会拼成 `http://localhost`，播放器拉不到。
3. **Upstash 用量**：免费 500K/月。本项目 L1 命中率通常 > 80%，实际 Redis 调用远低于额度。
4. **分片直连**：`/hls/clean` 只改清单，分片 URL 一律转绝对原始地址，播放器直连源站。如果分片层有防盗链（需 Referer/UA），播放器无法带 → 这种情况本方案无解（不能中转分片），需源站本身可直连。
5. **`/hls/clean` 不缓存**：已设 `Cache-Control: no-cache`。Vercel CDN 不会缓存，每次播放器拉清单都实时清洗。
6. **本地网络访问 TMDB 慢**：本地开发可在 `.env.local` 配 `TMDB_BASE_URL=你的反代`，Vercel 上无需配。

## 八、回滚

Vercel → Deployments → 选中上一个成功部署 → Promote to Production。
```

**保存路径**：`docs/deploy-vercel.md`

---

### 2.7 `docs/troubleshoot.md`（新建）

```markdown
# 故障排查

## 1. 匹配不到（stream 返回空）

**排查顺序**：

```bash
# 1. TMDB 是否有元数据
curl -s "http://localhost:7001/debug/match?imdbid=tt0111161&type=movie" | jq '.meta'
# meta 为 null → TMDB 问题（见第 4 节）

# 2. 各源搜索是否有结果
curl -s "http://localhost:7001/debug/sources?keyword=肖申克" | jq '.sources'

# 3. 每源每候选打分
curl -s "http://localhost:7001/debug/match?imdbid=tt0111161&type=movie" | jq '.candidates.bfzy.ranked[]'
```

**常见原因**：
- 源里没有这部片（`ranked` 为空）
- 有片但标题差异大，score < 0.60（看 `breakdown.title`）
- 季集不匹配（series 场景，`breakdown.season`=0）
- 源 `type_name` 判断错（movie/series 互串）

## 2. 广告没清干净

**排查**：

```bash
curl -s "http://localhost:7001/debug/hls-clean?url=<编码后的m3u8>&src=bfzy" | jq '{
  type, risk, degraded, hits,
  originalSegments, cleanedSegments,
  originalHead, cleanedHead
}'
```

**判读**：
- `hits` 为空 → 规则没匹配上，需要新增正则
- `risk: high` + `degraded: true` → 删太多被降级返回原始流，需要调 `maxReduction` 或规则太宽
- `type: master` → master playlist 正常，看 `cleanedHead` 的子清单入口是否指向 `/hls/clean`

**维护正则**（`config/adRules.json`）：
- 新增规则后 `POST /debug/reload-rules` 热重载，不用重启
- 裸数字（如 `"17.19"`）会被编译为 `#EXTINF:?17\.19` 匹配时长
- 含 `/` 的 host（如 `"shturl.cc/kw314KJ"`）按 host+path 前缀匹配
- 规则改动前先用 `/debug/hls-clean` 试一条真实流

## 3. 缓存问题

### 3.1 Redis 超时（日志出现 `redis-timeout`）

```
[WARN] [cache] L2 get catvod:prod:xxx failed: redis-timeout
```

**含义**：Upstash 单次调用 > 500ms。连续 3 次触发 60 秒冷却，期间只走 L1。

**排查**：
- Upstash Console 看延迟（正常 20-80ms）
- 网络抖动：Vercel 到 Upstash 通常很快，本地开发到 Upstash 可能慢
- 一次性大量写入（冷启动填充）：正常现象，冷却后自愈

### 3.2 前缀冲突（多项目共用 Upstash）

**症状**：其他项目的数据串到本 addon，或本 addon 数据被其他项目覆盖。

**修复**：确认 `APP_PREFIX` 唯一。本项目建议 `catvod:prod` / `catvod:staging`。

**清理**（谨慎，会删大量数据）：
```bash
# Upstash Console → Data Browser 搜 catvod:prod: 逐条确认后删除
# 或用 REST API 批量扫描（不建议，容易误删）
```

### 3.3 负缓存误伤

**症状**：明明 TMDB 有数据，`/debug/match` 返回 `meta: null`，日志出现 `negative cache hit`。

**原因**：之前某次请求失败（网络/URL 错/key 脏）被写入了负缓存。

**修复**：手动删对应 key：
```bash
node --env-file=.env.local -e '
const u = process.env.UPSTASH_REDIS_REST_URL;
const t = process.env.UPSTASH_REDIS_REST_TOKEN;
const p = process.env.APP_PREFIX || "";
const key = `${p}:tmdb:tt0111161:movie:0`;
const r = await fetch(`${u}/del/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${t}` } });
console.log(await r.text());
'
```

## 4. TMDB 问题

### 4.1 `TMDB_API_KEY not set`

`.env.local` 或 Vercel 环境变量没配。配好后重启。

### 4.2 `404, negative cache 1h` 但影片实际存在

**90% 是 URL 少 `/3`**。确认 `src/metadata/tmdb.js` 里：
```js
const TMDB_BASE = (process.env.TMDB_BASE_URL || "https://api.themoviedb.org").replace(/\/$/, "") + "/3";
```
末尾必须有 `+ "/3"`。

修好后清掉负缓存（见 3.3）。

### 4.3 `network-timeout` / `network-AbortError`

本地网络到 TMDB 慢。方案：
- `.env.local` 配 `TMDB_BASE_URL=https://你的反代`（代码已支持）
- Vercel 上不用管（Vercel 到 TMDB 直连很快）

## 5. 源失效

**症状**：`/debug/sources` 某源 `ok: false` 或 `count: 0`。

**排查**：
```bash
curl -s "http://localhost:7001/debug/sources" | jq '.sources[] | select(.ok == false)'
```

**常见原因**：
- 源域名变更（MacCMS 站点经常换域名）
- 源临时维护

**修复**：`config/sources.json` 改对应源的 `baseUrl` 和 `referer`，或用环境变量覆盖：
```bash
BFZY_BASE_URL=https://新域名/api.php/provide/vod
```

单源故障不影响其他源（registry 层隔离）。

## 6. HLS 子清单拉不到

**症状**：master playlist 返回了 `/hls/clean?...` 子清单入口，但播放器拉不到。

**排查**：
1. `ADDON_BASE_URL` 是否配置为公开可访问地址
2. 手动 curl 子清单入口是否返回 media playlist：
   ```bash
   curl -s "https://your-app.vercel.app/hls/clean?url=...&src=lz" | head
   ```
3. 子清单里的 `sign` 是否保留（Vercel 部署时 `ADDON_BASE_URL` 配错会导致拼成 localhost）

## 7. 日志定位

每条日志带 `traceId`（响应头 `x-trace-id`），跨服务端日志串联：

```bash
curl -s -i "http://localhost:7001/stream/series/tt0111161:1:1.json" | grep x-trace-id
# 拿到 traceId 后在服务端日志里 grep 这个 id
```

`LOG_JSON=true` 时日志为结构化 JSON，便于 `jq` 过滤。

## 8. 复现 bug 的最小信息

提 issue 或排查时提供：
- 请求路径 + 入参（curl 完整命令）
- `x-trace-id`
- 对应时间段的完整服务端日志
- `/debug/match` 或 `/debug/hls-clean` 返回
- 原始源返回（`debug: true` 时日志会打）
```

**保存路径**：`docs/troubleshoot.md`

---

## 三、验证本地仍然能跑

```bash
# 语法全量校验（包括新文件）
find src api -name "*.js" -exec node --check {} \; && echo "ALL OK"

# 本地起服务（改完后）
lsof -ti:7001 | xargs kill -9 2>/dev/null
PORT=7001 node --env-file=.env.local src/index.js

# 回归测试（三条关键接口）
curl -s "http://localhost:7001/health" | jq
curl -s "http://localhost:7001/manifest.json" | jq '.catalogs | length'
curl -s "http://localhost:7001/debug/match?imdbid=tt0111161&type=movie" | jq '.meta.name, (.candidates | keys)'
# 预期： "肖申克的救赎" + ["bfzy","ffzy","lz"]
