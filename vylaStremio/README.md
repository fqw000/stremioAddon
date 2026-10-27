
# 🎬 Vyla Multi-Source Stremio Addon

基于 **Vyla SDK** 和 **Express** 构建的高性能 Stremio 影视聚合插件。支持 20+ 流媒体源并发解析、动态剔除失效流、智能过滤 IP 绑定链接，并提供完美的中英文字幕匹配方案。

## ✨ 核心特性

- **🚀 多源聚合**：并发请求数十个优质流媒体源（基于 Vyla SDK），自动去重，最大化可用性。
- **🛡️ 智能流校验**：解析后实际发送 HTTP 请求测试流可用性，剔除挂羊头卖狗肉的“死链”。
- **🌐 IP 绑定剔除**：自动识别并过滤 URL 中带有 IPv4/IPv6 字面量参数的链接（这类链接通常与请求端 IP 绑定，跨设备/局域网播放必现 403）。
- **💬 中英字幕优化**：聚合 OpenSubtitles、Vidzee、Trybox 等多方字幕 API。支持“仅中文”、“仅英文”或“中英双语”，每种语言保留多条优质选项。
- **🎨 可视化配置台**：提供精美的响应式配置页面 (`/configure`)，所有改动（源开关、字幕偏好）实时生成专属安装链接。

## 🛠️ 本地运行与测试

### 1. 环境要求
- Node.js >= 18.0 (推荐 20+)
- 确保 `public/favicon.ico` 存在（用于配置页 Logo）

### 2. 安装与启动
```bash
# 安装依赖
npm install

# 启动服务
npm start
```

服务启动后，访问 `http://127.0.0.1:7001/configure` 即可进入配置页面。

### 3. 安装到 Stremio
在配置页调整好选项后，点击底部的 **“安装到 Stremio”**，或者点击 **“复制链接”** 并手动粘贴到 Stremio 的 **Addons -> Developer** 输入框中。

---

## ☁️ 部署到 Render (免费方案)

本项目专为在 Render 免费套餐上稳定运行做了优化。

1. 将代码推送到你的 GitHub 仓库。
2. 在 [Render](https://render.com/) 控制台点击 **New -> Web Service**，连接你的仓库。
3. 配置如下：
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
4. 点击部署。Render 会自动注入 `PORT` 环境变量。

*(注：由于使用了 `Vyla SDK`，首次请求时可能会下载约 11MB 的 TLS 指纹库，此时冷启动会比较慢，请耐心等待。后续请求会非常迅速。)*

---

## 🔄 保活机制 (防休眠)

Render 免费版如果 15 分钟无流量会进入休眠。本项目提供了 **双重保活方案**，确保全天候秒开。

### 方案一：GitHub Actions (自带失败 Bark 通知)
在仓库中创建 `.github/workflows/keep-alive.yml`：
```yaml
name: Keep Addon Alive
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Addon URL
        env:
          TARGET_URL: ${{ secrets.ADDON_URL }}
          BARK_KEY: ${{ secrets.BARK_KEY }}
        run: |
          HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 60 "$TARGET_URL")
          if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 400 ]; then
            echo "✅ 保活请求成功"
          else
            echo "⚠️ 请求异常: $HTTP_STATUS"
            if [ -n "$BARK_KEY" ]; then
              TITLE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('Vyla Addon 保活失败'))")
              BODY=$(python3 -c "import urllib.parse; print(urllib.parse.quote('状态码: $HTTP_STATUS\nURL: $TARGET_URL'))")
              curl -s -m 10 "https://api.day.app/$BARK_KEY/$TITLE/$BODY?group=vyla-addon&level=timeSensitive" > /dev/null
            fi
            exit 1
          fi
```
**配置 Secrets**：前往 GitHub 仓库的 **Settings -> Secrets and variables -> Actions**，添加：
- `ADDON_URL`: 你的 Render 域名 (如 `https://vyla-addon.onrender.com`)
- `BARK_KEY`: (可选) 你的 Bark Key，用于接收失败告警。

### 方案二：cron-job.org (高精度保活)
1. 注册并登录 [cron-job.org](https://console.cron-job.org/dashboard)。
2. 创建任务，URL 填入你的 Render 域名。
3. 执行频率设置为 **Every 10 minutes**。
4. **高级设置**：将 Timeout 设为 **60 秒**（应对冷启动），并勾选失败邮件通知。
5. 保存即可。

---

## ⚙️ 架构与目录说明

```text
├── addon.js                # Express 主入口，路由管理与 CORS
├── src/
│   ├── configure.js        # 可视化配置页生成逻辑
│   ├── ids.js              # Stremio IMDb ID 转 TMDB ID (Cinemeta)
│   ├── resolver.js         # Vyla SDK 封装、多源并发、流测试、IP 剔除
│   ├── sources.js          # 直连源与代理源的静态配置
│   └── subtitles.js        # 中英字幕拉取与聚合
├── public/
│   └── favicon.ico         # 配置页 Logo
└── .github/workflows/      # GitHub Actions 保活脚本
```

---

## ⚠️ 免责声明

本项目仅供 **学习、研究和交流 Stremio Addon 开发技术** 使用。所有数据均来自于第三方公开 API (Vyla SDK, OpenSubtitles 等)，本项目本身不存储、不托管、不分发任何影视资源文件。请勿将本项目用于商业用途，由使用本项目产生的一切法律风险及连带责任由使用者自行承担。