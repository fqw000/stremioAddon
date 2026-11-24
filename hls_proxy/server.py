#!/usr/bin/env python3
"""
HLS Clean —— 通用 M3U 代理 + 去广告 + 全量绝对地址重写
移植 JS 版本 m3u8-ad-filter 完整内核
核心特性:
  1. Master m3u8 (含 #EXT-X-STREAM-INF / I-FRAME-STREAM-INF / MEDIA:) 不做去广告
     → 避免把子清单当分片误删
  2. 全量 URI 重写：分片行、子清单行、所有 URI="..." 属性全部转绝对地址 + 百分号编码
  3. 请求上游自动兜底 Referer：用户未传时用源站 origin
  4. 去广告：JS 原版加权分块打分、SCTE/CUE、KEY-NONE、异域名、命名复用、注释标记、安全兜底、重建校验
  5. UTF-8 BOM 自动清理，避免首行被误判为 URI
"""

import json
import os
import re
import sys
import math
import ssl
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import (urlparse, parse_qs, unquote, urlsplit,
                          urlunsplit, quote, urljoin)
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

PORT = int(os.environ.get("PORT", "50001"))
TIMEOUT = 15
MAX_BYTES = 5 * 1024 * 1024

# TLS 相关：
#   HLS_CA_FILE / SSL_CERT_FILE   指定自定义 CA 包（私 CA 场景）
#   HLS_EXTRA_CA_FILE             在默认 CA 之外追加一个 CA 包
#   HLS_ALLOW_SELF_SIGNED=1       验证失败时仅对本次请求降级为不校验（谨慎使用）
#   HLS_INSECURE=1                全局关闭证书校验（仅内网/调试）
CA_FILE = os.environ.get("HLS_CA_FILE") or os.environ.get("SSL_CERT_FILE") or ""
EXTRA_CA_FILE = os.environ.get("HLS_EXTRA_CA_FILE", "")
ALLOW_SELF_SIGNED = os.environ.get("HLS_ALLOW_SELF_SIGNED", "").lower() in ("1", "true", "yes")
INSECURE_SSL = os.environ.get("HLS_INSECURE", "").lower() in ("1", "true", "yes")

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

BLOCKED_HEADERS = {
    "host", "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authorization", "proxy-connection",
    "upgrade", "te", "trailer",
}


# -----------------------------------------------------------------------------
# TLS 上下文：优先使用系统/自定义 CA，兼容私 CA 片源
# -----------------------------------------------------------------------------
def build_ssl_context(insecure=False):
    """构造 urllib 使用的 SSLContext。默认严格校验；可追加私 CA。"""
    if insecure or INSECURE_SSL:
        return ssl._create_unverified_context()
    ctx = ssl.create_default_context()
    for path in (CA_FILE, EXTRA_CA_FILE):
        if path and os.path.isfile(path):
            try:
                ctx.load_verify_locations(cafile=path)
            except Exception as e:
                sys.stderr.write("[tls] 无法加载 CA 文件 %s: %s\n" % (path, e))
    return ctx


SSL_CONTEXT = build_ssl_context()
UNVERIFIED_CONTEXT = ssl._create_unverified_context()


def open_upstream(req):
    """打开上游请求；证书校验失败时按配置决定是否降级重试。"""
    try:
        return urlopen(req, timeout=TIMEOUT, context=SSL_CONTEXT)
    except URLError as e:
        reason = getattr(e, "reason", None)
        is_cert_error = isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY" in str(reason)
        if is_cert_error and ALLOW_SELF_SIGNED and not INSECURE_SSL:
            sys.stderr.write("[tls] 证书校验失败，按 HLS_ALLOW_SELF_SIGNED=1 降级: %s\n" % reason)
            return urlopen(req, timeout=TIMEOUT, context=UNVERIFIED_CONTEXT)
        raise


def headers_from_query(params):
    """从 query 提取上游请求头：referer / ua / header.Xxx（兼容 catvod 与 lite 版）。"""
    headers = {}
    for key in ("referer", "referrer"):
        value = params.get(key, [None])[0]
        if value:
            headers["Referer"] = value
            break
    ua = params.get("ua", [None])[0]
    if ua:
        headers["User-Agent"] = ua
    for key, values in params.items():
        if key.startswith("header.") and len(key) > 7 and values and values[0]:
            headers[key[7:]] = values[0]
    return headers


# -----------------------------------------------------------------------------
# JS原版默认配置
# -----------------------------------------------------------------------------
DEFAULTS = {
    "verbose": False,
    "logSegments": False,
    "logMaxSegments": 300,
    "logChunks": False,
    "logAllChunks": False,
    "logMaxChunksForAll": 60,
    "logRuleMisses": False,
    "dryRun": False,

    "skipLive": True,
    "skipImplicitIV": True,
    "skipByteRangeImplicit": True,
    "minSegments": 6,

    "minAdBlockSegments": 2,
    "maxAdBlockSegments": 8,
    "minAdBlockDurationSec": 4,
    "maxAdBlockDurationSec": 30,
    "maxAdBlockTotalSec": 36,
    "uniformTolerance": 0.8,
    "splitOnDurationJump": True,

    "maxRemovedRatio": 0.15,
    "maxRemovedDurationSec": 120,
    "minRemainingSegments": 4,

    "useRules": True,
    "useScte": True,
    "useKeyNone": True,
    "keynoneBounded": "both",
    "useHostAnomaly": True,
    "useNamingReuse": True,
    "useMirrorReuse": True,
    "useChunkScoring": True,
    "useCommentMarker": True,

    "baseThreshold": 0.60,
    "firstBonus": 0.20,
    "lastBonus": 0.10,
    "requireStructural": True,

    "w": {
        "uniformShort": 0.40,
        "shortOnly": 0.20,
        "disc": 0.15,
        "offHost": 0.15,
        "urlDev": 0.10,
        "shortBetweenLong": 0.20,
        "namingReuse": 0.25,
        "denseShort": 0.10,
        "seqIsland": 0.08,
        "ruleWeak": 0.50,
        "singlePenalty": -0.30,
        "longPenalty": -0.20,
        "totalPenalty": -0.30,
    }
}

