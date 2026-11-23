以下这份 Prompt 专门用来和 AI（如 Claude、Cursor、Cline）交互，让它在你现有的 CatVod Stremio Addon 项目中**新增一个源**。它把“探测 → 配置 → 代码 → 验证”的完整链路固化成了 AI 能直接执行的指令，同时保留了“出错时如何锁定问题”的排查框架。

以 `https://360zy.com/api.php/provide/vod/` 为例，你可以直接把整份 Prompt 交给 AI，它会按步骤执行。

---

## AI Prompt：为 CatVod Stremio Addon 新增源支持

````markdown
# 角色与任务

你是资深 Node.js + Stremio Addon v3 开发工程师。
任务：在现有项目 CatVod Stremio Addon 中新增一个影视源，使其能在 catalog / meta / stream 三条通路中正常工作。

项目路径：`/Users/wangqifei/Documents/stremio/stremioAddon/catvod`
新增源示例：`https://360zy.com/api.php/provide/vod/`

---

## 第 0 步：理解项目约定（必须遵守）

在写任何代码之前，先阅读项目中的 `docs/DEVELOPMENT.md`（如果存在），或快速浏览以下关键文件，理解架构：

- `config/sources.json` — 源清单（baseUrl / UA / 线路模式 / 广告组）
- `src/sources/maccmsBase.js` — MacCMS 通用解析（search / detail / parsePlayUrl）
- `src/sources/shareResolver.js` — share 页面 → m3u8 解析
- `src/sources/adapters/bfzy.js` — 标准 MacCMS 适配器范例
- `src/sources/registry.js` — 适配器注册表
- `src/hls/rules.js` — 广告规则组查找（通过 sources.json 的 adRuleGroup）

**硬性约束（不可违反）**：
1. 不合并不同源结果，每个源独立 catalog / meta / stream。
2. **不中转分片**：`/hls` 只改 m3u8 清单，分片 URL 一律转绝对原始地址。
3. ijk 参数不进返回流。
4. 低置信不强行透传（score < 0.60 返回空，0.60–0.85 返回候选）。
5. 不编造接口。如果源结构未知，先探测，不要猜测。

---

## 第 1 步：探测源结构（AI 必须先执行，不可跳过）

在写 adapter 之前，用项目已有的探针脚本（或直接 curl）确认以下信息。**把探测结果作为后续决策的依据**。

### 1.1 探测搜索接口

```bash
curl -s "https://360zy.com/api.php/provide/vod/?ac=search&wd=庆余年" | head -c 2000
```

**需要确认**：
- `list[0]` 是否包含 `vod_id`、`vod_name`、`vod_year`、`vod_pic`、`type_name`、`vod_remarks`。
- **是否包含 `vod_play_url`**。多数 MacCMS 的 `ac=search` 不返回播放地址，需要走 detail。

### 1.2 探测详情接口

用搜索拿到的 `vod_id`：

```bash
curl -s "https://360zy.com/api.php/provide/vod/?ac=detail&ids=<vod_id>" | head -c 4000
```

**需要确认**：
- `vod_play_from` 的线路名列表（用 `$$$` 分隔）。
- `vod_play_url` 的结构：用 `$$$` 分线路、`#` 分集、`$` 分标题/URL。
- **每条线路的 URL 是直链 m3u8，还是 `/share/xxx` 页面**。这是决定 `mode: "direct"` 还是 `"share"` 的关键。
- 如果存在 `vod_douban_id`，记录它（可用于辅助匹配）。

### 1.3 探测防盗链

对 detail 返回的第一条 m3u8（或 share 页面），分别**带 headers**和**不带 headers**请求：

```bash
# 带 UA/Referer
curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0 ..." -e "https://360zy.com/" "<url>"

# 裸请求
curl -s -o /dev/null -w "%{http_code}" "<url>"
```

**判定**：如果裸请求 403，说明 manifest 层有防盗链，`/hls` 必须带 `sourceCfg.ua` / `sourceCfg.referer` 拉取。

### 1.4 输出探测结论（AI 在回复中列出）

格式：
```
【源 360zy 探测结果】
- 搜索是否返回播放地址：是 / 否
- 线路列表：["360m3u8", "360share", ...]
- 线路模式判定：
  - 360m3u8 → direct（URL 以 .m3u8 结尾）
  - 360share → share（URL 含 /share/）
- 防盗链：manifest 层需要 headers / 不需要
- 建议 adRuleGroup：360资源
```

---

## 第 2 步：修改 `config/sources.json`

在 `sources` 数组中**追加**一条（不要改动已有源）：

```json
{
  "id": "zy360",
  "label": "360资源",
  "enabled": true,
  "baseUrl": "https://360zy.com/api.php/provide/vod",
  "referer": "https://360zy.com/",
  "timeoutMs": 8000,
  "retries": 1,
  "lines": {
    "360m3u8": { "mode": "direct" },
    "360share": { "mode": "share" }
  },
  "adRuleGroup": "360资源"
}
```

