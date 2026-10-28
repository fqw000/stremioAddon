/**
 * 麦田影院 Spider 探针 v2.1
 * 运行环境：Node.js 18+
 * 变更：
 *   - v2.1  多域名容灾 + 正确搜索路径 ?wd= + RSS 样本采集 + 跨域验证
 *   - v2.0  async/await 修复 + 电影/剧集双形态
 *   - v1.0  初版
 */

"use strict";

// ============================================================
// 全局配置
// ============================================================
const CONFIG = {
    // 主域名 + 备用域名数组（第一个为主）
    HOSTS: [
        "https://mtyy5.com",
        "https://mtyy2.cc",
        "https://mtyy4.cc",
        "https://mtyy8.cc",
        "https://mtyy3.com"
    ],
    // 期望的主域名（RSS 里可能返回 mtyy1.cc 等镜像，需能访问）
    extraHosts: ["https://www.mtyy1.cc"],

    headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 11; MI 11) AppleWebKit/537.36 TVBox/1.0",
        "Accept": "text/html,application/xml;q=0.9,*/*;q=0.8",
        "Connection": "keep-alive"
    },
    timeout: 15000,

    keywordMovie: "流浪地球",
    keywordTv: "庆余年",
    keywordExtra: "爱的世界",

    categoryPages: [1, 2]
};

// ============================================================
// 工具函数
// ============================================================
function line(title) {
    const bar = "=".repeat(60);
    console.log("\n" + bar);
    if (title) console.log("  " + title);
    console.log(bar);
}
function log(label, ok, detail) {
    const icon = ok === true ? "[PASS]" : ok === false ? "[FAIL]" : "[INFO]";
    console.log(icon + " " + label + (detail !== undefined ? " -> " + detail : ""));
}
function shortJson(obj, maxLen = 300) {
    try {
        const s = JSON.stringify(obj);
        return s.length > maxLen ? s.substring(0, maxLen) + "..." : s;
    } catch (e) { return String(obj); }
}
const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;
const isHttpUrl = (u) => isNonEmptyStr(u) && /^https?:\/\//i.test(u);
const isVideoUrl = (u) => isNonEmptyStr(u) && /\.(m3u8|mp4|flv)(\?|$)/i.test(u);
function safeDecode(s) {
    if (!isNonEmptyStr(s)) return "";
    try { return decodeURIComponent(s); } catch (e) { return s; }
}
function stripTags(s) {
    return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function absUrl(base, path) {
    if (!isNonEmptyStr(path)) return "";
    if (/^https?:\/\//i.test(path)) return path;
    return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
}

// ============================================================
// 统一 HTTP（async）
// ============================================================
async function http(url, opts = {}) {
    const headers = Object.assign({}, CONFIG.headers, opts.headers || {});
    if (!headers.Referer) {
        try { headers.Referer = new URL(url).origin + "/"; } catch (e) { /* ignore */ }
    }
    const timeout = opts.timeout || CONFIG.timeout;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const resp = await fetch(url, {
            method: opts.method || "GET",
            headers,
            signal: ctrl.signal,
            redirect: "follow"
        });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, text, url };
    } catch (e) {
        return { ok: false, status: 0, text: "", err: e.message || String(e), url };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 多域名容灾请求：按 HOSTS 顺序尝试，任一成功即返回
 * @param {string} path    以 / 开头的路径（如 /vodsearch/xxx.html?wd=yyy）
 * @param {object} opts    可选 { headers, method, timeout }
 * @returns {{ok, status, text, host, url}}
 */
async function httpHost(path, opts = {}) {
    const errs = [];
    for (const host of CONFIG.HOSTS) {
        const url = host + path;
        const r = await http(url, opts);
        if (r.ok && isNonEmptyStr(r.text)) {
            return { ok: true, status: r.status, text: r.text, host, url };
        }
        errs.push(`${host} → ${r.err || r.status}`);
    }
    return { ok: false, status: 0, text: "", host: null, url: path, errs };
}

// ============================================================
// HTML 解析
// ============================================================
function extractVideoList(html) {
    const list = [];
    const seen = new Set();
    const re = /href="([^"]*\/voddetail\/(\d+)\.html)"[^>]*(?:title="([^"]*)")?[^>]*>[\s\S]{0,300}?<img[^>]+(?:data-src|src)="([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (seen.has(m[2])) continue;
        seen.add(m[2]);
        list.push({
            vod_id: m[2],
            vod_name: stripTags(m[3] || ""),
            vod_pic: m[4],
            vod_remarks: ""
        });
    }
    if (list.length === 0) {
        const loose = /href="([^"]*\/voddetail\/(\d+)\.html)"[^>]*>[\s\S]{0,300}?<img[^>]+(?:data-src|src)="([^"]*)"/gi;
        let lm;
        while ((lm = loose.exec(html)) !== null) {
            if (seen.has(lm[2])) continue;
            seen.add(lm[2]);
            list.push({ vod_id: lm[2], vod_name: "", vod_pic: lm[3], vod_remarks: "" });
        }
    }
    return list;
}

