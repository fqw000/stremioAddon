
前置备注：仅用于技术研究；不存在官方稳定接口的源使用占位适配器，严禁编造可访问假接口；区分内部调试数据与返回给 Stremio 的协议；ijk 配置仅文档参考，不能输出到 Addon 返回流。
你是资深 Node.js + TypeScript Stremio Addon v3 开发工程师，请构建一套规范、可部署、带完整日志调试体系的多源 Stremio addon。

## 项目整体目标
将一批国内影视源封装为标准 Stremio addon；各个源保持独立，不合并不同源结果。
两条独立业务通路：
通路 1：用户在 Stremio 主动搜索 / 浏览目录。分别调用各个源原生搜索接口，每个源返回独立 catalog / meta，带上来源标记。
通路 2：外部 meta（其他 addon、官方 meta）发起 stream 请求并携带 imdbid。使用 imdbid 获取标准化元数据（优先 TMDB 获取中文译名、别名、年份、类型、季集；国产片可降级使用豆瓣辅助；必要时回退 IMDB）；使用标准化名称、别名、年份、季集信息在各源搜索；通过匹配打分筛选候选资源；拿到播放地址后进入 HLS 广告清洗模块，最后返回净化后的流入口。
本 addon 自身 meta 请求也可以走这套匹配链路。

## 源定义、接口与适配器约定
所有源独立适配器；优先实现暴风、非凡、量子、索尼；其余源作为扩展占位适配器。所有 baseUrl、接口路径、请求头、超时、重试、功能开关全部配置化，支持单源关闭、单独开启/关闭搜索、元数据拉取、广告清洗。
如果没有稳定公开 API，生成占位适配器并清晰注释待采集信息；如果仅有网页，预留网页抓取分支；如果接口需要 UA、Referer、Cookie、动态签名，全部放到配置层。

### 1. 暴风 bfzy
标识：bfzy
常见域名：bfzy, bfbfvip, bfengbf
标准 MacCMS 范式：
- search: /api.php/provide/vod/?ac=search&wd={keyword}
- detail: /api.php/provide/vod/?ac=detail&ids={id}
- 播放地址提取自 vod_play_url / vod_play_from
清洗：使用暴风专属正则组。

### 2. 非凡 ffzy
标识：ffzy
常见域名：vip.ffzy, hd.ffzy, super.ffzy, cachem3u8.2s0
部分版本为标准 MacCMS：
- search: /api.php/provide/vod/?ac=search&wd={keyword}
- detail: /api.php/provide/vod/?ac=detail&ids={id}
- 如果返回包含豆瓣标识，提取作为辅助匹配字段
清洗：非凡专属正则集合。

### 3. 量子 lz
标识：lz
常见域名：vip.lz, hd.lz, .cdnlz
如果是 CMS，沿用 MacCMS 搜索、详情范式；如果是自定义接口，编写自定义解析函数；大量依靠 #EXT-X-DISCONTINUITY 区间识别广告。

### 4. 索尼 suonizy
标识：suonizy
host：suonizy
无稳定公开 API 则生成占位适配器；仿照 MacCMS 范式预留搜索、详情、播放提取；使用索尼独立清洗正则。

### 扩展源（占位适配器）
- 快看 kuaikan：标识 kuaikan；内置对应清洗规则；接口占位
- leshiyun：标识 leshiyun；host leshiyuncdn；接口占位
- 看影网 fentvoss：标识 fentvoss；接口占位
- 1080zyk：标识 1080zyk；域名包含 yzzy.play、cdn.yzzy、yzzy-dy；接口占位
- dytt：标识 dytt；dytt-hot；接口占位
- ikun：标识 ikun；bfikuncdn；接口占位
- 黑木耳 hmr：标识 hmr；hmrvideo；接口占位
- ryplay：标识 ryplay；cdn.ryplay；接口占位
- 555DM：标识 555DM；cqxfjz；接口占位
- 海外看：标识 haiwaikan；接口占位