**说明**：
- `lines` 的 key 必须与探测到的 `vod_play_from` 线路名**完全一致**（区分大小写）。
- 如果探测发现所有线路都是直链，只保留 `direct` 线路；如果全是 share，全标 `share`。
- `adRuleGroup` 对应 `config/adRules.json` 中的组名，暂用 `"360资源"`，第 4 步会补规则。

---

## 第 3 步：创建 Adapter

### 3.1 如果源是标准 MacCMS（90% 情况）

创建 `src/sources/adapters/zy360.js`，内容与 `bfzy.js` 几乎相同，**只改 `id` 和 `label`**：

```javascript
import { maccmsSearch, maccmsDetail, parsePlayUrl, isMovie, parseEpisodeNumber } from "../maccmsBase.js";
import { resolveShare } from "../shareResolver.js";

export const zy360 = {
  id: "zy360",
  label: "360资源",
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
          ua: cfg.ua, referer: cfg.referer, timeoutMs: cfg.timeoutMs, srcId: "zy360",
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

### 3.2 如果源不是标准 MacCMS（自定义接口）

自己实现 `search` 和 `resolveStream`，但**返回结构必须严格符合**：

**`search` 返回**：
```javascript
[{ vod_id, vod_name, vod_year, vod_pic, type_name, vod_remarks }]
```

**`resolveStream` 返回**：
```javascript
[{
  lineName: string,      // 线路名
  title: string,         // 集标题
  url: string,           // 直链 m3u8 或 share 页面
  isDirect: boolean,     // 是否可直接播放（m3u8 直链）
  nonDirect?: boolean,   // share 解析失败时 true
  sourceLabel: string    // 如 "360资源｜360m3u8"
}]
```

---

## 第 4 步：注册 Adapter

修改 `src/sources/registry.js`：

```javascript
import { bfzy } from "./adapters/bfzy.js";
import { ffzy } from "./adapters/ffzy.js";
import { lz } from "./adapters/lz.js";
import { zy360 } from "./adapters/zy360.js";   // ← 新增

const ADAPTERS = { bfzy, ffzy, lz, zy360 };     // ← 新增
```

---

## 第 5 步：添加广告规则（可选但建议）

在 `config/adRules.json` 的 `rules` 数组中追加：

```json
{
  "name": "360资源",
  "hosts": ["360zy", "360zyzz", "360zycdn"],
  "regex": [
    "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:3\\.000000,[\\s\\S]*?#EXT-X-DISCONTINUITY",
    "#EXTINF.*?\\s+.*?ad.*?\\.ts"
  ]
}
```

**规则编写指导**：
- 先用 `/debug/hls-clean` 观察该源的实际广告特征，再写正则。
- 纯数字（如 `"17.19"`）会自动编译为 `#EXTINF:?17\.19` 匹配时长。
- 含 `#` 开头或正则元字符的字符串按正则处理。
- 纯字面量（如 `"更多"`）命中 `#EXTINF` 行即删片段。

**热重载**（无需重启）：
```bash
curl -X POST "http://127.0.0.1:3000/debug/reload-rules"
```

---

## 第 6 步：验证（AI 必须引导用户执行以下命令，并解读结果）

### 6.1 语法检查

```bash
node --check src/sources/adapters/zy360.js
node --check config/sources.json 2>/dev/null || node -e "JSON.parse(require('fs').readFileSync('config/sources.json','utf8'))"
```

### 6.2 重启服务

```bash
# 如果使用 vercel dev
lsof -ti:3000 | xargs kill -9 2>/dev/null
npx vercel dev

# 或本地 node
PORT=7001 node --env-file=.env.local src/localServer.js
```

### 6.3 源健康

```bash
curl -s "http://127.0.0.1:3000/debug/sources" | jq '.sources[] | select(.id=="zy360")'
```

**期望**：`{ ok: true, count: >0, sample: "..." }`。

### 6.4 搜索

```bash
curl -s "http://127.0.0.1:3000/catalog/series/zy360-series/search=庆余年.json" | jq '.metas | length'
```

**期望**：`> 0`。

### 6.5 拉流（内部 ID）

从 6.4 的返回里拿一个 `id`（如 `zy360:series:12345`），然后：

```bash
curl -s "http://127.0.0.1:3000/stream/series/zy360:series:12345:1:1.json" | jq
```

**期望**：`streams` 数组非空，且每条 `url` 指向 `/hls?url=...&src=zy360`。

### 6.6 HLS 清洗预览

```bash
curl -s "http://127.0.0.1:3000/debug/hls-clean?url=<encoded>&src=zy360" | jq '{
  type, risk, degraded, hits,
  originalSegments, cleanedSegments
}'
```