DEFAULT_RULES = {
    "globalRegex": [
        re.compile(r"/ad/", re.I),
        re.compile(r"/ads/", re.I),
        re.compile(r"/adv/", re.I),
        re.compile(r"_ad_", re.I),
        re.compile(r"_ads_", re.I),
        re.compile(r"/adjump", re.I),
        re.compile(r"/guanggao/", re.I),
        re.compile(r"/adseg/", re.I),
        re.compile(r"/advideo/", re.I),
        re.compile(r"/adplay/", re.I),
        re.compile(r"/pre_ad/", re.I),
        re.compile(r"/mid_ad/", re.I),
        re.compile(r"/post_ad/", re.I),
        re.compile(r"/splash/", re.I),
        re.compile(r"/openad/", re.I),
        re.compile(r"/popad/", re.I),
        re.compile(r"/adcard/", re.I),
        re.compile(r"/adbridge/", re.I),
        re.compile(r"/adskip/", re.I),
        re.compile(r"/adout/", re.I),
        re.compile(r"/adinsert/", re.I),
        re.compile(r"/admarker/", re.I),
        re.compile(r"/gg/", re.I),
        re.compile(r"/sp/", re.I),
        re.compile(r"/promo/", re.I),
        re.compile(r"/preroll/", re.I),
        re.compile(r"/midroll/", re.I),
        re.compile(r"/rollad/", re.I),
        re.compile(r"/advertise/", re.I),
        re.compile(r"/adflow/", re.I),
        re.compile(r"/adlog/", re.I),
        re.compile(r"/adtrack/", re.I),
        re.compile(r"/adstat/", re.I),
        re.compile(r"/adreport/", re.I),
        re.compile(r"/adimp/", re.I),
        re.compile(r"/adclick/", re.I),
        re.compile(r"/adcdn/", re.I),
        re.compile(r"/adres/", re.I),
        re.compile(r"/adfile/", re.I),
        re.compile(r"/admedia/", re.I),
        re.compile(r"/advod/", re.I),
        re.compile(r"/adclip/", re.I),
        re.compile(r"/adshort/", re.I),
        re.compile(r"/adfeed/", re.I),
        re.compile(r"/adnative/", re.I),
        re.compile(r"/adinterstitial/", re.I),
    ],
    "globalKeywords": [
        "sponsor", "promo", "splash", "vip_ad", "advert", "advertisement",
        "interstitial", "redtraffic", "preroll", "midroll", "rollad",
        "guanggao", "adseg", "advideo", "adplay", "pre_ad", "mid_ad",
        "开屏", "片头广告", "插播广告", "广告分片", "广告段", "贴片广告",
        "前贴片", "中插", "后贴片", "广告跳转", "广告源", "广告cdn",
        "激励广告", "推广", "招商", "商业", "adinject", "admarker",
        "adinsert", "adout", "adbridge", "popad", "openad", "adcard",
    ],
    "hostRules": [
        {"host": "ad.qq.com", "keywords": ["ad", "advert", "preroll", "midroll"], "regex": [re.compile(r"adseg"), re.compile(r"advideo"), re.compile(r"pre_ad")]},
        {"host": "ads.qq.com", "keywords": ["ad", "advert"], "regex": [re.compile(r"adtrack"), re.compile(r"adstat")]},
        {"host": "ad.youku.com", "keywords": ["ad", "preroll", "midroll"], "regex": [re.compile(r"adseg"), re.compile(r"adclip")]},
        {"host": "ad.iqiyi.com", "keywords": ["ad", "advert", "rollad"], "regex": [re.compile(r"advideo"), re.compile(r"adcdn")]},
        {"host": "ad.mgtv.com", "keywords": ["ad", "preroll"], "regex": [re.compile(r"adseg")]},
        {"host": "ad.bilibili.com", "keywords": ["ad", "advert"], "regex": [re.compile(r"advideo")]},
        {"host": "ad.zyvod.com", "keywords": ["guanggao", "ad", "广告"], "regex": [re.compile(r"adseg"), re.compile(r"adplay")]},
        {"host": "ad.zyplay.com", "keywords": ["guanggao", "ad"], "regex": [re.compile(r"advideo")]},
        {"host": "ad.kkyst.com", "keywords": ["ad", "guanggao"], "regex": [re.compile(r"adclip")]},
        {"host": "ad.vodjx.com", "keywords": ["ad", "guanggao"], "regex": [re.compile(r"adseg")]},
        {"host": "ad.catvod.org", "keywords": ["ad", "advert"], "regex": [re.compile(r"advideo")]},
        {"host": "shturl.cc/27LjB", "keywords": ["ad", "guanggao"], "regex": [re.compile(r"adseg"), re.compile(r"adclip")]},
        {"host": "ad.m3u8.tv", "keywords": ["ad"], "regex": [re.compile(r"advideo")]},
    ]
}

GLOBAL_HEAD = [
    "#EXTM3U", "#EXT-X-VERSION", "#EXT-X-TARGETDURATION", "#EXT-X-MEDIA-SEQUENCE",
    "#EXT-X-DISCONTINUITY-SEQUENCE", "#EXT-X-PLAYLIST-TYPE", "#EXT-X-I-FRAMES-ONLY",
    "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-START", "#EXT-X-MAP", "#EXT-X-ALLOW-CACHE",
    "#EXT-X-SERVER-CONTROL", "#EXT-X-PART-INF",
]
AD_COMMENT_RE = re.compile(r"ad[-_]?(inject|insert|mark|marker)|ppvod|guanggao|adseg|插播|广告", re.I)

