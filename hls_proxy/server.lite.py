#!/usr/bin/env python3
"""
简版server.py，单文件、无依赖、Python3.7+，仅做 HLS m3u8 代理 + 去广告 + 全量绝对地址重写。

HLS Clean —— 通用 M3U 代理 + 去广告 + 全量绝对地址重写

核心特性:
  1. Master m3u8 (含 #EXT-X-STREAM-INF / I-FRAME-STREAM-INF / MEDIA:) 不做去广告
     → 避免把子清单当分片误删
  2. 全量 URI 重写：分片行、子清单行、所有 URI="..." 属性全部转绝对地址 + 百分号编码
  3. 请求上游自动兜底 Referer：用户未传时用源站 origin
  4. 去广告仅做通用粗处理，不依赖源站私有标记
  5. UTF-8 BOM 自动清理，避免首行被误判为 URI

项目: hls-clean
域名: https://hls.wangqifei.eu.org
"""

import json
import os
import re
import sys
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import (urlparse, parse_qs, unquote, urlsplit,
                          urlunsplit, quote, urljoin)
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

PORT = int(os.environ.get("PORT", "50001"))
TIMEOUT = 15
MAX_BYTES = 5 * 1024 * 1024

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

# ---------- 去广告可调参数 ----------
SHORT_RUN_MIN = 3
SHORT_RATIO = 0.5
SHORT_ABS_MAX = 4.0
REPEAT_MIN = 2
PATH_SHARE_MAX = 0.34
MODE_SHARE_MIN = 0.95

CUE_OUT_RE = re.compile(r'#EXT-X-CUE-OUT\b', re.I)
CUE_IN_RE = re.compile(r'#EXT-X-CUE-IN\b', re.I)
SCTE35_RE = re.compile(r'#EXT-X-SCTE35|#EXT-OATCLS-SCTE35', re.I)
EXTINF_RE = re.compile(r'#EXTINF:\s*([\d.]+)')
URI_ATTR_RE = re.compile(r'URI="([^"]+)"')

# Master m3u8 特征标签（任一存在即视为 master）
MASTER_TAG_MARKERS = (
    '#EXT-X-STREAM-INF',
    '#EXT-X-I-FRAME-STREAM-INF',
    '#EXT-X-MEDIA:',
)