### 源返回统一映射
每个源原始输出统一提取内部模型字段：
- sourceId：源内部 ID
- title：原始标题
- year：年份
- poster：海报链接
- desc：简介
- actors：演员数组
- genres：类型数组
- isSeries：标记是否剧集
- season / episode：季、集（如果存在）
- playItems：多线路播放地址列表
- sourceLabel：来源展示文本，例如「非凡｜ffzy」
缺失字段可以用元数据服务回填；无法获取则留空。

## 核心模块
### 1. Addon 协议层
严格遵循 Stremio addon v3 规范：manifest、catalog、search、meta、stream。
- catalog：每个源独立 catalog；
- search：用户搜索词直接分发到各源适配器；
- meta：返回标准化 meta；区分本 addon meta 和外部元；
- stream：
  - 如果携带 imdbid：走元数据匹配链路；
  - 如果是本 addon 内部资源标识：直接拉取对应源；
  - 如果匹配多个候选，返回多条 stream，标记来源；
  - 如果置信度过低，返回候选或者无结果；
  - 如果是剧集，尝试匹配季、集。

### 2. 元数据 & ID 匹配模块
- imdbid → 查询 TMDB，获取中文片名、别名、原名、年份、类型、季集；
- 如果 TMDB 信息不足，支持可开关的豆瓣辅助查询；
- 匹配打分器：文本相似度、年份强校验、类型、季集匹配；输出置信分数；
- 如果译名差异巨大、重名，降低置信；置信低时不强行匹配；
- 用户直接搜索通路不需要 ID 转换，直接使用搜索词调用源。

### 3. HLS / m3u8 广告清洗模块
使用下面提供的整套规则：按源分组正则、主机匹配、独立广告域名黑名单。
清洗规则：
- 拉取原始 manifest；命中广告规则则剔除广告片段；
- **只清洗清单，分片保留原始真实地址，不中转分片；**
- 如果是 master playlist，递归处理子清单；子清单入口走清洗接口；
- 如果正则命中异常、大量删除片段、识别不确定，自动降级，原样返回原始流；
- 如果原始地址不是直接可解析 m3u8，跳过清洗；
- 配置中的 ijk 解码参数仅作为参考文档，禁止嵌入返回给 Stremio 的流。