# Master m3u8 特征标签（任一存在即视为 master）
MASTER_TAG_MARKERS = (
    '#EXT-X-STREAM-INF',
    '#EXT-X-I-FRAME-STREAM-INF',
    '#EXT-X-MEDIA:',
)


class AdFilter:
    def __init__(self, user_cfg=None):
        self.cfg = self._merge_cfg(user_cfg or {})
        self.report = {}

    def _merge_cfg(self, user):
        cfg = DEFAULTS.copy()
        if "w" in user:
            cfg["w"] = {**cfg["w"], **user["w"]}
        if "rules" in user:
            cfg["rules"] = {**DEFAULT_RULES, **user["rules"]}
        else:
            cfg["rules"] = DEFAULT_RULES.copy()
        for k in user:
            if k not in ("w", "rules"):
                cfg[k] = user[k]
        return cfg

    @staticmethod
    def host_of(uri):
        if not uri:
            return None
        m = re.match(r"^[a-z][a-z0-9+.\-]*://([^/?#:]+)", uri, re.I)
        return m.group(1).lower() if m else None

    @staticmethod
    def naming_key(uri):
        if not uri:
            return ""
        p = re.sub(r"^[a-z][a-z0-9+.\-]*://[^/]+", "", uri, flags=re.I)
        p = p.split("?", 1)[0].split("#", 1)[0]
        return re.sub(r"\d+", "#", p).lower()

    @staticmethod
    def mode(arr):
        c = Counter(arr)
        if not c:
            return None
        return c.most_common(1)[0][0]

    @staticmethod
    def median(nums):
        a = sorted([x for x in nums if isinstance(x, (int, float))])
        if not a:
            return 0.0
        n = len(a)
        m = n // 2
        if n % 2 == 1:
            return a[m]
        return (a[m - 1] + a[m]) / 2

    @staticmethod
    def parse_duration(line):
        rest = line[len("#EXTINF:"):].strip()
        comma = rest.find(",")
        num_str = rest[:comma].strip() if comma >= 0 else rest.strip()
        try:
            return float(num_str)
        except ValueError:
            return 0.0

    @staticmethod
    def is_global_head(t):
        return any(t.startswith(p) for p in GLOBAL_HEAD)

    @staticmethod
    def is_cue_start(t):
        return t.startswith("#EXT-X-CUE-OUT") or t.startswith("#EXT-X-SCTE35") or t.startswith("#EXT-OATCLS-SCTE35") or (t.startswith("#EXT-X-DATERANGE") and "SCTE35" in t.upper())

    @staticmethod
    def is_cue_in(t):
        return t.startswith("#EXT-X-CUE-IN")

    @staticmethod
    def is_cue_any(t):
        return AdFilter.is_cue_start(t) or AdFilter.is_cue_in(t)

    def parse_nodes(self, text):
        raw = text.splitlines()
        head = []
        nodes = []
        tail = []
        pending = []
        inf = None
        seen_seg = False
        for line in raw:
            t = line.strip()
            if not t:
                continue
            if t.startswith("#EXTINF:"):
                inf = t
                continue
            if t[0] != "#":
                if inf is not None:
                    nodes.append({
                        "i": len(nodes),
                        "inf": inf,
                        "uri": t,
                        "dur": self.parse_duration(inf),
                        "tags": pending.copy(),
                        "reasons": []
                    })
                    inf = None
                    pending = []
                    seen_seg = True
                else:
                    head.extend(pending)
                    head.append(t)
                    pending = []
                continue
            if not seen_seg and inf is None and self.is_global_head(t):
                head.append(t)
                continue
            pending.append(t)
        tail.extend(pending)
        return {"head": head, "nodes": nodes, "tail": tail}

    def derive_state(self, parsed):
        key = {"method": "clear", "iv": None, "raw": None}
        in_ad = False
        implicit_iv = False
        implicit_byterange = False
        key_methods = []
        for n in parsed["nodes"]:
            for tag in n["tags"]:
                if tag.startswith("#EXT-X-KEY:"):
                    mm = re.search(r"METHOD=([^,\s]+)", tag)
                    ivm = re.search(r",IV=([^,\s]+)", tag)
                    method = mm.group(1).upper() if mm else ""
                    iv = ivm.group(1) if ivm else None
                    key = {"method": method, "iv": iv, "raw": tag}
                    if method not in key_methods:
                        key_methods.append(method)
                    if method in ("AES-128", "SAMPLE-AES") and iv is None:
                        implicit_iv = True
                if self.is_cue_start(tag):
                    in_ad = True
                elif self.is_cue_in(tag):
                    in_ad = False
                if tag.startswith("#EXT-X-BYTERANGE:") and "@" not in tag:
                    implicit_byterange = True
            n["key"] = key.copy()
            n["scte"] = in_ad
            n["hasDisc"] = any(t.startswith("#EXT-X-DISCONTINUITY") for t in n["tags"])
            n["cueTags"] = [t for t in n["tags"] if self.is_cue_any(t)]
        encrypted = any(n["key"]["method"] not in ("clear", "NONE") for n in parsed["nodes"])
        return {
            "nodes": parsed["nodes"],
            "keyMethods": key_methods,
            "encrypted": encrypted,
            "implicitIV": implicit_iv,
            "implicitByteRange": implicit_byterange,
        }

    def describe_rules(self, playlist_host, rules):
        out = []
        for kw in rules["globalKeywords"]:
            out.append({"label": f"keyword:{kw}", "kind": "kw", "pattern": kw, "display": kw, "hostMatch": True})
        for reo in rules["globalRegex"]:
            out.append({"label": f"regex:{reo.pattern}", "kind": "re", "pattern": reo, "display": f"/{reo.pattern}/", "hostMatch": True})
        if rules.get("hostRules") and playlist_host:
            h = playlist_host.lower()
            for hr in rules["hostRules"]:
                host_match = (h == hr["host"]) or h.endswith("." + hr["host"])
                for kw in hr.get("keywords", []):
                    out.append({"label": f"hostkw:{kw}", "kind": "kw", "pattern": kw, "display": f'{hr["host"]} *{kw}*', "host": hr["host"], "hostMatch": host_match})
                for reo in hr.get("regex", []):
                    out.append({"label": f"hostre:{reo.pattern}", "kind": "re", "pattern": reo, "display": f'{hr["host"]} /{reo.pattern}/', "host": hr["host"], "hostMatch": host_match})
        return out

    @staticmethod
    def test_rule(rule, uri):
        if not rule["hostMatch"]:
            return "skip"
        if rule["kind"] == "kw":
            return rule["pattern"] in uri
        if rule["kind"] == "re":
            return rule["pattern"].search(uri) is not None
        return False

    def detect_rules(self, nodes, playlist_host):
        rules = self.describe_rules(playlist_host, self.cfg["rules"])
        stats = {}
        for r in rules:
            stats[r["label"]] = {"label": r["label"], "display": r["display"], "kind": r["kind"], "host": r.get("host"), "hostMatch": r["hostMatch"], "hits": 0, "miss": 0, "skip": 0, "segs": []}
        for n in nodes:
            n["ruleHits"] = []
            n["ruleMiss"] = []
            for r in rules:
                res = self.test_rule(r, n["uri"])
                if res == "skip":
                    stats[r["label"]]["skip"] += 1
                    continue
                if res:
                    n["ruleHits"].append(r["label"])
                    stats[r["label"]]["hits"] += 1
                    stats[r["label"]]["segs"].append(n["i"])
                else:
                    n["ruleMiss"].append(r["label"])
            if n["ruleHits"]:
                n["reasons"].append(f"rule:{n['ruleHits'][0]}")
        return {"rules": rules, "stats": stats}

    def detect_key_none(self, nodes):
        def is_clear(n):
            return n["key"]["method"] in ("clear", "NONE")
        i = 0
        while i < len(nodes):
            if not is_clear(nodes[i]):
                i += 1
                continue
            j = i
            while j < len(nodes) and is_clear(nodes[j]):
                j += 1
            cnt = j - i
            left_enc = i > 0 and not is_clear(nodes[i - 1])
            right_enc = j < len(nodes) and not is_clear(nodes[j])
            bounded = False
            if self.cfg["keynoneBounded"] == "both":
                bounded = left_enc and right_enc
            else:
                bounded = left_enc or right_enc
            if bounded and self.cfg["minAdBlockSegments"] <= cnt <= self.cfg["maxAdBlockSegments"]:
                for k in range(i, j):
                    nodes[k]["reasons"].append("keynone")
            i = j

    def detect_reuse(self, nodes):
        uri_count = Counter()
        key_count = Counter()
        for n in nodes:
            uri_count[n["uri"]] += 1
            k = self.naming_key(n["uri"])
            key_count[k] += 1
        distinct_uri = len(uri_count)
        distinct_key = len(key_count)
        for n in nodes:
            if self.cfg["useMirrorReuse"] and distinct_uri >= 4 and uri_count[n["uri"]] >= 3 and n["dur"] <= self.cfg["maxAdBlockDurationSec"]:
                n["reasons"].append("mirror-reuse")
            if self.cfg["useNamingReuse"] and distinct_key >= 3 and key_count[self.naming_key(n["uri"])] >= 3 and n["dur"] <= self.cfg["maxAdBlockDurationSec"]:
                n["reasons"].append("naming-reuse")

    def detect_comment_markers(self, nodes):
        if not self.cfg["useCommentMarker"]:
            return
        for n in nodes:
            for tag in n["tags"]:
                t = tag.strip()
                if not t.startswith("#") or t.startswith("#EXT"):
                    continue
                if AD_COMMENT_RE.search(t):
                    n["reasons"].append("ad-comment")
                    break

    def build_chunks(self, nodes):
        chunks = []
        cur = []
        prev = None
        for n in nodes:
            boundary = False
            if cur and prev:
                if n["hasDisc"]:
                    boundary = True
                elif n["key"]["raw"] != prev["key"]["raw"]:
                    boundary = True
                elif n["scte"] != prev["scte"]:
                    boundary = True
                elif self.cfg["splitOnDurationJump"]:
                    diff = abs(n["dur"] - prev["dur"])
                    th = max(3.0, 0.35 * max(n["dur"], prev["dur"]))
                    if diff >= th:
                        boundary = True
            if boundary:
                chunks.append(cur)
                cur = []
            cur.append(n)
            prev = n
        if cur:
            chunks.append(cur)
        return chunks

    @staticmethod
    def ratio_with(chunk, prefix):
        hit = sum(1 for s in chunk if any(r.startswith(prefix) for r in s["reasons"]))
        return hit / len(chunk) if chunk else 0.0

    def score_chunk(self, chunk, idx, chunks, ctx):
        n = len(chunk)
        durs = [s["dur"] for s in chunk]
        total = sum(durs)
        min_dur = min(durs)
        max_dur = max(durs)
        uniform = n >= 2 and (max_dur - min_dur) <= self.cfg["uniformTolerance"]
        short_shape = min_dur >= self.cfg["minAdBlockDurationSec"] and total <= self.cfg["maxAdBlockTotalSec"]
        notes = []
        score = 0.0
        strong = None

        scte_ratio = sum(1 for s in chunk if s["scte"]) / n if n else 0
        keynone_ratio = self.ratio_with(chunk, "keynone")
        rule_ratio = sum(1 for s in chunk if s.get("ruleHits") and s["ruleHits"]) / n if n else 0
        comment_hit = self.cfg["useCommentMarker"] and any("ad-comment" in s["reasons"] for s in chunk)

        if comment_hit:
            strong = "ad-comment"
        elif self.cfg["useScte"] and scte_ratio >= 0.5:
            strong = "scte"
        elif self.cfg["useKeyNone"] and keynone_ratio >= 0.5:
            strong = "keynone"
        elif self.cfg["useRules"] and rule_ratio >= 0.5 and short_shape and n <= self.cfg["maxAdBlockSegments"]:
            strong = "rule"

        if strong is None:
            if short_shape and uniform:
                score += self.cfg["w"]["uniformShort"]
                notes.append("uniform-short")
            elif short_shape:
                score += self.cfg["w"]["shortOnly"]
                notes.append("short")
            if n < self.cfg["minAdBlockSegments"]:
                score += self.cfg["w"]["singlePenalty"]
                notes.append("single")
            if n > self.cfg["maxAdBlockSegments"]:
                score += self.cfg["w"]["longPenalty"]
                notes.append("long{n}")
            if total > 90:
                score += self.cfg["w"]["totalPenalty"]
                notes.append("total>90s")
            if any(s["hasDisc"] for s in chunk):
                score += self.cfg["w"]["disc"]
                notes.append("disc")
            if self.cfg["useHostAnomaly"] and ctx["dominantHost"]:
                if any(self.host_of(s["uri"]) and self.host_of(s["uri"]) != ctx["dominantHost"] for s in chunk):
                    score += self.cfg["w"]["offHost"]
                    notes.append("offhost")
            if ctx["dominantKey"]:
                if any(self.naming_key(s["uri"]) != ctx["dominantKey"] for s in chunk):
                    score += self.cfg["w"]["urlDev"]
                    notes.append("url-dev")
            if self.cfg["useNamingReuse"] and self.ratio_with(chunk, "naming-reuse") >= 0.5:
                score += self.cfg["w"]["namingReuse"]
                notes.append("naming-reuse")
            if self.cfg["useMirrorReuse"] and self.ratio_with(chunk, "mirror-reuse") >= 0.5:
                score += self.cfg["w"]["namingReuse"]
                notes.append("mirror-reuse")

            prev_chunk = chunks[idx - 1] if idx > 0 else None
            next_chunk = chunks[idx + 1] if idx < len(chunks) - 1 else None
            if prev_chunk and next_chunk:
                prev_dur = prev_chunk[-1]["dur"]
                next_dur = next_chunk[0]["dur"]
                if prev_dur >= 1.5 * max_dur and next_dur >= 1.5 * max_dur:
                    score += self.cfg["w"]["shortBetweenLong"]
                    notes.append("short-between-long")

            if ctx["medianDur"] > 0 and ctx["medianDur"] <= 5 and uniform and n >= 2 * max(1, ctx["avgChunkSize"]):
                score += self.cfg["w"]["denseShort"]
                notes.append("dense-short")

            if prev_chunk and next_chunk:
                cur_key = self.mode([self.naming_key(s["uri"]) for s in chunk])
                pk = self.mode([self.naming_key(s["uri"]) for s in prev_chunk])
                nk = self.mode([self.naming_key(s["uri"]) for s in next_chunk])
                if cur_key and pk and nk and cur_key != pk and cur_key != nk:
                    score += self.cfg["w"]["seqIsland"]
                    notes.append("seq-island")

            if self.cfg["useRules"] and rule_ratio >= 0.5:
                score += self.cfg["w"]["ruleWeak"]
                notes.append("rule-weak")

        threshold = self.cfg["baseThreshold"]
        if idx == 0:
            threshold += self.cfg["firstBonus"]
        if idx == len(chunks) - 1:
            threshold += self.cfg["lastBonus"]

        structural_notes = {"disc", "offhost", "url-dev", "naming-reuse", "mirror-reuse", "seq-island", "rule-weak"}
        has_structural = any(x in structural_notes for x in notes)
        hit = True if strong else (score >= threshold)
        if strong is None and hit and self.cfg["requireStructural"] and not has_structural:
            hit = False
            notes.append("shape-only")

        return {
            "idx": idx, "n": n, "total": round(total, 1), "min": round(min_dur, 1), "max": round(max_dur, 1),
            "uniform": uniform, "shortShape": short_shape, "scteRatio": round(scte_ratio, 2),
            "keynoneRatio": round(keynone_ratio, 2), "ruleRatio": round(rule_ratio, 2),
            "score": 1.0 if strong else round(score, 2), "threshold": round(threshold, 2),
            "strong": strong, "notes": "+".join(notes), "hit": hit
        }

    @staticmethod
    def range_has_disc(nodes, fr, to):
        for i in range(fr, to + 1):
            if nodes[i].get("hasDisc"):
                return True
        return False

    @staticmethod
    def has_dropped_in(dropped, fr, to):
        for i in range(fr, to + 1):
            if i in dropped:
                return True
        return False

    def balance_cues(self, lines):
        out = []
        open_pos = None
        removed = 0
        for l in lines:
            if self.is_cue_start(l):
                if open_pos is not None:
                    del out[open_pos]
                    removed += 1
                    open_pos = None
                open_pos = len(out)
                out.append(l)
            elif self.is_cue_in(l):
                if open_pos is None:
                    removed += 1
                    continue
                open_pos = None
                out.append(l)
            else:
                out.append(l)
        if open_pos is not None:
            del out[open_pos]
            removed += 1
        return {"lines": out, "removed": removed}

    def rebuild(self, parsed, dropped):
        nodes = parsed["nodes"]
        head = parsed["head"].copy()
        dropped_at_start = 0
        disc_at_start = 0
        for i in range(len(nodes)):
            if i not in dropped:
                break
            dropped_at_start += 1
            if nodes[i]["hasDisc"]:
                disc_at_start += 1
        for i in range(len(head)):
            line = head[i]
            if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                try:
                    v = int(line.split(":", 1)[1])
                    head[i] = f"#EXT-X-MEDIA-SEQUENCE:{v + dropped_at_start}"
                except Exception:
                    pass
            if line.startswith("#EXT-X-DISCONTINUITY-SEQUENCE:") and disc_at_start > 0:
                try:
                    v = int(line.split(":", 1)[1])
                    head[i] = f"#EXT-X-DISCONTINUITY-SEQUENCE:{v + disc_at_start}"
                except Exception:
                    pass
        out = head.copy()
        emitted_key = "__headkey__" if any(l.startswith("#EXT-X-KEY:") for l in head) else None
        prev_kept = -1
        disc_emitted = False
        for i, n in enumerate(nodes):
            if i in dropped:
                continue
            if n["key"]["raw"] and n["key"]["raw"] != emitted_key:
                out.append(n["key"]["raw"])
                emitted_key = n["key"]["raw"]
            gap_dropped = self.has_dropped_in(dropped, prev_kept + 1, i - 1)
            want_disc = n["hasDisc"] or (gap_dropped and self.range_has_disc(nodes, prev_kept + 1, i - 1))
            if want_disc and not disc_emitted:
                out.append("#EXT-X-DISCONTINUITY")
            disc_emitted = want_disc
            for tag in n["tags"]:
                if tag.startswith("#EXT-X-KEY:") or tag.startswith("#EXT-X-DISCONTINUITY"):
                    continue
                out.append(tag)
            out.append(n["inf"])
            out.append(n["uri"])
            prev_kept = i
        out.extend(parsed["tail"])
        return {"lines": out, "droppedAtStart": dropped_at_start, "discAtStart": disc_at_start}

    def verify(self, body, expect_count):
        issues = []
        parsed = self.parse_nodes(body)
        st = self.derive_state(parsed)
        if not body.strip().startswith("#EXTM3U"):
            issues.append("not-start-with-EXTM3U")
        if len(parsed["nodes"]) != expect_count:
            issues.append(f"segment-count {len(parsed['nodes'])}!={expect_count}")
        extinf_cnt = body.count("#EXTINF:")
        if extinf_cnt != expect_count:
            issues.append(f"extinf {extinf_cnt}!={expect_count}")
        disc_lines = re.findall(r"^#EXT-X-DISCONTINUITY\s*$", body, re.M)
        disc_count = len(disc_lines)
        if re.search(r"#EXT-X-DISCONTINUITY\r?\n#EXT-X-DISCONTINUITY", body):
            issues.append("double-discontinuity")
        cue_out = len(re.findall(r"#EXT-X-CUE-OUT|#EXT-X-SCTE35|#EXT-OATCLS-SCTE35", body))
        cue_in = len(re.findall(r"#EXT-X-CUE-IN", body))
        if cue_out != cue_in:
            issues.append(f"cue-unbalanced {cue_out}/{cue_in}")
        if len(parsed["nodes"]) < self.cfg["minRemainingSegments"]:
            issues.append(f"too-few-remaining {len(parsed['nodes'])}")
        if st["implicitIV"]:
            issues.append("implicit-iv-after-rebuild")
        return {
            "ok": len(issues) == 0,
            "issues": issues,
            "segments": len(parsed["nodes"]),
            "discCount": disc_count,
            "cueOut": cue_out,
            "cueIn": cue_in
        }

    def filter_playlist(self, text, url):
        report = {
            "url": url or "",
            "verdict": "CLEAN",
            "gate": None,
            "parse": {},
            "env": {},
            "rules": None,
            "chunks": [],
            "summary": {},
            "removed": [],
            "rebuild": {},
            "verify": {}
        }
        parsed = self.parse_nodes(text)
        st = self.derive_state(parsed)
        nodes = parsed["nodes"]
        playlist_host = self.host_of(url or "")
        total_dur = sum(n["dur"] for n in nodes)
        is_master = any("#EXT-X-STREAM-INF" in line for line in parsed["head"])
        has_endlist = any("#EXT-X-ENDLIST" in line for line in parsed["tail"]) or "#EXT-X-ENDLIST" in text

        report["parse"] = {
            "segments": len(nodes),
            "duration": round(total_dur, 1),
            "lines": len(text.splitlines()),
            "master": is_master
        }
        report["env"] = {
            "host": playlist_host or "-",
            "encrypted": st["encrypted"],
            "implicitIV": st["implicitIV"],
            "implicitByteRange": st["implicitByteRange"],
            "keys": st["keyMethods"]
        }

        gate = None
        if not text.strip().startswith("#EXTM3U"):
            gate = "not-m3u8"
        elif is_master:
            gate = "master-playlist"
        elif self.cfg["skipLive"] and not has_endlist:
            gate = "live-or-event(no-ENDLIST)"
        elif self.cfg["skipByteRangeImplicit"] and st["implicitByteRange"]:
            gate = "byterange-without-offset"
        elif self.cfg["skipImplicitIV"] and st["implicitIV"]:
            gate = "aes128-implicit-iv"
        elif len(nodes) < self.cfg["minSegments"]:
            gate = f"too-few-segments({len(nodes)})"
        report["gate"] = gate
        if gate is not None:
            report["verdict"] = "SKIP"
            # 保证 check.sh 等回归脚本总能读到数值字段（闸门分支不进入统计逻辑）
            report["summary"] = {
                "removedCount": 0, "removedDur": 0,
                "totalDur": round(total_dur, 1), "reasons": {},
            }
            report["parse"] = {
                "segments": len(nodes), "duration": round(total_dur, 1),
                "master": is_master,
            }
            self.report = report
            return {"changed": False, "body": text, "report": report}

        rule_info = self.detect_rules(nodes, playlist_host) if self.cfg["useRules"] else {"rules": [], "stats": {}}
        report["rules"] = {
            "total": len(rule_info["rules"]),
            "effective": 0,
            "dead": 0,
            "list": []
        }
        if self.cfg["useRules"]:
            for r in rule_info["rules"]:
                s = rule_info["stats"][r["label"]]
                if s["skip"] == len(nodes):
                    status = "SKIP"
                elif s["hits"] == 0:
                    status = "DEAD"
                    report["rules"]["dead"] += 1
                elif s["hits"] == len(nodes):
                    status = "ALL"
                    report["rules"]["effective"] += 1
                else:
                    status = "HIT"
                    report["rules"]["effective"] += 1
                report["rules"]["list"].append({
                    "label": s["label"], "display": s["display"],
                    "hits": s["hits"], "miss": s["miss"],
                    "status": status, "segs": s["segs"][:8]
                })

        if self.cfg["useCommentMarker"]:
            self.detect_comment_markers(nodes)
        if st["encrypted"] and self.cfg["useKeyNone"]:
            self.detect_key_none(nodes)
        if not st["encrypted"] and (self.cfg["useNamingReuse"] or self.cfg["useMirrorReuse"]):
            self.detect_reuse(nodes)

        chunks = self.build_chunks(nodes)
        hosts_with_value = [self.host_of(n["uri"]) for n in nodes if self.host_of(n["uri"])]
        ctx = {
            "dominantHost": self.mode(hosts_with_value) if len(hosts_with_value) >= len(nodes) * 0.5 else None,
            "dominantKey": self.mode([self.naming_key(n["uri"]) for n in nodes]),
            "medianDur": self.median([n["dur"] for n in nodes if n["dur"] > 0]),
            "avgChunkSize": len(nodes) / len(chunks) if chunks else len(nodes)
        }
        scores = []
        removed_count = 0
        removed_dur = 0.0
        dropped = set()
        for idx, chunk in enumerate(chunks):
            sc = self.score_chunk(chunk, idx, chunks, ctx)
            scores.append(sc)
            if sc["hit"]:
                for seg in chunk:
                    dropped.add(seg["i"])
                removed_count += len(chunk)
                removed_dur += sum(s["dur"] for s in chunk)
        report["chunks"] = scores
        reason_counts = Counter()
        for i in dropped:
            for r in nodes[i]["reasons"]:
                reason_counts[r] += 1
        report["summary"] = {
            "removedCount": removed_count,
            "removedDur": round(removed_dur, 1),
            "totalDur": round(total_dur, 1),
            "reasons": dict(reason_counts)
        }

        ratio = removed_count / len(nodes) if nodes else 0
        # 安全兜底：删太多则放弃过滤，返回原片
        if len(nodes) - removed_count < self.cfg["minRemainingSegments"]:
            report["verdict"] = "REVERT"
            self.report = report
            return {"changed": False, "body": text, "report": report}
        if removed_count > self.cfg["maxAdBlockSegments"] and (ratio > self.cfg["maxRemovedRatio"] or removed_dur > self.cfg["maxRemovedDurationSec"]):
            report["verdict"] = "REVERT"
            self.report = report
            return {"changed": False, "body": text, "report": report}
        if not removed_count:
            report["verdict"] = "CLEAN"
            self.report = report
            return {"changed": False, "body": text, "report": report}

        report["removed"] = []
        for i in sorted(dropped):
            n = nodes[i]
            report["removed"].append({"i": i, "dur": n["dur"], "reasons": n["reasons"], "uri": n["uri"]})

        built = self.rebuild(parsed, dropped)
        balanced = self.balance_cues(built["lines"])
        new_body = "\n".join(balanced["lines"])
        v = self.verify(new_body, len(nodes) - removed_count)
        report["verify"] = v
        if not v["ok"]:
            report["verdict"] = "REVERT"
            self.report = report
            return {"changed": False, "body": text, "report": report}
        if self.cfg["dryRun"]:
            report["verdict"] = "DRYRUN"
            self.report = report
            return {"changed": True, "body": new_body, "report": report}

        report["verdict"] = "CHANGED"
        self.report = report
        return {"changed": True, "body": new_body, "report": report}