**期望**：`type` 为 `media` 或 `master`，`risk` 不为 `high`（或 `degraded` 为 `true` 时有明确原因）。

### 6.7 全量回归

```bash
node scripts/health.js --verbose
node scripts/regression-test.js http://127.0.0.1:3000
```

**期望**：所有测试通过，且 `zy360` 出现在 catalog 和 stream 测试中。

---

## 第 7 步：如果验证失败，按以下框架排查

| 现象 | 可能原因 | 排查动作 |
|---|---|---|
| `/debug/sources` 中 `zy360` 为 `ok: false` | baseUrl 错 / 源站封 UA / 网络不通 | 直接用 curl 请求 `{baseUrl}/?ac=search&wd=test`，看 HTTP 状态 |
| catalog 返回 0 条 | 搜索字段名不对 / keyword 编码问题 | 看 `[catalog] zy360 search=... → 0 items` 日志；确认 `maccmsSearch` 返回的 `list` 是否为空 |
| stream 返回空 | detail 的 `vod_play_url` 为空 / `lines` 配置的线路名不匹配 | 看 detail 原始返回；确认 `cfg.lines` 的 key 与 `vod_play_from` 完全一致 |
| 所有线路 `nonDirect: true` | share 页面结构变化 / 线路标错 mode | 用 `curl <share URL>` 看 HTML；检查 `shareResolver.js` 的三个正则是否匹配 |
| `/hls` 返回 `#EXTM3U` 但播放器黑屏 | 分片有防盗链 / sign 过期 | 用 VLC 直接打开返回的 `.ts` 地址；如果 403，说明分片层防盗链，无法在不中转的前提下解决，需文档注明 |
| HLS 清洗后视频变短 | 正则过激 | `/debug/hls-clean` 看 `hits` 里哪条规则 `removed` 过多；缩小正则范围 |

**排查时提供的信息**：
1. 完整 curl 命令 + 响应
2. `x-trace-id`（响应头）
3. 对应时间段的完整服务端日志
4. `/debug/match` 或 `/debug/hls-clean` 的返回

---

## 第 8 步：交付清单（AI 在完成后逐项确认）

- [ ] `config/sources.json` 已追加新源，`lines` 的 mode 与探测结果一致
- [ ] `src/sources/adapters/zy360.js` 已创建，`search` 和 `resolveStream` 返回结构符合约定
- [ ] `src/sources/registry.js` 已注册 `zy360`
- [ ] `config/adRules.json` 已添加 `"360资源"` 规则组（或明确告知“暂未添加，待后续维护”）
- [ ] `node --check` 语法通过
- [ ] `/debug/sources` 中新源 `ok: true`
- [ ] catalog 搜索返回 > 0
- [ ] stream 返回非空，且 `url` 指向 `/hls?src=zy360`
- [ ] `/debug/hls-clean` 无高风险降级（或降级原因合理）
- [ ] `node scripts/health.js` 全部通过

---

## 附：常用调试命令速查

```bash
# 源健康
curl -s "http://127.0.0.1:3000/debug/sources" | jq

# 匹配链路（用真实 imdbid）
curl -s "http://127.0.0.1:3000/debug/match?imdbid=tt0111161&type=movie" | jq

# HLS 清洗预览
curl -s "http://127.0.0.1:3000/debug/hls-clean?url=<encoded>&src=zy360" | jq

# 热重载广告规则
curl -X POST "http://127.0.0.1:3000/debug/reload-rules"

# 缓存状态
curl -s "http://127.0.0.1:3000/debug/cache" | jq
```

---

## 开始执行

请从 **第 1 步探测** 开始，把探测结论先贴出来，等我确认后再继续写代码。
不要跳过探测直接写 adapter。
````

---

### 使用说明

把上面整段 Prompt 交给 AI（Claude / Cursor / Cline）时，注意：

1. **先让 AI 执行第 1 步探测**。它可能会说“我无法运行 curl”，这时你手动跑那几条 curl，把输出贴回给 AI，它就能继续。
2. **AI 给出的 `lines` 配置**必须与探测到的 `vod_play_from` 完全一致。如果 AI 猜错了，用 `/debug/sources` 和 detail 原始返回纠正它。
3. **如果 AI 想跳过探测直接写代码**，提醒它：“按 Prompt 第 1 步先探测，不要猜测接口结构。”
4. 每次改动后，**让它引导你跑第 6 步的验证命令**，而不是直接说“完成了”。验证输出会暴露 `mode` 标错、线路名不匹配等问题。

这份 Prompt 的格式参考了 Stremio manifest 对 `resources`/`idPrefixes` 的声明方式，以及 MacCMS `vod_play_url` 的标准分隔约定（`$$$` 分线路、`#` 分集），确保 AI 输出的代码与项目现有架构严格对齐。