```json
{
    "rules":[
        {"host":"www.iesdouyin.com","rule":["playwm/?video_id="]},
        {"host":"www.ysgc.vip","rule":["getm3u8?url=http"]},
        {"host":"v.douyin.com","rule":["playwm/?video_id="]},
        {"host": "dyxs20.com","rule": [".m3u8"]},
        {"host": "www.agemys.cc","rule": ["cdn-tos","obj/tos-cn"]},
        {"host": "shturl.cc/kw314KJ","rule": ["http.*?/play.{0,3}\\?[^url]{2,8}=.*","qianpailive.com","vid="]},
        {
        "name": "暴风",
        "hosts": [
            "bfzy",
            "bfbfvip",
            "bfengbf"
        ],
        "regex": [
            "#EXTINF.*?\\s+.*?adjump.*?\\.ts"
        ]
    },
    {
        "name": "量子",
        "hosts": [
            "vip.lz",
            "hd.lz",
            ".cdnlz"
        ],
        "regex": [
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:7\\.166667,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXTINF.*?\\s+.*?08646.*?\\.ts",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF.*?6\\.667,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXTINF.*?\\s+.*?48234.*?\\.ts",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF.*?7\\.067,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "17.19",
            "19.63"
        ]
    },
    {
        "name": "非凡",
        "hosts": [
            "vip.ffzy",
            "hd.ffzy",
            "super.ffzy",
            "cachem3u8.2s0"
        ],
        "regex": [
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6\\.400000,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6\\.666667,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXTINF.*?\\s+.*?1171(057).*?\\.ts",
            "#EXTINF.*?\\s+.*?6d7b(077).*?\\.ts",
            "#EXTINF.*?\\s+.*?6718a(403).*?\\.ts",
            "17.99",
            "14.45"
        ]
    },
    {
        "name": "索尼",
        "hosts": [
            "suonizy"
        ],
        "regex": [
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:1\\.000000,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXTINF.*?\\s+.*?p1ayer.*?\\.ts",
            "#EXTINF.*?\\s+.*?\\/video\\/original.*?\\.ts"
        ]
    },
    {
        "name": "快看",
        "hosts": [
            "kuaikan"
        ],
        "regex": [
            "#EXT-X-KEY:METHOD=NONE\\r*\\n*#EXTINF:5,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-KEY:METHOD=NONE\\r*\\n*#EXTINF:2\\.4,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-KEY:METHOD=NONE\\r*\\n*#EXTINF:1\\.467,[\\s\\S]*?#EXT-X-DISCONTINUITY"
        ]
    },
    {
        "name": "leshiyun",
        "hosts": [
            "leshiyuncdn"
        ],
        "regex": [
            "15.92"
        ]
    },
    {
        "name": "看影网",
        "hosts": [
            "fentvoss"
        ],
        "regex": [
            "38.68",
            "38.12",
            "38.80",
            "30.08",
            "44.00",
            "36.80",
            "40.68",
            "29.08",
            "29.28",
            "24.88"
        ]
    },
    {
    "name": "1080zyk",
    "hosts": [
      "-playback",
      "yzzy.play",
      "cdn.yzzy",
      "yzzy-dy"
    ],
    "regex": [
      "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6\\.666667,[\\s\\S]*?#EXT-X-DISCONTINUITY",
      "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6\\.633333,[\\s\\S]*?#EXT-X-DISCONTINUITY",
      "16.63",
      "16.45",
      "16.46",
      "17.66"
    ]
  },
    {
        "hosts": [
            "dytt-hot"
        ],
        "name": "dytt",
        "regex": [
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:1\\.800000,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:3\\.600000,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6\\.566667,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:5\\.700,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:3\\.900,[\\s\\S]*?#EXT-X-DISCONTINUITY"
        ]
    },
    {
        "name": "ikun",
        "hosts": [
            "bfikuncdn"
        ],
        "regex": [
            "#EXTINF.*?\\s+.*?XR8pDxQk.*?\\.ts",
            "#EXTINF.*?\\s+.*?p5XQill8.*?\\.ts"
        ]
    },
    {
        "name": "黑木耳hmr",
        "hosts": [
            "hmrvideo"
        ],
        "regex": [
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:3\\.366667,[\\s\\S]*?#EXT-X-DISCONTINUITY"
        ]
    },
    {
        "name": "ryplay",
        "hosts": [
            "cdn.ryplay"
        ],
        "regex": [
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6\\.633333,[\\s\\S]*?#EXT-X-DISCONTINUITY",
            "#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:8\\.333333,[\\s\\S].*?\\.ts",
            "#EXTINF:2\\.933333,[\\s\\S].*?\\.ts"
        ]
    },
    {
        "name": "555DM",
        "hosts": [
            "cqxfjz"
        ],
        "regex": [
            "10.56"
        ]
    },
    {
        "name": "海外看",
        "hosts": [
            "haiwaikan"
        ],
        "regex": [
            "10.0099",
            "10.3333",
            "10.85"
        ]
    },
        {"name":"磁力广告","hosts":["magnet"],"regex":["更多","社 區","x u u","最 新","更 新","社 区","有趣","有 趣","英皇体育","全中文AV在线","澳门皇冠赌场","哥哥快来","美女荷官","裸聊","新片首发","UUE29"]}
    ],
    "ijk":[
        {"group":"软解码","options":[{"category":4,"name":"opensles","value":"0"},{"category":4,"name":"overlay-format","value":"842225234"},{"category":4,"name":"framedrop","value":"1"},{"category":4,"name":"soundtouch","value":"1"},{"category":4,"name":"start-on-prepared","value":"1"},{"category":1,"name":"http-detect-range-support","value":"0"},{"category":1,"name":"fflags","value":"fastseek"},{"category":2,"name":"skip_loop_filter","value":"48"},{"category":4,"name":"reconnect","value":"1"},{"category":4,"name":"enable-accurate-seek","value":"0"},{"category":4,"name":"mediacodec","value":"0"},{"category":4,"name":"mediacodec-auto-rotate","value":"0"},{"category":4,"name":"mediacodec-handle-resolution-change","value":"0"},{"category":4,"name":"mediacodec-hevc","value":"0"},{"category":1,"name":"dns_cache_timeout","value":"600000000"}]},
        {"group":"硬解码","options":[{"category":4,"name":"opensles","value":"0"},{"category":4,"name":"overlay-format","value":"842225234"},{"category":4,"name":"framedrop","value":"1"},{"category":4,"name":"soundtouch","value":"1"},{"category":4,"name":"start-on-prepared","value":"1"},{"category":1,"name":"http-detect-range-support","value":"0"},{"category":1,"name":"fflags","value":"fastseek"},{"category":2,"name":"skip_loop_filter","value":"48"},{"category":4,"name":"reconnect","value":"1"},{"category":4,"name":"enable-accurate-seek","value":"0"},{"category":4,"name":"mediacodec","value":"1"},{"category":4,"name":"mediacodec-auto-rotate","value":"1"},{"category":4,"name":"mediacodec-handle-resolution-change","value":"1"},{"category":4,"name":"mediacodec-hevc","value":"1"},{"category":1,"name":"dns_cache_timeout","value":"600000000"}]}
    ],
    "ads":["mimg.0c1q0l.cn","www.googletagmanager.com","www.google-analytics.com","shturl.cc/5ZeD","mg.g1mm3d.cn","mscs.svaeuzh.cn","cnzz.hhttm.top","tp.vinuxhome.com","cnzz.mmstat.com","shturl.cc/2mrEdnd","s23.cnzz.com","z3.cnzz.com","c.cnzz.com","stj.v1vo.top","z12.cnzz.com","s13.cnzz.com","z6.cnzz.com","s9.cnzz.com","z5.cnzz.com","xc.hubeijieshikj.cn","tj.tianwenhu.com","xg.gars57.cn","k.jinxiuzhilv.com","cdn.bootcss.com","ppl.xunzhuo123.com","xomk.jiangjunmh.top","img.xunzhuo123.com","z1.cnzz.com","s13.cnzz.com","xg.huataisangao.cn","z7.cnzz.com","s4.cnzz.com","f5w.as12df.top","ae01.alicdn.com","shturl.cc/A3","shturl.cc/NoK","vivovip.mmszxc.top","qiu.xixiqiu.com","cdnjs.hnfenxun.com","shturl.cc/ZU8k","shturl.cc/RDy"]
}
4. 缓存层

使用 Upstash（Redis）：

• imdbid / tmdbid → 标准化元数据：较长 TTL；

• 各源搜索结果；

• 解析后的播放地址：短 TTL，适配时效签名；

• 别名库、广告清洗规则；

• 添加缓存穿透保护；缓存失效时重新拉取。

5. 部署与配置

• GitHub：托管源码、配置、广告正则；支持启动拉取配置、可选热重载规则；

• Render：部署主 addon 服务；支持本地开发模式；

• 配置分离：环境变量 + JSON 配置；包含源地址、密钥、超时、各类开关。

6. 日志、调试、监控体系（必须完整）

分级日志： debug / info / warn / error

• debug：原始入参、源原始返回、匹配打分详情、清洗前后 m3u8、正则命中；

• info：搜索命中、匹配成功、流返回、缓存命中/未命中；

• warn：低置信匹配、疑似误删、译名差异、源异常；

• error：源超时、解析失败、元数据拉取失败；

• 控制台彩色日志；同时支持结构化 JSON 输出；生产环境可关闭 verbose debug。

调试接口：

• /debug/match：输入 imdbid，输出元数据、搜索结果、每条候选匹配分数；

• /debug/hls-clean：输入 m3u8 url，返回原始文本、命中哪些广告规则、清洗后结果；

• /debug/sources：源健康检测，逐个返回源可访问状态。

错误降级：单一源、单一模块失败不能整体崩溃；所有外部请求增加超时、重试；兜底返回原始流或者空结果。

编码、交付顺序与交付物

推荐 TypeScript；如果使用原生 JS，保证注释清晰。
模块化：协议层、源适配器、元数据、hls cleaner、logger、cache、配置独立。
交付顺序：

1. 项目脚手架：环境变量、配置加载、日志框架、调试路由；

2. manifest、catalog、search、meta、stream 基础骨架；

3. 元数据模块：imdb / tmdb /豆瓣 查询、标准化、匹配打分器；

4. 源适配器：优先非凡、暴风、量子、索尼，其余占位；

5. HLS 清洗模块，导入提供的正则与域名黑名单，实现降级；

6. Upstash 缓存层；

7. 完整调试接口、日志、异常捕获；

8. 本地文档、Render 部署指南、测试用例；

9. 维护文档：匹配失败排查、广告正则维护指南。

验收清单：

□ manifest，独立多 catalog；

□ 用户搜索通路；

□ imdbid → TMDB 中文元数据、别名扩展搜索；

□ 匹配打分，区分电影/剧集，季集匹配；

□ stream 返回多来源流；

□ HLS 清洗，源专属正则、域名黑名单；

□ master playlist 递归处理；

□ 清洗降级策略；

□ Upstash 缓存，长短 TTL；

□ 调试接口：匹配预览、hls 预览、源健康；

□ 分级结构化日志；

□ 单源故障隔离；

□ 本地 + Render 部署文档；

□ 配置分离，注释完善。

重要禁止项：

• ❌ 不要合并不同源 meta；

• ❌ 不要中转分片，只清洗 manifest；

• ❌ 不要把 ijk 参数返回给 Stremio；

• ❌ 如果置信度低，强制透传原始流；

• ❌ 如果防盗链需要特定请求头，文档注明，播放器直接拉分片时由播放器承担；

• ❌ 不要编造不存在的源接口；缺失接口标注占位。

如果实现中有方案取舍，请先说明取舍理由，再写代码；遇到歧义先提问。所有内容仅限技术研究，遵守源协议与相关法规。

AI 交互指令集

基础沟通规则

1. 先确认，再实现

◦ 如果对需求、源接口、正则、匹配逻辑、协议边界存在任何歧义、不确定项，先列出疑问和可选方案，等待确认，不要自行假设、编造接口、编造返回结构。

◦ 如果某些源只有占位接口，明确标记占位，不要模拟假的可工作接口冒充真实源。

◦ 如果遇到冲突（例如 Stremio 协议限制 vs 功能需求），清晰列出冲突点、取舍方案，附带利弊，由我选择。

2. 变更与回溯

◦ 如果后续我修改某一部分（清洗正则、源地址、匹配权重、调试接口、部署目标），优先增量修改，不要一次性重写全部项目；给出变更清单：改动文件、改动原因、影响范围。

◦ 如果之前实现偏离需求（比如合并源、中转分片、混入 ijk 参数），主动识别并修复，同时告知哪里不符合原始规范。

◦ 如果代码里出现和主需求矛盾的地方，主动标注。

3. 输出格式约定

◦ 架构阶段：输出 markdown 架构文档、目录树、模块职责图、数据流图；附带风险清单。

◦ 代码阶段：分文件输出；每个代码块标注文件路径；重要逻辑增加注释；配置单独抽离。

◦ 调试阶段：提供测试命令、测试 curl、示例请求；每个调试接口附带示例输入输出。

◦ 文档阶段：区分：开发文档、部署文档、故障排查文档、正则维护文档。

模块交互约定

4. 遇到源相关问题

◦ 如果源返回结构异常、接口超时、返回非预期 JSON：打日志，隔离该源，其他源继续工作；返回友好提示，而不是崩溃整个服务。

◦ 如果某个源缺少搜索接口：适配器提供 searchNotSupported 标记，上层调用跳过，而不是抛出致命错误。

◦ 如果播放链接不是直接 m3u8：标记为 non-direct-stream，跳过清洗，返回原始链接，并在日志里记录。

5. 匹配模块交互

◦ 如果匹配结果置信度介于阈值附近，不要强行返回单条结果；返回候选列表，并在调试接口里展示每一条的分数项（标题相似度、年份、类型、季集、别名加分、惩罚项）。

◦ 如果 TMDB / 豆瓣 API 拉取失败，优雅降级到用户原始搜索词，而不是直接返回无结果。

◦ 如果是剧集，单独输出季集匹配明细，在 /debug/match 可视化。

6. HLS 清洗模块交互

◦ 如果清洗后片段数量大幅减少、时长异常，自动标记高风险，降级返回原始 m3u8，并在日志和调试接口里告警。

◦ 如果是 master playlist，区分主清单和子清单；递归清洗子清单，但分片地址保持原始，不代理媒体片段。

◦ 如果正则有冲突（多条正则同时命中同一段），在调试接口列出全部命中项，方便我后续维护正则库。

◦ 如果广告规则更新，支持重新加载规则文件，不需要重启服务（可选热重载）。

7. 日志 & 调试交互

◦ 如果我要求复现一个 bug：请提供最小复现用例：请求路径、入参、原始源返回、日志片段、调试接口返回。

◦ 如果调试接口发现异常：给出排查方向，而不是只报错。

◦ 如果生产环境关闭 debug，保留关键信息日志；本地开发时打印完整原始响应。

◦ 如果我提供新的广告正则、新源、新测试链接：先在 /debug/hls-clean 上演示效果，再合并进正式代码。

迭代、验收与纠错指令

8. 迭代轮次指令

◦ 每一轮交付后，附带一份本轮验收清单；如果验收不通过，针对性修复，不要大范围重构无关模块。

◦ 如果我说：「继续下一步」，进入预先约定好的下一阶段。

◦ 如果我说：「停在这里，检查一遍」，输出一份完整自查报告，对照主需求验收清单逐项自检。

◦ 如果我说：「单独提取这个模块」，输出独立可运行模块 + 测试脚本，可以脱离主项目测试。

9. 禁止行为（交互层面）

◦ 禁止静默忽略需求里的硬性约束（独立源、不中转分片、ijk 不进返回流）。

◦ 禁止编造真实的、可访问的私有源接口。

◦ 禁止随意修改匹配阈值、清洗降级策略而不告知。

◦ 如果引入第三方库，说明库用途、版本、潜在风险；不要引入不必要的重型依赖。

◦ 如果遇到版权、合规相关边界，标注清楚，不做超出技术演示范围的承诺。

10. 辅助查询指令

◦ 如果我问：「这个源为什么匹配不到」：调用调试匹配链路，输出：拿到的元数据、源搜索结果、每一项打分、失败原因。

◦ 如果我问：「这条流清洗结果如何」：调用 hls 调试接口，输出原始清单、命中规则、清洗后清单、风险标记。

◦ 如果我问：「哪些源异常」：调用源健康检测接口，输出各源状态、延迟、错误信息。

快捷关键词（识别这些指令）

• check：自查，对照验收清单，输出问题报告。

• incremental：增量修改，只改指定模块。

• debug：增加/完善调试接口、日志、测试用例。

• refactor：重构指定模块，保持对外接口不变。

• test：生成测试脚本、curl、单元测试。

• docs：更新对应文档。

• rules：更新、校验、测试广告清洗规则。

• placeholder：补齐占位适配器，标注待实测项。

如果遇到不确定的外部依赖

• 如果需要密钥、第三方服务（TMDB、Upstash），在配置里做成环境变量；提供 .env.example，并写明如何申请。

• 如果某些服务有速率限制，增加限流、缓存、重试策略，并在文档标注。

最后

任何时候，如果我的口头指令和主需求文档冲突，以主需求文档为准，先指出冲突，再沟通。
## 使用建议
1. 如果给 Cursor / Claude Code / Cline 这类 Agent，直接一次性粘贴；也可以拆成架构确认 → 脚手架 → 模块实现多轮；
2. 如果后续拿到真实可用的 baseUrl、真实解析接口，直接替换占位部分；
3. 如果需要，我可以再单独输出配套文件：`sources.json`、`.env.example`、独立的 `instructions.md`；
4. 如果之后新增源、更新正则，直接使用里面定义的快捷关键词进行沟通迭代。


补充 ：

### 📊 三大资源站接口与广告清洗详情对照表

| 项目 | 暴风资源 (bfzy) | 非凡资源 (ffzy) | 量子资源 (lz / lzzy) |
| :--- | :--- | :--- | :--- |
| **标准 Base URL** | `https://bfzyapi.com/api.php/provide/vod` | `http://cj.ffzyapi.com/api.php/provide/vod` | `https://cj.lziapi.com/api.php/provide/vod` |
| **搜索接口** | `{BaseURL}/?ac=search&wd={keyword}` | `{BaseURL}/?ac=search&wd={keyword}` | `{BaseURL}/?ac=search&wd={keyword}` |
| **详情接口** | `{BaseURL}/?ac=detail&ids={id}` | `{BaseURL}/?ac=detail&ids={id}` | `{BaseURL}/?ac=detail&ids={id}` |
| **XML 格式接口** | `{BaseURL}/at/xml/` | `{BaseURL}/at/xml/` | `{BaseURL}/at/xml/` |
| **线路标识接口** | 通常直接使用主 BaseURL | `{BaseURL}/from/ffm3u8/`（标识 `ffm3u8`） | `{BaseURL}/from/lzm3u8`（标识 `lzm3u8`，88路） |
| **流媒体 Hosts 特征** | `bfzy`, `s5.bfzycdn` | `vip.ffzy`, `hd.ffzy`, `super.ffzy` | `vip.lz`, `hd.lz`, `v.cdnlz` |