# ============================================================
# 请求头
# ============================================================
def build_upstream_headers(user_headers: dict, target_url: str = "") -> dict:
    """
    合并默认头 + 用户头。
    Referer 自动兜底：用户未显式传 Referer 时，用源站 origin 作为 Referer。
    """
    final = dict(DEFAULT_HEADERS)
    for k, v in user_headers.items():
        if not k or not isinstance(k, str):
            continue
        if k.lower() in BLOCKED_HEADERS:
            continue
        final[k] = str(v)

    # Referer 自动兜底
    if target_url:
        has_referer = any(k.lower() == "referer" for k in final)
        if not has_referer:
            try:
                parts = urlsplit(target_url)
                if parts.scheme and parts.netloc:
                    final["Referer"] = f"{parts.scheme}://{parts.netloc}/"
            except Exception:
                pass
    return final


def encode_url_path(target: str) -> str:
    """对 URL 的 path 做百分号编码，保留 / 和已有 %。"""
    try:
        parts = urlsplit(target)
        safe_path = quote(parts.path, safe="/%")
        return urlunsplit((parts.scheme, parts.netloc, safe_path,
                           parts.query, parts.fragment))
    except Exception:
        return target


# ============================================================
# 拉取上游
# ============================================================
def fetch_m3u(target: str, user_headers: dict):
    target = encode_url_path(target)
    headers = build_upstream_headers(user_headers, target)
    req = Request(target, headers=headers)
    try:
        with open_upstream(req) as resp:
            content = resp.read(MAX_BYTES)
            return resp.status, content, dict(resp.headers.items())
    except HTTPError as e:
        return e.code, f"上游返回 {e.code}: {target}".encode(), dict(e.headers or {})
    except URLError as e:
        raise RuntimeError(f"上游请求失败: {e.reason}")
    except Exception as e:
        raise RuntimeError(f"代理异常: {e}")


