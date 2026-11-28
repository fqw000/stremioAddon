# 央视片库数据接口参考文档

> 适用版本：Addon v3.2.0　|　整理日期：2026-11-28
> 本文档独立描述项目使用的全部央视网（CNTV）数据接口，包括端点、参数、响应结构、字段映射、解析规则与调用示例。所有接口均为央视网公开接口，仅用于解析公开播放地址。

---

## 目录

1. [接口总览与调用链路](#1-接口总览与调用链路)
2. [接口 A：纪录片栏目页](#2-接口-a纪录片栏目页)
3. [接口 B：yxg 专辑列表 API](#3-接口-byxg-专辑列表-api)
4. [接口 C：专辑页（VIDA）](#4-接口-c专辑页vida)
5. [接口 D：单集页（VIDE）](#5-接口-d单集页vide)
6. [接口 E：播放地址 API](#6-接口-e播放地址-api)
7. [接口 F：HLS 播放流](#7-接口-fhls-播放流)
8. [关键发现与约束](#8-关键发现与约束)
9. [附录：速查表](#9-附录速查表)
10. [接口 G：4K 专区片单 API](#10-接口-g4k-专区片单-api)
11. [接口 H：4K 单集信息 API](#11-接口-h4k-单集信息-api)
12. [接口 I：4K 完整分集列表 API](#12-接口-i4k-完整分集列表-api)

---

## 1. 接口总览与调用链路

### 1.1 六个接口一览

| # | 接口 | 方法 | 数据类型 | 用途 | 使用环节 |
|---|------|------|----------|------|----------|
| A | `jishi.cctv.com/doc/.../index.shtml` | GET | HTML | 纪录片栏目列表 | catalog |
| B | `api.cntv.cn/list/getVideoAlbumList` | GET | JSON | 电视剧/动画片/特别节目列表 | catalog |
| C | `tv.cctv.com/.../VIDA*.shtml` | GET | HTML | 专辑详情 + 分集列表 | meta |
| D | `tv.cctv.com/.../VIDE*.shtml` | GET | HTML | 单集页，提取 guid | stream |
| E | `vdn.apps.cntv.cn/api/getHttpVideoInfo.do` | GET | JSON | guid 换 HLS 地址 | stream |
| F | `hls.cntv.lxdns.com` / `newcntv.qcloudcdn.com` | GET | HLS/m3u8 | 实际播放流 | 播放器直接加载 |

### 1.2 完整调用链路

```
【浏览目录】
  Stremio /catalog/series/cctv_doc
      └─ 接口 A（纪录片栏目页 HTML）→ 解析 VIDA 专辑链接 → metas
  Stremio /catalog/series/cctv_tv|animation|special
      └─ 接口 B（getVideoAlbumList JSON）→ 解析 data.list → metas

【查看详情】
  Stremio /meta/series/cctv.s.<base64url>
      └─ 解码得专辑 URL → 接口 C（VIDA 专辑页）
          ├─ <title> → 标题
          ├─ og:image → 封面
          ├─ meta description → 简介
          └─ VIDE 链接 → 分集列表 videos[]

【播放】
  Stremio /stream/series/cctv.e.<base64url>.<n>
      └─ 解码得分集 URL
          ├─ 接口 D（VIDE 单集页）→ 提取 32 位 guid
          ├─ 接口 E（getHttpVideoInfo.do?pid=guid）→ hls_url
          └─ 接口 F：由 hls_url 构造四档码率 m3u8 → streams[4]
```

### 1.3 公共请求约定

所有请求由 `lib/fetch.js` 的 `httpGet` 发出：

- **User-Agent**：`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`
- **Accept-Language**：`zh-CN,zh;q=0.9`
- **超时**：15000 ms（`AbortController` 中断）
- **Referer**：实测接口 A–F 均不强制要求 Referer，无需设置

---

## 2. 接口 A：纪录片栏目页

### 2.1 用途

抓取央视网纪实频道的纪录片专辑列表，作为「央视纪录片」目录的数据源。数据嵌在静态 HTML 的 `<li>` 列表中。

### 2.2 端点

```
GET https://jishi.cctv.com{docPath}/index.shtml
```

基础域名：`https://jishi.cctv.com`

### 2.3 栏目路径（共 21 个）

代码中以 `CATALOG_SOURCES` 常量维护（`lib/cctv.js:10-32`）：

| key | 路径 | 说明 |
|-----|------|------|
| `rwdl` | `/doc/cctv9/lm/rwdl/index.shtml` | 人文历史 |
| `military` | `/doc/list/lx/military/index.shtml` | 军事 |
| `explore` | `/doc/list/lx/explore/index.shtml` | 探索 |
| `social` | `/doc/list/lx/social/index.shtml` | 社会 |
| `nature` | `/doc/list/lx/Nature/index.shtml` | 自然 |
| `other` | `/doc/list/lx/other/index.shtml` | 其他 |
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

### 2.4 调用示例

```bash
curl -sL --compressed -A "Mozilla/5.0" \
  "https://jishi.cctv.com/doc/cctv9/lm/rwdl/index.shtml" -o list.html

# 提取 VIDA 专辑链接
grep -oE 'https?://tv\.cctv\.com/[0-9]{4}/[0-9]{2}/[0-9]{2}/VIDA[A-Za-z0-9]+\.shtml' list.html | sort -u
```

### 2.5 解析规则

`parseAlbumList()`（`lib/cctv.js:150-180`）逐 `<li>` 块处理：

| 字段 | 提取方式 |
|------|----------|
| URL | `href="(https?://tv\.cctv\.com/\d{4}/\d{2}/\d{2}/VIDA\w+\.shtml)"` |
| 标题 | 依次尝试：`<h3><a title="…">` → `<a title="…" href="…VIDA">` → `.text > a` → `<a href="…VIDA">文本</a>`；若结果为 VIDA ID 则视为无效 |
| 封面 | `<img data\|src="//….jpg\|png\|jpeg">`，协议相对地址补全为 `https:` |
| 去重 | 按 URL 使用 `Set` 去重 |

### 2.6 Stremio 分类映射

页面展示的 10 个分类并非一一对应栏目页，代码中以 `CATEGORIES` 做聚合映射（`lib/cctv.js:35-46`）：

| 分类 id | 名称 | 聚合栏目 |
|---------|------|----------|
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

> 「人物」「时政」在现行央视页面无独立有效栏目页，已映射到最接近的人文历史/经济栏目。

### 2.7 数据量

全部栏目聚合后约 **2018** 个专辑（去重后）。

---

## 3. 接口 B：yxg 专辑列表 API

### 3.1 用途

抓取电视剧、动画片、特别节目的专辑列表。电视剧/动画片/特别节目页面（`tv.cctv.com/yxg/{dsj|dhp|tbjm}/index.shtml`）通过 AJAX 调用此接口，返回结构化 JSON，比 HTML 解析稳定。

### 3.2 端点

```
GET https://api.cntv.cn/list/getVideoAlbumList
```

### 3.3 请求参数

| 参数 | 说明 | 代码取值 |
|------|------|----------|
| `channelid` | 栏目 ID | 见 3.4 节常量 |
| `area` | 地区筛选（地区类栏目使用） | `内地（大陆）`/`港澳台`/`欧美`/`其他`，或空 |
| `sc` | 类型筛选（特别节目使用） | `新闻`/`经济`/…/`其他`，或空 |
| `fc` | 固定分类名 | `电视剧`/`动画片`/`特别节目` |
| `year` | 年份筛选 | 空（未启用） |
| `letter` | 首字母筛选 | 空（未启用） |
| `p` | 页码，从 1 开始 | `1`…`6`（搜索时 `1`…`8`） |
| `n` | 每页条数 | `24` |
| `serviceId` | 固定值 | `tvcctv` |
| `topv` | 固定值 | `1` |
| `t` | 返回格式 | `json` |

### 3.4 栏目配置常量（`YXG_TYPES`，`lib/cctv.js:50-80`）

| typeId | 名称 | channelid | fc | 子分类参数 | 子分类选项 |
|--------|------|-----------|----|-----------|-----------|
| `tv` | 电视剧 | `CHAL1460955853485115` | 电视剧 | `area` | 全部/内地（大陆）/港澳台/欧美/其他 |
| `animation` | 动画片 | `CHAL1460955899450127` | 动画片 | `area` | 全部/内地（大陆）/港澳台/欧美 |
| `special` | 特别节目 | `CHAL1460955953877151` | 特别节目 | `sc` | 全部/新闻/经济/综艺/体育/军事/影视/科教/戏曲/青少/音乐/社会/文化/公益/其他 |

> 子分类参数的选择逻辑：`extraName === '地区'` 用 `area`，否则用 `sc`（`lib/cctv.js:226`）。

### 3.5 调用示例

```bash
# 电视剧，全部地区，第 1 页
curl -sL --compressed -A "Mozilla/5.0" \
  "https://api.cntv.cn/list/getVideoAlbumList?channelid=CHAL1460955853485115&area=&sc=&fc=%E7%94%B5%E8%A7%86%E5%89%A7&year=&letter=&p=1&n=24&serviceId=tvcctv&topv=1&t=json"

# 电视剧，地区=欧美（实测 total=30）
curl -sL --compressed -A "Mozilla/5.0" \
  "https://api.cntv.cn/list/getVideoAlbumList?channelid=CHAL1460955853485115&area=%E6%AC%A7%E7%BE%8E&sc=&fc=%E7%94%B5%E8%A7%86%E5%89%A7&year=&letter=&p=1&n=24&serviceId=tvcctv&topv=1&t=json"

# 特别节目，类型=军事
curl -sL --compressed -A "Mozilla/5.0" \
  "https://api.cntv.cn/list/getVideoAlbumList?channelid=CHAL1460955953877151&area=&sc=%E5%86%9B%E4%BA%8B&fc=%E7%89%B9%E5%88%AB%E8%8A%82%E7%9B%AE&year=&letter=&p=1&n=24&serviceId=tvcctv&topv=1&t=json"
```

### 3.6 响应结构

```json
{
  "data": {
    "total": 1160,
    "list": [
      {
        "title": "《爱在山海间》",
        "brief": "以苏可为代表的援藏医疗队进驻西部藏区藏安县中心医院……",
        "image": "https://p1.img.cctvpic.com/photoAlbum/vms/image/3918647a93c34386565e6220ee5d5ff0.jpg",
        "image2": "https://p1.img.cctvpic.com/photoAlbum/vms/image/3918647a93c34386565e6220ee5d5ff0.jpg",
        "image3": "https://p1.img.cctvpic.com/photoAlbum/vms/image/3918647a93c34386565e6220ee5d5ff0.jpg",
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

### 3.7 响应字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.total` | number | 当前筛选条件下的总条数 |
| `data.list[].title` | string | 专辑标题 |
| `data.list[].brief` | string | 剧情简介 |
| `data.list[].image` / `image2` / `image3` | string | 封面图，代码优先取 `image2` |
| `data.list[].url` | string | **专辑页地址（VIDA）**，作为内容 ID 的来源 |
| `data.list[].area` | string | 地区 |
| `data.list[].year` | string | 年份 |
| `data.list[].sc` | string | 子类型（如「农村」） |
| `data.list[].fc` | string | 分类名 |
| `data.list[].actors` | string | 主演，逗号分隔 |
| `data.list[].count` | string | 集数 |
| `data.list[].vsetid` | string | 央视视频集 ID |
| `data.list[].id` | string | 专辑 ID |
| `data.list[].focus_date` | number | 时间戳（毫秒） |
| `data.list[].video` | object | 首集信息（url/id/title/image），代码未使用（分集走接口 C） |

### 3.8 内部字段映射（`getYxgCatalog`，`lib/cctv.js:255-272`）

| API 字段 | 内部 Album 字段 | 备注 |
|----------|----------------|------|
| `url` | `url` | 仅保留匹配 `/\/VIDA\w+\.shtml/` 的项 |
| `title` | `title` | HTML 实体解码 |
| `image2` → `image` | `poster` | 首选 image2 |
| `brief` | `description` | 参与搜索匹配 |
| `area` / `year` / `actors` | 同名 | 参与搜索匹配 |
| `count` | `count` | 集数 |

### 3.9 数据量实测

| 类型 | total |
|------|-------|
| 电视剧 | 1160 |
| 动画片 | 1136 |
| 特别节目 | 2000 |
| 电视剧·欧美 | 30 |

---

## 4. 接口 C：专辑页（VIDA）

### 4.1 用途

获取专辑的标题、封面、简介和**分集列表**。四类内容（纪录片/电视剧/动画片/特别节目）的专辑页结构一致，共用此接口解析。

### 4.2 端点

```
GET https://tv.cctv.com/YYYY/MM/DD/VIDA<id>.shtml
```

示例：`https://tv.cctv.com/2026/09/28/VIDAMniIPhrsBrSROetQt5RF260928.shtml`

### 4.3 调用示例

```bash
curl -sL --compressed -A "Mozilla/5.0" \
  "https://tv.cctv.com/2026/09/28/VIDAMniIPhrsBrSROetQt5RF260928.shtml" -o album.html

# 统计分集链接
grep -oE 'https?://tv\.cctv\.com/[0-9]{4}/[0-9]{2}/[0-9]{2}/VIDE[A-Za-z0-9]+\.shtml' album.html | sort -u | wc -l
```

### 4.4 解析规则（`getAlbumMeta`，`lib/cctv.js:340-360`）

| 项目 | 提取方式 | 说明 |
|------|----------|------|
| 标题 | `<title>([^<]+)</title>` | 去除 `_CCTV节目官网…`、`_央视网…` 后缀 |
| 封面 | `<meta property="og:image" content="…">` | 兼容 `content` 与 `property` 属性顺序互换的写法 |
| 简介 | `<meta name="description" content="…">` | 兼容属性名带引号/不带引号，兼容 `content` 在 `name` 之前（`parseMetaTag`） |
| 分集 | 页面中全部 VIDE 链接 | 由 `parseEpisodes` 提取 |

### 4.5 分集提取正则（`parseEpisodes`，`lib/cctv.js:316-338`）

```js
/href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/(VIDE\w+)\.shtml)"[^>]*title="([^"]*)"/gi
/title="([^"]*)"[^>]*href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/(VIDE\w+)\.shtml)"/gi
```

按 VIDE ID 去重；标题为空时回退为「第 N 集」。

### 4.6 实测

- 电视剧《爱在山海间》专辑页：约 194 KB，140 个去重 VIDE 分集链接，简介 237 字；
- 纪录片《董必武在华北》：5 集；
- 部分早期专辑页返回 404 或 2.5 KB 空页（见第 8 节）。

---

## 5. 接口 D：单集页（VIDE）

### 5.1 用途

从单集页提取 32 位十六进制的 CNTV **guid**，作为接口 E 的 `pid` 参数。这是获取播放地址的必经步骤。

### 5.2 端点

```
GET https://tv.cctv.com/YYYY/MM/DD/VIDE<id>.shtml
```

示例：`https://tv.cctv.com/2026/10/26/VIDE76ZCgAlPXkyYuW2uv5Lp261026.shtml`

### 5.3 调用示例

```bash
curl -sL --compressed -A "Mozilla/5.0" \
  "https://tv.cctv.com/2026/10/26/VIDE76ZCgAlPXkyYuW2uv5Lp261026.shtml" \
  | grep -oE 'var guid[[:space:]]*=[[:space:]]*"[0-9a-f]{32}"' | head -1
```

### 5.4 提取规则（`getGuidFromEpisode`，`lib/cctv.js:363-368`）

```js
/var\s+guid\s*=\s*"([0-9a-f]{32})"/i   // 优先：带 var 声明
/guid\s*=\s*"([0-9a-f]{32})"/i         // 兜底：仅赋值形式
```

返回 32 位小写十六进制字符串，例如：`e83c0777b488446bb176aecbdb1c2aad`。

### 5.5 注意事项

- guid 不是页面 URL 中的 VIDE ID，两者是不同的标识体系；
- 无法从专辑页批量获取所有分集的 guid（专辑页中的 32 位字符串多为图片文件名/Cookie），必须逐集访问单集页；
- 实现上通过并发池与缓存缓解开销（单集页缓存 12 小时）。

---

## 6. 接口 E：播放地址 API

### 6.1 用途

用 guid 换取 HLS 播放地址。

### 6.2 端点

```
GET https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=<guid>
```

### 6.3 参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `pid` | 接口 D 提取的 32 位 guid | `e83c0777b488446bb176aecbdb1c2aad` |

### 6.4 调用示例

```bash
curl -sL --compressed -A "Mozilla/5.0" \
  "https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=e83c0777b488446bb176aecbdb1c2aad" \
  | python3 -m json.tool | head -40
```

### 6.5 关键返回字段

| 字段 | 说明 |
|------|------|
| `hls_url` | HLS 主地址，形如 `https://<域名>/asp/hls/main/0303000a/3/default/<guid>/main.m3u8?maxbr=…` |
| `video.chapters4` / `chapters3` / `chapters2` / `chapters1` | 旧版 MP4 分章数组，含 `url`、`title` 等 |
| `title` | 视频标题 |

### 6.6 实测发现

**MP4 直链已失效**：当前 `video.chaptersX[].url` 全部为空字符串，这是央视的现行行为。`hls_url` 是唯一可用的播放地址来源。

代码中保留降级逻辑（`lib/cctv.js:393-402`）：若四档构造失败，依次检查 `chapters4 → chapters3 → chapters2 → chapters`，取第一个非空 `url` 作为单档「标准」流。

---

## 7. 接口 F：HLS 播放流

### 7.1 用途

由接口 E 返回的 `hls_url` 构造四档清晰度的独立 m3u8 地址，供 Stremio 播放器直接加载。

### 7.2 地址构造规则

**原始 hls_url**：

```
https://<域名>/asp/hls/main/<路径>/main.m3u8?maxbr=…
```

**构造公式**（`buildQualityStreams`，`lib/cctv.js:371-380`）：

```
{域名部分}/asp/hls/{码率}/{路径}/{码率}.m3u8
```

即将 `main` 路径段与 `main.m3u8` 文件名中的 `main` 都替换为码率数字，并去掉 query 参数。

**正则**：

```js
/^(https?:\/\/[^/]+\/asp\/hls\/)main(\/[^?]+\/)main\.m3u8/i
```

**构造代码**：

```js
`${m[1]}${q.code}${m[2]}${q.code}.m3u8`
```

### 7.3 四档码率（真实分辨率，v3.0.1 修正）

**重要（v3.2.0 最终结论）**：早期版本从 `hls_url` 的 `/asp/hls/{码率}/` 路径构造四档，但当时只用 master 的第一档（450），误判为"全部只有 480×270"。实际上稳定域名 `hls.cntv.lxdns.com` 的 `/asp/hls/{码率}/` 四档是**真实且解码正常**的。v3.0.1～v3.1.0 曾改用 `manifest.hls_enc_url` 的 `/asp/enc/hls/`，但其分片 H264 码流损坏导致花屏，v3.2.0 已全部改回稳定路径。

| 码率 code | master 声明 | 实测分辨率（ffprobe） | addon 名称 |
|-----------|------------|---------------------|-----------|
| `2000` | 1280x720 | 1280×720 | 高清 720P 高码率 |
| `1200` | 1280x720 | 1280×720 | 高清 720P 1229kbps |
| `850` | 640x360 | 640×360 | 流畅 640x360 |
| `450` | 480x270 | 480×270 | 流畅 480x270 |

**结论：央视最高只提供 720P，不存在 1080P。** 两档 720P 分辨率相同、码率不同。

### 7.4 构造示例（v3.2.0 稳定路径）

master 只用于读取"有哪些档位"，实际 URL 一律用稳定域名 + `/asp/hls/` 路径重建：

```
读取档位（来自 API 的 manifest.hls_enc_url master）:
https://dhls.cntv.kcdnvip.com/asp/enc/hls/main/.../main.m3u8?maxbr=2048&contentid=…

用稳定路径重建并逐档探测后返回:
https://hls.cntv.lxdns.com/asp/hls/2000/0303000a/3/default/<guid>/2000.m3u8  （高清 720P 高码率）
https://hls.cntv.lxdns.com/asp/hls/1200/0303000a/3/default/<guid>/1200.m3u8  （高清 720P 1229kbps）
https://hls.cntv.lxdns.com/asp/hls/850/0303000a/3/default/<guid>/850.m3u8   （流畅 640x360）
https://hls.cntv.lxdns.com/asp/hls/450/0303000a/3/default/<guid>/450.m3u8   （流畅 480x270）
```

4K 内容在稳定路径只有 `4000` 一档（1920×1080）：

```
https://hls.cntv.lxdns.com/asp/hls/4000/0303000a/3/default/<guid>/4000.m3u8  （超清 1080P 高码率）
```

**不要使用 `asp/enc/hls/` 的分档地址**：虽然 HTTP 200，但 H264 码流损坏（ffmpeg 报 `top block unavailable` / `error while decoding MB`），播放花屏。

### 7.4.1 域名/路径兼容性矩阵（2026-11-28 实测）

| 域名 | `/asp/hls/` | `/asp/enc/hls/` |
|------|------------|----------------|
| `hls.cntv.lxdns.com` | **200，解码正常（采用）** | 404 |
| `dhls.cntv.lxdns.com` | 403 | 200，码流损坏 |
| `dhls.cntv.qcloudcdn.com` | 403 | 200，码流损坏 |
| `dhls.cntv.kcdnvip.com` | 403 | 200，码流损坏 |
| `dhls2.cntv.cdn20.com` | 403 | 403 |
| `dh5wswx02.v.cntv.cn` | 403 | 403 |
| `dhlswx.cntv.kfcbest.com` | 403 | 200，码流损坏 |

### 7.5 调用示例

```bash
GUID=e83c0777b488446bb176aecbdb1c2aad
for br in 2000 1200 850 450; do
  echo "=== $br ==="
  curl -sL --compressed -A "Mozilla/5.0" \
    "https://hls.cntv.lxdns.com/asp/hls/$br/0303000a/3/default/$GUID/$br.m3u8" | head -3
done
```

### 7.6 实测域名

- `hls.cntv.lxdns.com`
- `newcntv.qcloudcdn.com`（用户电视端日志中出现的实际域名）

四档地址均实测返回 HTTP 200、`#EXTM3U` 有效的 m3u8 内容。

### 7.7 返回给 Stremio 的流对象

```js
{
  url: "https://.../2000.m3u8",
  name: "超清 1080P",
  behaviorHints: { notWebReady: false }
}
```

---

## 8. 关键发现与约束

### 8.1 MP4 直链已置空

`video.chaptersX[].url` 字段当前全部为空，只有 HLS 可用。addon 完全基于 HLS 构造播放源。

### 8.2 官方 master m3u8 只有一档

央视官方 `main.m3u8` 只提供 450 码率，这是播放清晰度偏低的根因。addon 通过直接构造四档独立地址绕过该限制。

### 8.3 无公开搜索 API

实测以下端点均不可用：

| 端点 | 返回 |
|------|------|
| `api.cntv.cn/search/getResultByKeyword` | `{"errcode":"1200","msg":"path not found"}` |
| `api.cntv.cn/NewVideo/search` | `{"errcode":"1100","msg":"拒绝访问"}` |
| `search.cntv.cn/api/search` | 空响应 |

因此搜索采用本地聚合过滤（接口 A + B 的数据）。

### 8.4 失效专辑条目

少量早期专辑页返回 404 或 2.5 KB 空页，日志表现：`HTTP 404 for https://tv.cctv.com/2017/11/07/VIDA….shtml`。这属于源站数据问题，addon 的 meta handler 返回 `{ meta: null }`，诊断端点会自动跳过前 8 张中的失效项。

### 8.5 播放地址动态签发

m3u8 地址由 CDN 动态签发，存在有效期。addon 对播放流结果缓存 30 分钟，过期后自动重新解析。

### 8.6 合规边界

以上接口均为央视网公开接口。本项目仅解析公开播放地址，不存储、不转存任何视频内容，仅供家庭个人观看，请遵守相关版权规定。

---

## 9. 附录：速查表

### 9.1 接口端点速查

| 接口 | 端点模板 |
|------|----------|
| A | `https://jishi.cctv.com/doc/{栏目}/index.shtml` |
| B | `https://api.cntv.cn/list/getVideoAlbumList?channelid=…&fc=…&p=…&n=24&serviceId=tvcctv&topv=1&t=json` |
| C | `https://tv.cctv.com/{yyyy}/{MM}/{dd}/VIDA{id}.shtml` |
| D | `https://tv.cctv.com/{yyyy}/{MM}/{dd}/VIDE{id}.shtml` |
| E | `https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid={guid}` |
| F | `https://{cdn}/asp/hls/{码率}/{路径}/{码率}.m3u8` |

### 9.2 channelid 速查

| 类型 | channelid |
|------|-----------|
| 电视剧 | `CHAL1460955853485115` |
| 动画片 | `CHAL1460955899450127` |
| 特别节目 | `CHAL1460955953877151` |

### 9.3 码率速查

| code | 名称 |
|------|------|
| 2000 | 超清 1080P |
| 1200 | 高清 720P |
| 850 | 标准 480P |
| 450 | 流畅 360P |

### 9.4 缓存 TTL 速查

| 数据 | TTL |
|------|-----|
| 纪录片/电视剧/动画片/特别节目 catalog | 6 小时 |
| 专辑 meta、单集页 HTTP 文本 | 12 小时 |
| 播放流 | 30 分钟 |

### 9.5 代码位置速查

| 功能 | 文件:行 |
|------|---------|
| 栏目映射 CATALOG_SOURCES | `lib/cctv.js:10-32` |
| 分类映射 CATEGORIES | `lib/cctv.js:35-46` |
| yxg 配置 YXG_TYPES | `lib/cctv.js:50-80` |
| 四档码率 QUALITIES | `lib/cctv.js:82-87` |
| parseAlbumList | `lib/cctv.js:150-180` |
| getCatalog | `lib/cctv.js:182-210` |
| getYxgCatalog | `lib/cctv.js:216-276` |
| searchCatalog | `lib/cctv.js:280-313` |
| parseEpisodes | `lib/cctv.js:316-338` |
| getAlbumMeta | `lib/cctv.js:340-360` |
| getGuidFromEpisode | `lib/cctv.js:363-368` |
| buildQualityStreams | `lib/cctv.js:371-380` |
| getStreamsForEpisode | `lib/cctv.js:382-409` |
| httpGet / cache / mapLimit | `lib/fetch.js` |

---

## 10. 接口 G：4K 专区片单 API

### 10.1 用途

获取 4K 专区首页的全部专辑列表，按 `fc` 字段过滤出「电视剧 / 科教」。

### 10.2 端点

```
https://api.cntv.cn/NewVideo/getLastVideoList4K
```

### 10.3 参数

| 参数 | 值 | 说明 |
|------|----|------|
| `serviceId` | `cctv4k` | 固定 |
| `cid` | `CHAL1558416868484111` | 4K 专区频道 ID |
| `p` | 1..3 | 页码（单页上限 100，共 211 条） |
| `n` | `100` | 每页条数 |
| `t` | `json` | 返回格式（页面原用 `jsonp` + `cb=Callback`） |

### 10.4 调用示例

```bash
curl 'https://api.cntv.cn/NewVideo/getLastVideoList4K?serviceId=cctv4k&cid=CHAL1558416868484111&p=1&n=100&t=json'
```

### 10.5 响应字段

`data.list[]` 每条：

| 字段 | 说明 |
|------|------|
| `id` | VIDA 专辑 ID（**对应页面实测 404，不可直接访问**） |
| `title` | 专辑名（可能带「4K」后缀） |
| `fc` | 一级分类：电视剧 / 科教 / 纪录片 / 新闻 / 综艺 / 动画片 / 特别节目 / 生活 / 青少 |
| `sc` | 题材（如「革命」「文化」） |
| `ep_count` | 标称集数 |
| `image2` / `image` | 专辑封面 |
| `vsetid` | 视频集 ID |
| `last_video` | 最后/最新一集：`id`、`guid`、`title`、`url`、`image`、`keywords`、`part` |

### 10.6 实测分布（211 条）

| 分类 | 条数 |
|------|------|
| 纪录片 | 88 |
| 电视剧 | 83 |
| 特别节目 | 22 |
| 科教 | 4 |
| 动画片 / 青少 | 各 4 |
| 新闻 / 生活 / 综艺 | 各 2 |

addon 只取「电视剧 + 科教」共 87 条。

---

## 11. 接口 H：4K 单集信息 API

### 11.1 用途

从 4K 单集页的 guid 反查所属专辑，这是还原完整分集的关键一步。4K 页面 JS（`20200107index_x.js`）即调用此接口。

### 11.2 端点

```
https://api.cntv.cn/video/videoinfoByGuid?serviceId=cctv4k&guid=<32位guid>&t=json
```

### 11.3 调用示例

```bash
curl 'https://api.cntv.cn/video/videoinfoByGuid?serviceId=cctv4k&guid=2d04daf5e7044d419e86ef1bcd784cd2&t=json'
```

### 11.4 关键返回字段

| 字段 | 示例 | 用途 |
|------|------|------|
| `album_id` | `VIDAwCC9FPsO5ltgUh4vaHmL240813` | 传给接口 I 拉完整分集 |
| `vset_title` | `《山海经奇》4K` | 剧集名（优于单集页 title） |
| `vset_brief` | 长文本 | 剧集简介 |
| `vset_sc` | `人文历史` | 题材 |
| `title` | `《山海经奇》 第1集 …` | 当前单集标题 |
| `brief` | 长文本 | 当前单集简介 |
| `img` | 图片 URL | 当前单集缩略图 |
| `order` / `tnum` | `1` / `16` | 集序 / 标称总集数 |
| `chid` | `CHAL1558416868484111` | 4K 频道 ID |

> 注意：接口 G 给出的 `id`（VIDA）与这里的 `album_id` 可能不同。以 `videoinfoByGuid` 返回的 `album_id` 为准。

---

## 12. 接口 I：4K 完整分集列表 API

### 12.1 用途

按 `album_id` 分页拉取完整分集列表，**每集带独立缩略图**。这是 4K 目录能展开为整部剧的依据。

### 12.2 端点

```
https://api.cntv.cn/NewVideo/getVideoListByAlbumIdNew
```

### 12.3 参数

| 参数 | 值 | 说明 |
|------|----|------|
| `id` | `album_id` | 来自接口 H |
| `serviceId` | `cctv4k` | 固定 |
| `p` | 1, 2, 3… | 页码 |
| `n` | `12` | 页面 JS 使用 12 |
| `sort` | `asc` | 正序 |
| `mode` | `0` | 固定 |
| `pub` | `2` | 固定 |
| `t` | `json` | 返回格式 |

### 12.4 调用示例

```bash
curl 'https://api.cntv.cn/NewVideo/getVideoListByAlbumIdNew?id=VIDAwCC9FPsO5ltgUh4vaHmL240813&serviceId=cctv4k&p=1&n=12&sort=asc&mode=0&pub=2&t=json'
```

### 12.5 响应字段

`data.total` 为总集数，`data.list[]` 每集：

| 字段 | 说明 |
|------|------|
| `id` | VIDE 单集 ID |
| `title` | 分集标题 |
| `url` | 分集页面 URL（用于 stream 链路） |
| `guid` | 播放 guid |
| `image` | **该集缩略图**，映射为 Stremio `video.thumbnail` |
| `brief` | 该集简介 |
| `length` | 时长，如 `00:24:19` |
| `focus_date` / `time` | 发布时间 |

### 12.6 实测结果

| 专辑 | 总集数 | 缩略图 |
|------|--------|--------|
| 《山海经奇》4K | 16 | 16/16 |
| 《绝密使命》 | 32 | 有 |
| 《考古公开课》4K | 53 | 有 |

### 12.7 内部实现

`lib/cctv.js` 的 `get4KAlbumMeta(url)`：
1. 从单集页提取 guid（复用 `getGuidFromEpisode`）；
2. 调接口 H 取 `album_id` 与专辑信息；
3. 调接口 I 第 1 页取 `total`，按 `Math.ceil(total/12)` 并发拉剩余页（最多 10 页）；
4. 去重后生成 episodes（含 `image` 缩略图），缓存 12 小时；
5. 若任一步失败，回退为原单集条目（1 集）。

ID 前缀 `cctv.4k.` 用于让 meta handler 识别 4K 条目并走此链路。

---

*文档完*
