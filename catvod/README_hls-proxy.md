# HLS Proxy

通用 M3U/HLS 代理服务：拉取上游播放清单 → 去广告 → 全量 URI 重写为绝对地址 → 返回给播放器。
核心特性:
  1. Master m3u8 (含 #EXT-X-STREAM-INF / I-FRAME-STREAM-INF / MEDIA:) 不做去广告
     → 避免把子清单当分片误删
  2. 全量 URI 重写：分片行、子清单行、所有 URI="..." 属性全部转绝对地址 + 百分号编码
  3. 请求上游自动兜底 Referer：用户未传时用源站 origin
  4. 去广告仅做通用粗处理，不依赖源站私有标记
  5. UTF-8 BOM 自动清理，避免首行被误判为 URI

- **项目目录**：`/personal/hls-proxy`（计划重命名为 `hls-clean`）
- **对外域名**：`https://hls.wangqifei.eu.org`
- **监听端口**：`50001`
- **运行环境**：Bohrium 容器（Ubuntu 22.04，2C 4G，无独立公网 IP）, node address: sbph1493620.bohrium.tech


---

## 一、架构总览

```
Stremio / 浏览器 / VLC
        │  HTTPS
        ▼
https://hls.wangqifei.eu.org          ← Cloudflare 边缘（自动证书）
        │  Cloudflare Tunnel
        ▼
cloudflared（pm2 守护，QUIC/HTTP2）
        │  http://localhost:50001
        ▼
server.py（Python 标准库，无第三方依赖）
        │  HTTPS 拉取（自动带 UA + 兜底 Referer）
        ▼
上游 maccms / catvod 源站
        │
        └─ 处理：去广告 → 全量 URI 重写（纯 ASCII）→ 返回
```

**核心设计**：
- 分片**不走代理**，直接由播放器连源站，节省容器带宽
- 所有 URL（分片、子清单、KEY/MAP 等）重写时做百分号编码，避免浏览器双重编码 404
- Master m3u8 不做去广告（避免误删子清单），但子清单 URL 会被重写
- 请求上游自动兜底 Referer（源站 origin），提升对防盗链源站的兼容性
- 去广告只做通用粗处理，不依赖任何源站私有标记

---

## 二、目录与关键文件

| 路径 | 作用 |
| :--- | :--- |
| `/personal/hls-proxy/server.py` | 主服务代码 |
| `/root/.cloudflared/config.yml` | Cloudflare Tunnel 路由配置 |
| `/root/.cloudflared/56494fe0-...json` | Tunnel 凭证（**勿删**） |
| `/root/.pm2/dump.pm2` | pm2 进程快照（`pm2 save` 生成） |
| `/root/.pm2/logs/` | pm2 进程日志 |

---

## 三、外部依赖（已配置好，勿删）

| 项目 | 值 |
| :--- | :--- |
| Tunnel 名称 | `stremio-tunnel` |
| Tunnel ID | `56494fe0-bafc-48e0-b964-e9d182bb9fad` |
| 新域名 | `hls.wangqifei.eu.org` |
| 旧域名（保留兼容） | `stremio.wangqifei.eu.org` |

**DNS 记录**（Cloudflare Dashboard → DNS）：
- `hls` → CNAME → `56494fe0-bafc-48e0-b964-e9d182bb9fad.cfargotunnel.com`（橙色云朵）
- `stremio` → 同上

---

## 四、日常操作速查

| 操作 | 命令 |
| :--- | :--- |
| 看服务状态 | `pm2 list` + `tmux ls` |
| 看服务日志 | `pm2 logs hls-clean` 或 `tmux attach -t hls` |
| 重启 server.py | `pm2 restart hls-clean`（pm2）或 tmux 里 Ctrl+C 后重启 |
| 重启 cloudflared | `pm2 restart cloudflared-tunnel` |
| 测试是否存活 | `curl https://hls.wangqifei.eu.org/health` |

---

## 五、启动 / 重启服务

### 5.1 首次启动（或容器重启后）

**Step 1 — 确认 cloudflared 在跑**（pm2 管理）

```bash
pm2 list
# 期望: cloudflared-tunnel  status=online

pm2 logs cloudflared-tunnel --lines 20 --nostream | grep "Registered tunnel connection"
# 期望: 有 4 条 Registered tunnel connection
```

**Step 2 — 启动 server.py**

方式 A（tmux，临时用）：

```bash
tmux new -s hls
cd /personal/hls-proxy
python3 server.py
# 看到 "hls-clean listening on 0.0.0.0:50001" 后
# Ctrl+B，松开，再按 D 分离
```

方式 B（pm2，推荐长期用）：

```bash
pm2 start /personal/hls-proxy/server.py \
  --name hls-clean \
  --interpreter python3 \
  --cwd /personal/hls-proxy
pm2 save
```

**Step 3 — 验证**

```bash
curl --noproxy '*' http://127.0.0.1:50001/health   # 容器内
curl https://hls.wangqifei.eu.org/health            # 外部
# 期望: {"status":"ok"}
```

### 5.2 重启

| 场景 | 命令 |
| :--- | :--- |
| 重启 server.py（tmux 版） | `tmux attach -t hls` → Ctrl+C → `python3 server.py` → Ctrl+B D |
| 重启 server.py（pm2 版） | `pm2 restart hls-clean` |
| 重启 cloudflared | `pm2 restart cloudflared-tunnel` |
| 全部重启 | `pm2 restart all` |

> ⚠️ **不要用 `pkill cloudflared`**，pm2 会立刻拉起新进程，可能造成多实例冲突。要停用 `pm2 stop cloudflared-tunnel`。

---

## 六、接口说明

### GET /health

```bash
curl https://hls.wangqifei.eu.org/health
# → {"status":"ok"}
```

### GET /m3u

| 参数 | 必填 | 说明 |
| :--- | :--- | :--- |
| `url` | ✅ | 原始 m3u 地址（建议 encodeURIComponent） |
| `referer` | ❌ | 请求上游时的 Referer（不传时自动用源站 origin 兜底） |
| `origin` | ❌ | 请求上游时的 Origin |
| `ua` | ❌ | 覆盖 User-Agent |
| `cookie` | ❌ | 请求上游时的 Cookie |
| `header.X-Any` | ❌ | 任意自定义头，如 `header.X-Token=abc` |
| `format` | ❌ | 传 `json` 返回调试信息 |

### POST /m3u

请求头多、值复杂时推荐：

```bash
curl -X POST "https://hls.wangqifei.eu.org/m3u" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://p.bvvvvvvv7f.com/video/heigediyiji/第01集/index.m3u8",
    "headers": {"Referer": "https://example.com/"}
  }'
```

### 请求头行为

| 场景 | 实际发往上游的 Referer |
| :--- | :--- |
| 用户传 `&referer=xxx` | `xxx`（用户指定） |
| 用户不传 Referer | **自动用 m3u 地址的 `scheme://host/`** |
| 需要不带 Referer | 传 `&referer=`（空值）会覆盖为 `""`，需配合代码调整 |

---

## 七、测试

### 7.1 一键检查

保存到 `/tmp/check.sh`：

```bash
#!/bin/bash
BASE="http://127.0.0.1:50001"
M3U="https%3A%2F%2Fp.bvvvvvvv7f.com%2Fvideo%2Fheigediyiji%2F%E7%AC%AC01%E9%9B%86%2Findex.m3u8"

echo "=== 1. health ==="
curl -s --noproxy '*' "$BASE/health"; echo

echo "=== 2. m3u 状态 ==="
curl -s --noproxy '*' -o /tmp/clean.m3u -w "HTTP %{http_code}, %{size_download} bytes\n" \
  "$BASE/m3u?url=$M3U"

echo "=== 3. 分片是否纯 ASCII ==="
grep -E "^https?://.*000000[0-2]\.ts" /tmp/clean.m3u | head -3

echo "=== 4. 标签 URI 重写 ==="
grep -E "URI=" /tmp/clean.m3u | head -5
echo "(空 = 源无 KEY/MAP，正常)"

echo "=== 5. 广告残留（新版应全为 0） ==="
echo "ppvod: $(grep -c ppvod-ad-injected /tmp/clean.m3u)"
echo "20261029: $(grep -c /20261029/ /tmp/clean.m3u)"
echo "DISCONTINUITY: $(grep -c EXT-X-DISCONTINUITY /tmp/clean.m3u)"

echo "=== 6. 结构 ==="
head -1 /tmp/clean.m3u
tail -1 /tmp/clean.m3u
echo "EXTINF 分片数: $(grep -c '#EXTINF' /tmp/clean.m3u)"
```

### 7.2 性能测试

```bash
URL="http://127.0.0.1:50001/m3u?url=https%3A%2F%2Fp.bvvvvvvv7f.com%2Fvideo%2Fheigediyiji%2F%E7%AC%AC01%E9%9B%86%2Findex.m3u8"

for i in 1 2 3; do
  curl -s --noproxy '*' -o /dev/null -w \
    "第${i}次: DNS=%{time_namelookup}s 连接=%{time_connect}s 首字节=%{time_starttransfer}s 总计=%{time_total}s\n" \
    "$URL"
done
```

**实测参考（2026-11-16）**：

| 指标 | 实测值 | 说明 |
| :--- | :--- | :--- |
| DNS / 连接 | ~0s | 本地回环 |
| **首字节** | **0.93 ~ 2.01s** | **上游源站拉取耗时，这是瓶颈** |
| 总计 | ≈ 首字节 | **服务端处理耗时接近 0** |

**结论**：`server.py` 处理 1600+ 分片的 CPU 开销是毫秒级的。整体耗时几乎完全来自上游源站网络响应。优化方向是给上游加缓存或换源，**不是本地代码问题**。

### 7.3 浏览器播放验证

1. 用**无痕窗口**或 `Cmd+Shift+R` 强刷
2. 打开：`https://hls.wangqifei.eu.org/m3u?url=...`
3. DevTools → Network → 过滤 `.ts`
4. 检查分片请求的 **path**：
   - ✅ `/video/heigediyiji/%E7%AC%AC01%E9%9B%86/0000007.ts`，状态 **200**
   - ❌ 有 `%C3%A7%C2%AC%C2%AC` → 代码没生效或浏览器有缓存
   - ❌ path 正确但 404 → 源站问题

### 7.4 Master m3u8 测试

如果你有 master m3u8 源，验证子清单重写：

```bash
# 拉取 master，应看到子清单是绝对地址且 master 没有被去广告处理
curl -s --noproxy '*' "$BASE/m3u?url=<master_m3u8>" | grep -E "EXT-X-STREAM-INF|https://"
```

期望：`#EXT-X-STREAM-INF` 后面的子清单行是 `https://...` 绝对地址。

---

## 八、调试

### 8.1 分步骤定位故障

```bash
# 1. 本地服务是否存活
curl --noproxy '*' http://127.0.0.1:50001/health

# 2. 端口是否监听
ss -tlnp 2>/dev/null | grep 50001

# 3. cloudflared 是否连上边缘
pm2 logs cloudflared-tunnel --lines 30 --nostream | grep "Registered tunnel"

# 4. 隧道是否注册了活跃连接
cloudflared tunnel info stremio-tunnel | grep -A5 CONNECTOR

# 5. 外部域名是否可达
curl -v https://hls.wangqifei.eu.org/health

# 6. DNS 是否解析正确
dig @1.1.1.1 hls.wangqifei.eu.org
```

### 8.2 常见问题

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| `SSL_ERROR_SYSCALL` | server.py 没跑 / 本地网络到 CF 边缘被干扰 | 先 curl 127.0.0.1 确认服务；再换热点测试 |
| `Could not resolve host` | DNS 问题 | `dig @1.1.1.1` 确认；Cloudflare 检查 CNAME |
| `.ts` 404 且 path 含 `%C3%A7...` | 双重编码，旧代码或缓存 | 强刷 / 无痕窗口 |
| `.ts` 404 且 path 正确 | 源站失效 | `curl -I` 源站分片地址确认 |
| 上游 403 / 拿不到 m3u | 源站校验 UA/Referer | 用 `&ua=` / `&referer=` 显式传 |
| pm2 日志空 | cloudflared 用 stderr | `pm2 logs cloudflared-tunnel --nostream` |
| `pkill cloudflared` 后又出现 | pm2 自动重启（正常） | 用 `pm2 stop` 而不是 pkill |

### 8.3 上游拉取耗时拆解

在 `server.py` 的 `_handle_m3u` 里临时加计时（不需要可去掉）：

```python
import time
t0 = time.perf_counter()
up_status, content, up_headers = fetch_m3u(target, user_headers)
t_fetch = time.perf_counter()
content = process_m3u(content, target)
t_proc = time.perf_counter()
sys.stderr.write(f"[timing] 上游={(t_fetch-t0)*1000:.0f}ms 处理={(t_proc-t_fetch)*1000:.1f}ms\n")
```

**典型输出**：

```
[timing] 上游=1832ms 处理=12.7ms
```

- 上游 >> 处理 → 瓶颈在上游网络，代码没问题
- 处理 > 500ms → 检查分片数、正则性能

---

## 九、保活与自动重启

### 9.1 当前保活状态

| 组件 | 管理方式 | 崩溃自动重启 | 容器重启后自动恢复 |
| :--- | :--- | :--- | :--- |
| **server.py** | tmux / pm2 | ❌ tmux / ✅ pm2 | ❌ |
| **cloudflared** | pm2 | ✅ | ❌（需 `pm2 resurrect`） |

### 9.2 推荐：全部交给 pm2

```bash
# 停 tmux 里的 server.py
tmux attach -t hls    # Ctrl+C
tmux kill-session -t hls

# pm2 启动
pm2 start /personal/hls-proxy/server.py \
  --name hls-clean \
  --interpreter python3 \
  --cwd /personal/hls-proxy

pm2 save

pm2 list
# 期望两个进程都是 online，↺ 稳定
```

### 9.3 容器重启后恢复

Bohrium 容器**没有 systemd**，pm2 守护进程不会自动启动。容器重启后需要：

```bash
pm2 resurrect
```

**自动化方案**（Bohrium 平台恢复登录后在控制台配置）：

启动命令填：`bash -c "pm2 resurrect && tail -f /dev/null"`

### 9.4 防休眠看门狗（可选）

```bash
cat > /personal/hls-proxy/watchdog.sh <<'EOF'
#!/bin/bash
while true; do
    date +%s > /personal/hls-proxy/.keepalive
    if ! pgrep -f "PM2.*God Daemon" > /dev/null 2>&1; then
        pm2 resurrect 2>/dev/null || true
    fi
    sleep 60
done
EOF
chmod +x /personal/hls-proxy/watchdog.sh
nohup /personal/hls-proxy/watchdog.sh > /dev/null 2>&1 &
```

不解决容器重启，只防止"容器活着但 pm2 挂了"。

---

## 十、待办清单

- [ ] **项目重命名**：`/personal/hls-proxy` → `/personal/hls-clean`（同步更新 pm2 的 `--cwd` 和本 README 路径）
- [ ] **server.py 迁入 pm2**：从 tmux 迁到 pm2，实现崩溃自动重启
- [ ] **配置容器启动脚本**：Bohrium 平台恢复后设置 `bash -c "pm2 resurrect && tail -f /dev/null"`
- [ ] **（可选）cloudflared 切 HTTP/2**：国内 UDP 干扰较多
  ```bash
  pm2 delete cloudflared-tunnel
  pm2 start /usr/local/bin/cloudflared --name cloudflared-tunnel -- tunnel --protocol http2 run stremio-tunnel
  pm2 save
  ```
- [ ] **（可选）移除旧域名**：确认 `hls.wangqifei.eu.org` 稳定后，从 `config.yml` 删掉 `stremio.wangqifei.eu.org` 那段

---

## 十一、代码位置速查

| 功能 | 函数 |
| :--- | :--- |
| 请求头合并 + Referer 兜底 | `build_upstream_headers()` |
| URL path 百分号编码 | `encode_url_path()` / `rewrite_uri()` |
| 拉取上游 m3u | `fetch_m3u()` |
| Master 检测 | `is_master_playlist()` |
| 安全跳过 | `should_skip()` |
| 去广告主逻辑 | `filter_ads()` |
| 块级解析 | `parse_blocks()` |
| 标签内 URI 属性重写 | `rewrite_tag_uris()` |
| 全量 URI 重写 | `rewrite_all_uris()` |
| M3U 处理总入口 | `process_m3u()` |
| HTTP 路由 | `Handler.do_GET()` / `Handler.do_POST()` |

**可调参数**（文件顶部）：

```python
SHORT_RUN_MIN   = 3       # 连续短分片最小个数
SHORT_RATIO     = 0.5     # 短分片阈值系数
SHORT_ABS_MAX   = 4.0     # 短分片绝对上限（秒）
REPEAT_MIN      = 2       # 重复 URI 最小出现次数
PATH_SHARE_MAX  = 0.34    # 弱路径占比上限
MODE_SHARE_MIN  = 0.95    # 时长众数占比下限
```

---

## 十二、更新日志

| 日期 | 变更 |
| :--- | :--- |
| 2026-11-15 | 初始部署，域名 `stremio.wangqifei.eu.org`，Tunnel `stremio-tunnel` |
| 2026-11-16 | 新增域名 `hls.wangqifei.eu.org`；分片 URL 改为纯 ASCII 编码，修复浏览器双重编码 404 |
| 2026-11-16 | 加固：Master m3u8 跳过去广告（避免误删子清单）；全量 URI 重写（含标签内 KEY/MAP/MEDIA）；Referer 自动兜底；UTF-8 BOM 清理 |
```

## 四、部署与验证命令

```bash
# 1. 用上面的 server.py 覆盖当前文件
cd /personal/hls-proxy
# 保存 server.py 后：
python3 -m py_compile server.py && echo "语法 OK"

# 2. 重启服务
pm2 restart hls-clean 2>/dev/null || {
  # 如果还没迁到 pm2，先停 tmux 里的
  tmux attach -t hls  # Ctrl+C
  python3 server.py &
}

# 3. 跑一键检查，确认 DISCONTINUITY 变 0
/tmp/check.sh

# 4. Master m3u8 测试（如果有 master 源）
curl -s --noproxy '*' "http://127.0.0.1:50001/m3u?url=<master_m3u8>" | grep -E "STREAM-INF|^https://" | head -5