# ============================================================
# 去广告入口（对接新AdFilter）
# ============================================================
def is_master_playlist(text: str) -> bool:
    """检测 master m3u8：含 STREAM-INF / I-FRAME-STREAM-INF / MEDIA 标签。"""
    for marker in MASTER_TAG_MARKERS:
        if marker in text:
            return True
    return False


def filter_ads(text: str, url: str = "", return_report: bool = False):
    """对外统一入口：和JS原版行为对齐。
    return_report=True 时返回 (body, report)，供 /hls?json=1 输出结构化诊断。
    """
    if is_master_playlist(text):
        report = {
            "verdict": "SKIP", "gate": "master-playlist",
            "parse": {"segments": 0, "master": True},
            "summary": {"removedCount": 0, "removedDur": 0},
            "removed": [],
        }
        return (text, report) if return_report else text
    af = AdFilter()
    res = af.filter_playlist(text, url)
    if return_report:
        return res["body"], res["report"]
    return res["body"]


# ============================================================
# URI 全量重写
# ============================================================
def rewrite_uri(uri: str, base_url: str) -> str:
    """相对 URI → 绝对 URI，path 百分号编码（纯 ASCII）。"""
    try:
        abs_uri = urljoin(base_url, uri)
        parts = urlsplit(abs_uri)
        safe_path = quote(parts.path, safe="/%")
        return urlunsplit((parts.scheme, parts.netloc, safe_path,
                           parts.query, parts.fragment))
    except Exception:
        return uri


