#!/bin/bash
while true; do
    date +%s > /personal/hls-proxy/.keepalive
    # 检查 pm2 是否存活，不存活则尝试 resurrect
    if ! pgrep -f "PM2.*God Daemon" > /dev/null 2>&1; then
        pm2 resurrect 2>/dev/null || true
    fi
    sleep 60
done
