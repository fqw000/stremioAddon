#!/bin/bash

#  token的实际消费流程
# 请求到达
#   │
#   ├─ 1. 内存缓存 → access 有效？
#   │    ├─ 是 → 直接用
#   │    └─ 否 → 往下
#   │
#   ├─ 2. 用户配置的 access_token → 有效？
#   │    ├─ 是 → 缓存到内存 + 用
#   │    └─ 否 → 往下
#   │
#   ├─ 3. 读 Redis → access 有效？
#   │    ├─ 是 → 缓存到内存 + 用
#   │    └─ 否 → 往下
#   │
#   ├─ 4. 用 refresh_token 刷新 Supabase
#   │    ├─ 成功 → 写内存 + 写 Redis + 用
#   │    └─ 失败 → 往下
#   │
#   ├─ 5. 用旧 access_token 刷新（降级）
#   │    ├─ 成功 → 写内存 + 写 Redis + 用
#   │    └─ 失败 → 往下
#   │
#   └─ 6. Bark 告警 → 返回空 token → 触发诊断 stream

#  已经增加更新本地env token支持
# 读取环境变量
set -a
source .env.local

# 变量硬编码
# UPSTASH_REDIS_REST_URL="https://********.upstash.io"
# UPSTASH_REDIS_REST_TOKEN="gQAA*******5Nw"
# APP_PREFIX="tryboxStream:dev"
# SUPABASE_ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWNoY3V3emJuY3VxbnFodXVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTg4MjUsImV4cCI6MjA5OTk3NDgyNX0.v0KsTzaaiHUTvtA_W-HuAOQul3E7cxnbw4Kiy9hFVus"

echo "=== 1. 从 Redis 读 token ==="
READ_RESULT=$(curl -s "$UPSTASH_REDIS_REST_URL/pipeline" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[
    [\"GET\",\"$APP_PREFIX:token:refresh\"]
  ]")
  
  # 如果想加第二条，改成：
# COMMANDS='[
#   ["GET","'"$APP_PREFIX"':token:refresh"],
#   ["GET","'"$APP_PREFIX"':token:access"]
# ]'

# echo "$READ_RESULT"
# # [{"result":"iicq3i52aqlw"}]

REFRESH=$(echo "$READ_RESULT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
v = d[0]['result']
if v is None:
    print('')
else:
    try:
        print(json.loads(v))
    except:
        print(v)
")
# echo "$REFRESH"

if [ -z "$READ_RESULT" ]; then
  echo "❌ Redis 中没有 refresh_token"
  exit 1
fi

echo ""


echo "=== 2. 用 refresh_token 刷新 access_token ==="
RESP=$(curl -s -X POST "https://saichcuwzbncuqnqhuul.supabase.co/auth/v1/token?grant_type=refresh_token" \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON" \
  -d "{\"refresh_token\":\"$REFRESH\"}")

# echo "$RESP" | python3 -m json.tool

# 3. 提取新的 token
NEW_ACCESS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
NEW_REFRESH=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)

if [ -z "$NEW_ACCESS" ]; then
  echo "❌ 刷新失败"
  exit 1
fi

echo ""
echo "=== 新 access_token（前 60 字符）==="
echo "${NEW_ACCESS:0:60}..."
echo ""
echo "=== 新 refresh_token ==="
echo "$NEW_REFRESH"


echo "=== 4. 更新 Redis token ==="
# 更新到.env.local
awk -v ac="$NEW_ACCESS" -v re="$REFRESH" '
  /^ACCESS_TOKEN=/  { print "ACCESS_TOKEN=\"" ac"\""}
  /^REFRESH_TOKEN=/ { print "REFRESH_TOKEN=\"" re"\""; next }
  { print }
' .env.local > .env.local.tmp && mv .env.local.tmp .env.local

echo "推送到.env.local"

echo ""
echo "=== 4. 更新 Redis token ==="

NEW_ACCESS="$NEW_ACCESS"
NEW_REFRESH="$NEW_REFRESH"
# NEW_REFRESH="pykn3upaahhn"
WRITE_RESULT=$(curl -s "$UPSTASH_REDIS_REST_URL/pipeline" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[
    [\"SET\",\"$APP_PREFIX:token:refresh\",\"$NEW_REFRESH\"],
    [\"SET\",\"$APP_PREFIX:token:access\",\"$NEW_ACCESS\"]
  ]")

echo "$WRITE_RESULT, Redis token 更新成功。"