def rewrite_tag_uris(line: str, base_url: str) -> str:
    """重写标签行内所有 URI="..." 属性（KEY/MAP/MEDIA/I-FRAME/SESSION-KEY/PART 等）。"""
    if 'URI="' not in line:
        return line
    def subfn(m):
        return f'URI="{rewrite_uri(m.group(1), base_url)}"'
    return re.sub(r'URI="([^"]+)"', subfn, line)


def rewrite_all_uris(text: str, base_url: str) -> str:
    """
    逐行处理：
      - 标签行：只重写 URI="..." 属性
      - 非标签行（分片行 / 子清单行）：整行重写为绝对地址
    """
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith('#'):
            out.append(rewrite_tag_uris(line, base_url))
        else:
            out.append(rewrite_uri(s, base_url))
    return '\n'.join(out)


def process_m3u(content_bytes: bytes, base_url: str, return_report: bool = False):
    # 清理 UTF-8 BOM，避免首行 "#EXTM3U" 被误判为非标签行
    text = content_bytes.decode("utf-8", errors="replace").lstrip('\ufeff')
    if return_report:
        text, report = filter_ads(text, base_url, True)
    else:
        text = filter_ads(text, base_url)
        report = None
    text = rewrite_all_uris(text, base_url)
    body = text.encode("utf-8")
    return (body, report) if return_report else body