### 🧹 核心广告 Regex 模式与说明

以下规则通常配置在 TVBox 的 `rules` 数组中，用于清洗 M3U8 播放列表。

| 资源站 | 核心 Regex 模式 (Regular Expression) | 广告特征说明 |
| :--- | :--- | :--- |
| **暴风 (bfzy)** | `#EXT-X-DISCONTINUITY\r*\n*#EXTINF:3,[\s\S]*?#EXT-X-DISCONTINUITY`<br>`#EXTINF.*?\s+.*?1o.*?\.ts` | 广告被切割为**约 3 秒**的独立片段，夹在两个 `#EXT-X-DISCONTINUITY` 标记之间。 `1o` 是部分暴风广告分片的通用文件名特征。 |
| **非凡 (ffzy)** | `#EXT-X-DISCONTINUITY\r*\n*#EXTINF:4.000000,[\s\S]*?#EXT-X-DISCONTINUITY`<br>`#EXT-X-DISCONTINUITY\r*\n*#EXTINF:6.666667,[\s\S]*?#EXT-X-DISCONTINUITY`<br>`#EXTINF.*?\s+.*?1o.*?\.ts` | 广告时长特征在不同版本中可能有差异，**4 秒**和**6.666667 秒**都是常见的广告窗口。`1o` 同样是有效的辅助过滤特征。 |
| **量子 (lz / lzzy)** | `#EXT-X-DISCONTINUITY\r*\n*#EXTINF:6.433333,[\s\S]*?#EXT-X-DISCONTINUITY`<br>`#EXTINF.*?\s+.*?1o.*?\.ts` | 广告的核心特征是**时长精确为 6.433333 秒**的 `#EXTINF` 片段。 `1o` 特征同样适用于量子资源的广告过滤。 |

### 💡 补充说明

*   **`1o.*?\.ts` 的通用性**：这个模式在暴风、非凡、量子的规则中反复出现，是这些 CMS 系统插入广告分片时的一个**通用命名特征**，保留它能在时长匹配之外提供一层额外保障。
*   **`#EXT-X-DISCONTINUITY` 的作用**：这个标记在 HLS 协议中代表“序列不连续”。广告插入者利用它在正常视频流中“切”出一个独立的广告片段。因此，正则表达式的逻辑是：**找到被 `DISCONTINUITY` 包裹、且 `#EXTINF` 时长符合广告特征的片段，将其整段剔除**。
*   **多规则并存**：从社区配置可以看到，同一个资源站的 `regex` 数组里通常会放置多条规则（如非凡的 4 秒和 6.66 秒），这是为了兼容源站可能存在的多种广告切片长度，建议保留。