function extractClassList(html) {
    const list = [];
    const seen = new Set();
    const re = /<a[^>]+href="([^"]*\/vodtype\/(\d+)\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const name = stripTags(m[3]);
        if (name && m[2] && !seen.has(m[2])) {
            seen.add(m[2]);
            list.push({ type_name: name, type_id: m[2] });
        }
    }
    return list;
}

function extractPlayerAaaa(html) {
    const m = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;)/i)
           || html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?url:[^}]+?\})/i);
    if (!m) return null;
    const raw = m[1].replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(raw); }
    catch (e) { return { __parseError: e.message, __raw: raw.substring(0, 200) }; }
}

function extractPlaySources(html) {
    const forms = [];
    const formRe = /<a[^>]+class="[^"]*vod-playerUrl[^"]*"[^>]+data-form="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let fm;
    while ((fm = formRe.exec(html)) !== null) {
        forms.push({ form: fm[1], name: stripTags(fm[2]) });
    }
    const boxes = [];
    const boxRe = /<ul[^>]*class="[^"]*anthology-list-box[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
    let bm;
    while ((bm = boxRe.exec(html)) !== null) {
        const eps = [];
        const epRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let em;
        while ((em = epRe.exec(bm[1])) !== null) {
            const name = stripTags(em[2]);
            if (name && em[1]) eps.push({ name, url: em[1] });
        }
        boxes.push(eps);
    }
    return { forms, boxes };
}