# ============================================================
# HTTP Handler
# ============================================================
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, body, content_type="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, obj, extra=None):
        self._send(status, json.dumps(obj, ensure_ascii=False, default=str),
                   "application/json; charset=utf-8", extra)

    def _handle_m3u(self, target, user_headers, want_json):
        if not target.startswith(("http://", "https://")):
            return self._send_json(400, {"error": "url 必须是 http/https 地址"})
        try:
            up_status, content, up_headers = fetch_m3u(target, user_headers)
        except RuntimeError as e:
            return self._send_json(502, {"error": str(e), "url": target})
        if up_status >= 400:
            return self._send_json(502, {
                "error": f"上游返回 {up_status}", "url": target,
                "request_headers": build_upstream_headers(user_headers, target),
            })

        original_size = len(content)
        content, report = process_m3u(content, target, True)
        cleaned_size = len(content)

        if want_json:
            return self._send_json(200, {
                "status": up_status, "url": target,
                "original_size": original_size,
                "cleaned_size": cleaned_size,
                "size_delta": cleaned_size - original_size,
                "request_headers": build_upstream_headers(user_headers, target),
                "upstream_headers": up_headers,
                "report": report,
                "content": content.decode("utf-8", errors="replace"),
            })

        return self._send(200, content,
                          "application/vnd.apple.mpegurl; charset=utf-8", {
                              "X-Upstream-Status": str(up_status),
                              "X-Original-Size": str(original_size),
                              "X-Cleaned-Size": str(cleaned_size),
                              "Cache-Control": "no-store",
                          })

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self._send_json(200, {"status": "ok"})
        # /m3u 为 catvod 历史调用路径，保留别名兼容
        if parsed.path not in ("/hls", "/m3u"):
            return self._send(404, "可用: /health , GET /hls?url=... (别名 /m3u) , POST /hls")
        params = parse_qs(parsed.query, keep_blank_values=True)
        raw_url = params.get("url", [None])[0]
        if not raw_url:
            return self._send_json(400, {"error": "缺少 url 参数"})
        want_json = "json" in params
        return self._handle_m3u(raw_url, headers_from_query(params), want_json)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/hls", "/m3u"):
            return self._send_json(404, {"error": "POST 仅支持 /hls (或别名 /m3u)"})
        try:
            cl = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(cl).decode("utf-8")
            payload = json.loads(body)
        except Exception:
            return self._send_json(400, {"error": "POST body json解析失败"})
        target = payload.get("url")
        if not target:
            return self._send_json(400, {"error": "payload 缺少 url"})
        user_headers = payload.get("headers", {})
        want_json = payload.get("json", False)
        return self._handle_m3u(target, user_headers, want_json)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"✅ hlsProxyClean 启动成功，监听端口 {PORT}")
    print(f"👉 测试地址：http://127.0.0.1:{PORT}/health")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 服务停止")
        server.shutdown()