# ============================================================
# 请求头
# ============================================================
def build_upstream_headers(user_headers: dict, target_url: str = "") -> dict:
    """
    合并默认头 + 用户头。
    Referer 兜底：用户未显式传 Referer 时，用源站 origin 作为 Referer。
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
        with urlopen(req, timeout=TIMEOUT) as resp:
            content = resp.read(MAX_BYTES)
            return resp.status, content, dict(resp.headers.items())
    except HTTPError as e:
        return e.code, f"上游返回 {e.code}: {target}".encode(), dict(e.headers or {})
    except URLError as e:
        raise RuntimeError(f"上游请求失败: {e.reason}")
    except Exception as e:
        raise RuntimeError(f"代理异常: {e}")


# ============================================================
# 去广告（通用粗处理）
# ============================================================
def should_skip(text: str) -> bool:
    """live / 无 ENDLIST / 无 DISCONTINUITY / 加密信息不全 → 不去广告。"""
    if '#EXT-X-ENDLIST' not in text:
        return True
    if '#EXT-X-DISCONTINUITY' not in text:
        return True
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('#EXT-X-KEY') and 'IV=' not in s.upper():
            return True
        if s.startswith('#EXT-X-BYTERANGE') and '@' not in s:
            return True
    return False


def is_master_playlist(text: str) -> bool:
    """检测 master m3u8：含 STREAM-INF / I-FRAME-STREAM-INF / MEDIA 标签。"""
    for marker in MASTER_TAG_MARKERS:
        if marker in text:
            return True
    return False


def parse_blocks(text: str):
    header, blocks, pending = [], [], []
    seen = False
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith('#'):
            (pending if seen else header).append(line)
            continue
        seen = True
        dur = 0.0
        for t in pending:
            m = EXTINF_RE.match(t)
            if m:
                dur = float(m.group(1))
                break
        blocks.append({'tags': pending, 'uri': s, 'dur': dur})
        pending = []
    return header, blocks, pending


def full_fingerprint(uri: str) -> str:
    try:
        p = urlsplit(uri)
        return (p.hostname or '') + p.path
    except Exception:
        return uri


def filter_ads(text: str) -> str:
    # ① Master m3u8 直接跳过，避免误删子清单
    if is_master_playlist(text):
        return text
    # ② 其他安全跳过条件
    if should_skip(text):
        return text

    header, blocks, tail = parse_blocks(text)
    n = len(blocks)
    if n == 0:
        return text

    # 信号 1: CUE / SCTE35 区间
    in_cue, cue_ad = False, [False] * n
    for i, b in enumerate(blocks):
        blob = '\n'.join(b['tags'])
        if CUE_IN_RE.search(blob):
            in_cue = False
            continue
        if CUE_OUT_RE.search(blob) or SCTE35_RE.search(blob):
            in_cue = True
        if in_cue:
            cue_ad[i] = True

    # 信号 2: 连续短时长簇
    durs = [b['dur'] for b in blocks if b['dur'] > 0]
    short_ad = [False] * n
    if durs:
        median = sorted(durs)[len(durs) // 2]
        thr = min(median * SHORT_RATIO, SHORT_ABS_MAX)
        run = []
        for i, b in enumerate(blocks):
            if 0 < b['dur'] < thr:
                run.append(i)
            else:
                if len(run) >= SHORT_RUN_MIN:
                    for j in run:
                        short_ad[j] = True
                run = []
        if len(run) >= SHORT_RUN_MIN:
            for j in run:
                short_ad[j] = True

    # 信号 3: 重复 URI
    fp = [full_fingerprint(b['uri']) for b in blocks]
    cnt = Counter(fp)
    repeat_ad = [cnt[f] >= REPEAT_MIN for f in fp]

    # 信号 4: 路径占比异常
    path_of = []
    for b in blocks:
        p = urlsplit(b['uri']).path
        path_of.append('/'.join(p.split('/')[:-1]) or '/')
    pcount = Counter(path_of)
    main_share = max(pcount.values()) / n if n else 0
    path_ad = [main_share > 0.66 and pcount[path_of[i]] / n < PATH_SHARE_MAX
               for i in range(n)]

    # 信号 5: DISCONTINUITY 组时长众数
    groups, cur = [], []
    for i, b in enumerate(blocks):
        if any('#EXT-X-DISCONTINUITY' in t for t in b['tags']):
            if cur:
                groups.append(cur)
            cur = [i]
        else:
            cur.append(i)
    if cur:
        groups.append(cur)

    mode_ad = [False] * n
    if len(groups) >= 2:
        totals = [sum(blocks[i]['dur'] for i in g) for g in groups]
        mode_total = Counter(round(t, 1) for t in totals).most_common(1)[0][0]
        mode_cnt = sum(1 for t in totals if round(t, 1) == mode_total)
        if mode_cnt / len(groups) >= MODE_SHARE_MIN:
            for g, t in zip(groups, totals):
                if round(t, 1) != mode_total and t < mode_total * 0.5:
                    for i in g:
                        mode_ad[i] = True

    # 组合判定
    is_ad = [False] * n
    for i in range(n):
        if cue_ad[i]:
            is_ad[i] = True
        elif short_ad[i] and (repeat_ad[i] or path_ad[i] or mode_ad[i]):
            is_ad[i] = True
        elif repeat_ad[i] and path_ad[i]:
            is_ad[i] = True

    out = list(header)
    for i, b in enumerate(blocks):
        if is_ad[i]:
            continue
        out.extend(b['tags'])
        out.append(b['uri'])
    out.extend(tail)
    return '\n'.join(out) + '\n'


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
    return URI_ATTR_RE.sub(
        lambda m: f'URI="{rewrite_uri(m.group(1), base_url)}"',
        line
    )


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


def process_m3u(content_bytes: bytes, base_url: str) -> bytes:
    # 清理 UTF-8 BOM，避免首行 "#EXTM3U" 被误判为非标签行
    text = content_bytes.decode("utf-8", errors="replace").lstrip('\ufeff')
    text = filter_ads(text)
    text = rewrite_all_uris(text, base_url)
    return text.encode("utf-8")


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
        self._send(status, json.dumps(obj, ensure_ascii=False),
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
        content = process_m3u(content, target)
        cleaned_size = len(content)

        if want_json:
            return self._send_json(200, {
                "status": up_status, "url": target,
                "original_size": original_size,
                "cleaned_size": cleaned_size,
                "size_delta": cleaned_size - original_size,
                "request_headers": build_upstream_headers(user_headers, target),
                "upstream_headers": up_headers,
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
        if parsed.path != "/hls":
            return self._send(404, "可用: /health , GET /hls?url=... , POST /hls")
        params = parse_qs(parsed.query, keep_blank_values=True)
        raw_url = params.get("url", [None])[0]
        if not raw_url:
            return self._send_json(400, {"error": "缺少 url 参数"})
        target = unquote(raw_url)

        user_headers = {}
        if params.get("referer"): user_headers["Referer"] = params["referer"][0]
        if params.get("origin"): user_headers["Origin"] = params["origin"][0]
        if params.get("ua"): user_headers["User-Agent"] = params["ua"][0]
        if params.get("cookie"): user_headers["Cookie"] = params["cookie"][0]
        for key in params:
            if key.startswith("header.") and params[key]:
                user_headers[key[len("header."):]] = params[key][0]

        want_json = params.get("format", [""])[0].lower() == "json"
        return self._handle_m3u(target, user_headers, want_json)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/hls":
            return self._send_json(404, {"error": "仅支持 POST /hls"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            return self._send_json(400, {"error": f"请求体解析失败: {e}"})
        target = data.get("url")
        if not target or not isinstance(target, str):
            return self._send_json(400, {"error": "缺少 url"})
        user_headers = data.get("headers") or {}
        if not isinstance(user_headers, dict):
            return self._send_json(400, {"error": "headers 必须是对象"})
        want_json = str(data.get("format", "")).lower() == "json"
        return self._handle_m3u(target, user_headers, want_json)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"hls-clean listening on 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