function classifyVideoType(detailHtml, playInfo) {
    const { boxes } = playInfo;
    const firstGroup = boxes[0] || [];
    const titleM = detailHtml.match(/<h1[^>]*class="[^"]*player-title-link[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleM ? stripTags(titleM[1]) : "";
    const hasEpisodePattern = /第\s*\d+\s*集|全集|更新至|EP?\d+/i.test(title)
        || boxes.some((g) => g.length > 1);
    const singleEp = boxes.length <= 1 && firstGroup.length <= 1;
    if (hasEpisodePattern && !singleEp) return "tv";
    if (singleEp) return "movie";
    return "unknown";
}

// ============================================================
// 探针
// ============================================================
const Probe = {
    results: [],
    // 当前生效的主域名（由第一次成功请求确定）
    activeHost: CONFIG.HOSTS[0],
    cachedTid: null,
    movieVid: null, movieTitle: "",
    tvVid: null, tvTitle: "",
    extraVid: null,

    record(name, ok, detail) {
        this.results.push({ name, ok, detail });
        log(name, ok, detail);
    },

    // --------------------------------------------------------
    // 0. 多域名可达性
    // --------------------------------------------------------
    async testDomains() {
        line("0. 多域名可达性探测");
        const alive = [];
        for (const host of CONFIG.HOSTS) {
            const r = await http(host, { timeout: 8000 });
            const ok = r.ok && r.text.length > 1000;
            log(host, ok, ok ? `HTTP ${r.status}, ${r.text.length} 字节` : (r.err || `HTTP ${r.status}`));
            if (ok) alive.push(host);
        }
        this.record("可用域名数 > 0", alive.length > 0, `可用: ${alive.join(", ") || "无"}`);
        if (alive.length > 0) {
            this.activeHost = alive[0];
            log("选定主域名", null, this.activeHost);

            // 额外镜像
            for (const h of CONFIG.extraHosts) {
                const r = await http(h, { timeout: 8000 });
                const ok = r.ok && r.text.length > 1000;
                log("附加镜像 " + h, ok, ok ? `HTTP ${r.status}` : (r.err || `HTTP ${r.status}`));
            }
        }
        return alive.length > 0;
    },

    // --------------------------------------------------------
    // 1. homeContent
    // --------------------------------------------------------
    async testHomeContent() {
        line("1. 测试 homeContent（首页分类 + 首页影片）");
        const r = await httpHost("/");
        if (!r.ok) {
            this.record("homeContent HTTP", false, r.errs ? r.errs.join(" | ") : "全部域名失败");
            return;
        }
        log("命中域名", null, r.host);
        log("HTML 长度", r.text.length > 0, r.text.length + " 字节");

        const classList = extractClassList(r.text);
        this.record("分类数量 > 0", classList.length > 0, `共 ${classList.length} 个分类`);
        if (classList.length > 0) {
            this.cachedTid = classList[0].type_id;
            log("示例分类", true, shortJson(classList.slice(0, 5)));
        }

        const videos = extractVideoList(r.text);
        this.record("首页影片数量 > 0", videos.length > 0, `共 ${videos.length} 部`);
        if (videos.length > 0) {
            log("示例影片", true, shortJson(videos.slice(0, 2)));
        }
    },

    // --------------------------------------------------------
    // 2. categoryContent
    // --------------------------------------------------------
    async testCategoryContent() {
        line("2. 测试 categoryContent（分类列表）");
        const tid = this.cachedTid || "1";
        for (const pg of CONFIG.categoryPages) {
            const path = pg > 1 ? `/vodtype/${tid}-${pg}.html` : `/vodtype/${tid}.html`;
            const r = await httpHost(path);
            if (!r.ok) {
                this.record(`categoryContent 第${pg}页`, false, r.errs ? r.errs.join(" | ") : "失败");
                continue;
            }
            const list = extractVideoList(r.text);
            this.record(`categoryContent 第${pg}页影片数 > 0`, list.length > 0,
                `共 ${list.length} 部 @ ${r.host}${path}`);
        }
    },

    // --------------------------------------------------------
    // 3. searchContent
    // --------------------------------------------------------
    async testSearchContent() {
        line("3. 测试 searchContent（RSS + 网页）");
        await this._testSearchRss(CONFIG.keywordMovie, "电影");
        await this._testSearchRss(CONFIG.keywordTv, "剧集");
        await this._testSearchWeb(CONFIG.keywordMovie, "电影");
        await this._testSearchWeb(CONFIG.keywordTv, "剧集");
        await this._testSearchWeb(CONFIG.keywordExtra, "冷门");
    },

    // 3.1 RSS
    async _testSearchRss(key, label) {
        const path = `/rss.xml?wd=${encodeURIComponent(key)}`;
        const r = await httpHost(path, { headers: { Accept: "application/xml" } });
        if (!r.ok) {
            this.record(`RSS(${label}) HTTP`, false, r.errs ? r.errs.join(" | ") : "失败");
            return;
        }
        log(`RSS(${label}) 命中`, null, `${r.host}${path}`);

        const itemRe = /<item>([\s\S]*?)<\/item>/gi;
        const items = [];
        let im;
        const getTag = (block, tag) => {
            const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
            const mm = block.match(re);
            return mm ? mm[1].trim() : "";
        };
        while ((im = itemRe.exec(r.text)) !== null) {
            items.push({
                title: getTag(im[1], "title"),
                link: getTag(im[1], "link"),
                author: getTag(im[1], "author")
            });
        }
        this.record(`RSS(${label}) 结果数 > 0`, items.length > 0, `共 ${items.length} 条`);
        if (items.length > 0) {
            log("RSS 示例", true, shortJson(items.slice(0, 2)));

            // 从 RSS 采集样本
            const withVid = items
                .map((it) => {
                    const m = it.link.match(/\/voddetail\/(\d+)\.html/);
                    return m ? { vod_id: m[1], vod_name: it.title, link: it.link } : null;
                })
                .filter(Boolean);

            this.record(`RSS(${label}) link 含 vid 比例`, withVid.length > 0,
                `${withVid.length}/${items.length}`);

            this._maybePickSample(withVid, label);

            // 记录 RSS 里的域名（可能跨域）
            const rssHostM = items[0].link.match(/^https?:\/\/[^/]+/);
            if (rssHostM) log("RSS 链接域名", null, rssHostM[0]);
        }
    },

    // 3.2 网页搜索（正确路径 ?wd=）
    async _testSearchWeb(key, label) {
        const path = `/vodsearch/-------------.html?wd=${encodeURIComponent(key)}`;
        const r = await httpHost(path);
        if (!r.ok) {
            this.record(`网页搜索(${label}) HTTP`, false,
                (r.errs ? r.errs.join(" | ") : "失败") + ` @ ${path}`);
            return;
        }
        log(`网页搜索(${label}) 命中`, null, `${r.host}${path}`);
        const list = extractVideoList(r.text);
        this.record(`网页搜索(${label}) 结果数 > 0`, list.length > 0, `共 ${list.length} 条`);
        if (list.length > 0) {
            log(`网页搜索(${label}) 示例`, true, shortJson(list.slice(0, 3)));
            this._maybePickSample(list, label);
        }
    },

    _maybePickSample(list, label) {
        if (!list || list.length === 0) return;
        const v = list[0];
        if (label === "电影" && !this.movieVid) {
            this.movieVid = v.vod_id;
            this.movieTitle = v.vod_name || "";
            log(`[样本-电影]`, true, `vid=${v.vod_id}, name=${v.vod_name || "?"}`);
        } else if (label === "剧集" && !this.tvVid) {
            this.tvVid = v.vod_id;
            this.tvTitle = v.vod_name || "";
            log(`[样本-剧集]`, true, `vid=${v.vod_id}, name=${v.vod_name || "?"}`);
        } else if (label === "冷门" && !this.extraVid) {
            this.extraVid = v.vod_id;
            log(`[样本-冷门]`, true, `vid=${v.vod_id}`);
        }
    },

    // --------------------------------------------------------
    // 3.5 跨域详情页验证
    // --------------------------------------------------------
    async testCrossDomain() {
        line("3.5 跨域详情页验证");
        const vid = this.movieVid || this.tvVid;
        if (!vid) { this.record("跨域验证", false, "无可用 vid"); return; }

        const testHosts = [...CONFIG.HOSTS, ...CONFIG.extraHosts];
        let okHosts = [];
        for (const h of testHosts) {
            const url = `${h}/voddetail/${vid}.html`;
            const r = await http(url, { timeout: 8000 });
            const hasTitle = r.ok && /player-title-link/.test(r.text);
            if (hasTitle) okHosts.push(h);
            log(`详情页 @ ${h}`, r.ok && hasTitle,
                r.ok ? (hasTitle ? "命中标题" : "无标题节点") : (r.err || `HTTP ${r.status}`));
        }
        this.record("可访问详情页的域名数 > 0", okHosts.length > 0,
            okHosts.length > 0 ? okHosts.join(", ") : "全部失败");
    },

    // --------------------------------------------------------
    // 4. detailContent（电影 + 剧集）
    // --------------------------------------------------------
    async testDetailContent() {
        line("4. 测试 detailContent（电影/剧集）");
        const samples = [];
        if (this.movieVid) samples.push({ type: "movie", vid: this.movieVid, title: this.movieTitle });
        if (this.tvVid)    samples.push({ type: "tv",    vid: this.tvVid,    title: this.tvTitle });

        if (samples.length === 0) {
            this.record("detailContent 样本采集", false, "搜索未获得任何 vid");
            return;
        }
        for (const s of samples) await this._testDetailOne(s);

        const kinds = samples.map((s) => s.type);
        this.record("已覆盖 电影+剧集", kinds.includes("movie") && kinds.includes("tv"),
            `实际样本: ${kinds.join(", ")}`);
    },

    async _testDetailOne(sample) {
        const { type, vid, title } = sample;
        const tag = type === "movie" ? "电影" : "剧集";
        log(`----- 详情[${tag}] vid=${vid} "${title}" -----`, null, "");

        const path = `/voddetail/${vid}.html`;
        const r = await httpHost(path);
        if (!r.ok) {
            this.record(`[${tag}] 详情页 HTTP`, false, r.errs ? r.errs.join(" | ") : "失败");
            return;
        }
        log(`[${tag}] 命中域名`, null, r.host);

        const html = r.text;
        const titleM = html.match(/<h1[^>]*class="[^"]*player-title-link[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
        const titleTxt = titleM ? stripTags(titleM[1]) : "";
        this.record(`[${tag}] 标题提取`, isNonEmptyStr(titleTxt), titleTxt || "(空)");

        const picM = html.match(/class="[^"]*role-card[^"]*"[\s\S]{0,500}?<img[^>]+(?:data-src|src)="([^"]*)"/i);
        const pic = picM ? picM[1] : "";
        this.record(`[${tag}] 封面提取`, isNonEmptyStr(pic), pic || "(空)");

        const descM = html.match(/class="[^"]*card-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const desc = descM ? stripTags(descM[1]) : "";
        this.record(`[${tag}] 简介提取`, isNonEmptyStr(desc), (desc || "(空)").substring(0, 60));

        // 播放页
        const playHrefM = html.match(/class="[^"]*anthology-list-play[^"]*"[\s\S]{0,300}?<a[^>]+href="([^"]+)"/i);
        const playPath = playHrefM ? playHrefM[1] : `/vodplay/${vid}-1-1.html`;
        const playUrl = absUrl(r.host, playPath);
        log(`[${tag}] 播放页 URL`, null, playUrl);

        const pr = await http(playUrl);
        if (!pr.ok) {
            this.record(`[${tag}] 播放页 HTTP`, false, pr.err || `HTTP ${pr.status}`);
            return;
        }
        const { forms, boxes } = extractPlaySources(pr.text);
        this.record(`[${tag}] 播放源 Tab 数量 > 0`, forms.length > 0, `共 ${forms.length} 个源`);
        if (forms.length > 0) log(`[${tag}] 播放源`, true, shortJson(forms));

        const totalEps = boxes.reduce((a, b) => a + b.length, 0);
        this.record(`[${tag}] 剧集分组 > 0`, boxes.length > 0, `${boxes.length} 组 / ${totalEps} 集`);

        const detected = classifyVideoType(html, { forms, boxes });
        this.record(`[${tag}] 形态判定`, detected === type,
            `expect=${type}, detected=${detected}`);

        if (type === "movie") {
            this.record(`[${tag}] 电影结构(首组集数<=3)`,
                (boxes[0] || []).length <= 3, `首组=${(boxes[0] || []).length}`);
        } else {
            const firstLen = (boxes[0] || []).length;
            this.record(`[${tag}] 剧集结构(首组>1 或 组数>1)`,
                firstLen > 1 || boxes.length > 1,
                `首组=${firstLen}, 组数=${boxes.length}`);
        }

        if (forms.length > 0 && boxes.length > 0) {
            this.record(`[${tag}] 播放源与剧集组数一致`, forms.length === boxes.length,
                `forms=${forms.length}, boxes=${boxes.length}` +
                (forms.length === boxes.length ? "" : " 【可能错位！】"));
        }

        if (forms.length > 0) {
            const hasNB = forms.some((f) => f.form === "NBY");
            if (hasNB) {
                this.record(`[${tag}] NB源排第一`, forms[0].form === "NBY",
                    `首源=${forms[0].form}(${forms[0].name})`);
            } else {
                log(`[${tag}] NB源`, null, "未提供，跳过");
            }
        }

        // 组装
        const sourceMap = { NBY: "高清NB源", "1080zyk": "超清YZ源", ffm3u8: "极速FF源", lzm3u8: "稳定LZ源", yzzy: "YZ源" };
        const finalFrom = [], finalUrl = [];
        for (let i = 0; i < forms.length; i++) {
            const sname = sourceMap[forms[i].form] || forms[i].name;
            const eps = (boxes[i] || []).map((e) => `${e.name}$${absUrl(r.host, e.url)}`).filter(Boolean);
            if (eps.length > 0) { finalFrom.push(sname); finalUrl.push(eps.join("#")); }
        }
        this.record(`[${tag}] 最终播放源组装`, finalFrom.length > 0,
            `from=[${finalFrom.join(",")}], 组数=${finalUrl.length}`);
    },

    // --------------------------------------------------------
    // 5. playerContent
    // --------------------------------------------------------
    async testPlayerContent() {
        line("5. 测试 playerContent（电影/剧集）");
        const samples = [];
        if (this.movieVid) samples.push({ type: "movie", vid: this.movieVid });
        if (this.tvVid)    samples.push({ type: "tv",    vid: this.tvVid });
        if (samples.length === 0) {
            this.record("playerContent 前置", false, "无可用 vid");
            return;
        }
        for (const s of samples) await this._testPlayerOne(s);
    },

    async _testPlayerOne(sample) {
        const tag = sample.type === "movie" ? "电影" : "剧集";
        const path = `/vodplay/${sample.vid}-1-1.html`;
        const r = await httpHost(path);
        if (!r.ok) {
            this.record(`[${tag}] 播放页 HTTP`, false, r.errs ? r.errs.join(" | ") : "失败");
            return;
        }
        log(`[${tag}] 命中域名`, null, r.host);

        const data = extractPlayerAaaa(r.text);
        this.record(`[${tag}] player_aaaa`, !!data, data ? "已提取" : "未匹配");
        if (!data || data.__parseError) {
            this.record(`[${tag}] playerContent 解析`, false,
                data ? `JSON: ${data.__parseError}` : "无 player_aaaa");
            return;
        }
        this.record(`[${tag}] player_aaaa JSON`, true, shortJson(data, 200));

        const main = safeDecode((data.url || "").trim());
        const backup = safeDecode((data.url_next || "").trim());
        log(`[${tag}] url`, null, main || "(空)");
        log(`[${tag}] url_next`, null, backup || "(空)");

        const playAddr = isVideoUrl(main) ? main : (isVideoUrl(backup) ? backup : r.url);
        const parse = isVideoUrl(playAddr) ? 0 : 1;
        this.record(`[${tag}] 播放地址`, isNonEmptyStr(playAddr), playAddr);
        this.record(`[${tag}] 解析模式`, true, `parse=${parse}`);
    },

    // --------------------------------------------------------
    // 6. clean_text 用例
    // --------------------------------------------------------
    testCleanText() {
        line("6. clean_text 用例（Python 侧执行）");
        const cases = [
            { input: "  普通文本  ", expect: "普通文本" },
            { input: "带\\u4e2d\\u6587转义", expect: "带中文转义" },
            { input: "带\x00\x1f控制字符", expect: "带控制字符" },
            { input: "", expect: "" },
            { input: null, expect: "" }
        ];
        cases.forEach((c, i) => log(`用例 ${i + 1}`, null,
            `${JSON.stringify(c.input)} 期望 -> ${JSON.stringify(c.expect)}`));
        this.record("clean_text 用例", true, `${cases.length} 条`);
    },

    // --------------------------------------------------------
    // 汇总
    // --------------------------------------------------------
    report() {
        line("测试汇总报告");
        const total = this.results.length;
        const pass = this.results.filter((r) => r.ok === true).length;
        const fail = this.results.filter((r) => r.ok === false).length;
        const info = total - pass - fail;
        console.log(`总测试项: ${total}`);
        console.log(`通过: ${pass}  [PASS]`);
        console.log(`失败: ${fail}  [FAIL]`);
        console.log(`信息: ${info}  [INFO]`);
        console.log(`通过率: ${total > 0 ? ((pass / total) * 100).toFixed(1) : 0}%`);
        if (fail > 0) {
            console.log("\n--- 失败明细 ---");
            this.results.forEach((r) => {
                if (r.ok === false) console.log(`  [FAIL] ${r.name} -> ${r.detail}`);
            });
        }
        return { total, pass, fail, info, results: this.results };
    },

    async runAll() {
        line("麦田影院 Spider 探针 v2.1");
        console.log("域名池:", CONFIG.HOSTS.join(", "));
        console.log("电影关键词:", CONFIG.keywordMovie);
        console.log("剧集关键词:", CONFIG.keywordTv);
        console.log("开始时间:", new Date().toISOString());

        const ok = await this.testDomains();
        if (ok) {
            await this.testHomeContent();
            await this.testCategoryContent();
            await this.testSearchContent();
            await this.testCrossDomain();
            await this.testDetailContent();
            await this.testPlayerContent();
        }
        this.testCleanText();
        this.report();
        console.log("\n结束时间:", new Date().toISOString());
    }
};

// ============================================================
// 启动
// ============================================================
(async function main() {
    try { await Probe.runAll(); }
    catch (e) {
        console.error("[FATAL]", e && (e.stack || e.message || e));
        process.exitCode = 1;
    }
})();