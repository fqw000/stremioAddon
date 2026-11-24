#!/bin/bash
BASE="http://127.0.0.1:50001"
TMPDIR=$(mktemp -d -t hlsregress.XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

# 汇总计数器
TOTAL=0
OK=0
FAIL=0
HTTP_4XX=0
HTTP_5XX=0
MASTER_PLAYLIST=0
LIVE_NO_ENDLIST=0
HAS_REMOVED_AD=0
SEG_CHANGE=0
ERR_LIST=()

run_case() {
    local M3U="$1"
    TOTAL=$((TOTAL + 1))
    local CASE_ID="$TOTAL"
    local OUT_RAW="$TMPDIR/case_${CASE_ID}_raw.json"
    local OUT_M3U="$TMPDIR/case_${CASE_ID}.m3u8"

    echo -e "\n================== [$CASE_ID] $M3U ================="

    # 1. health check
    echo "=== health ==="
    curl -s --connect-timeout 5 --max-time 8 --noproxy '*' "$BASE/health"; echo

    # 2. 请求带 json=1，拿到 report 结构化数据
    echo "=== m3u fetch & filter report ==="
    HTTP_CODE=$(curl -s --connect-timeout 5 --max-time 12 --noproxy '*' \
        -o "$OUT_RAW" -w "%{http_code}" \
        "$BASE/hls?url=${M3U}&json=1")

    echo "HTTP $HTTP_CODE"
    if [[ $HTTP_CODE -ge 400 ]]; then
        FAIL=$((FAIL + 1))
        if [[ $HTTP_CODE -ge 400 && $HTTP_CODE -lt 500 ]]; then
            HTTP_4XX=$((HTTP_4XX + 1))
        else
            HTTP_5XX=$((HTTP_5XX + 1))
        fi
        ERR_LIST+=("[$CASE_ID] HTTP $HTTP_CODE $M3U")
        return
    fi

    # 取出 m3u 正文保存
    jq -r '.content' "$OUT_RAW" > "$OUT_M3U"
    OK=$((OK + 1))

    # 从 report 读取指标（直接复用 python AdFilter 的 report）
    local VERDICT=$(jq -r '.report.verdict' "$OUT_RAW")
    local IS_MASTER=$(jq -r '.report.parse.master' "$OUT_RAW")
    local SEG_ORIG=$(jq -r '.report.parse.segments' "$OUT_RAW")
    local REMOVED_CNT=$(jq -r '.report.summary.removedCount' "$OUT_RAW")
    local GATE=$(jq -r '.report.gate // "-"' "$OUT_RAW")

    echo "verdict: $VERDICT | gate: $GATE"
    echo "original segments: $SEG_ORIG | removed ad segs: $REMOVED_CNT"

    if [[ "$IS_MASTER" == "true" ]]; then
        MASTER_PLAYLIST=$((MASTER_PLAYLIST + 1))
    fi
    if [[ "$GATE" == "live-or-event(no-ENDLIST)" ]]; then
        LIVE_NO_ENDLIST=$((LIVE_NO_ENDLIST + 1))
    fi
    if [[ "$REMOVED_CNT" -gt 0 ]]; then
        HAS_REMOVED_AD=$((HAS_REMOVED_AD + 1))
    fi
    local SEG_NEW=$(grep -c '#EXTINF' "$OUT_M3U")
    if [[ "$SEG_NEW" -ne "$SEG_ORIG" ]]; then
        SEG_CHANGE=$((SEG_CHANGE + 1))
    fi

    echo "=== 分片URI（检查绝对地址、中文编码） ==="
    grep -E "^https?://" "$OUT_M3U" | head -3

    echo "=== URI= 标签重写（KEY/MAP） ==="
    grep -E "URI=" "$OUT_M3U" | head -5
    echo "(空 = 源无KEY/MAP，正常)"

    echo "=== 广告特征残留检查 ==="
    echo "ppvod-ad-injected: $(grep -c ppvod-ad-injected "$OUT_M3U")"
    echo "/20261029/: $(grep -c /20261029/ "$OUT_M3U")"

    echo "=== 结构校验 ==="
    echo "首行: $(head -1 "$OUT_M3U")"
    echo "尾行: $(tail -1 "$OUT_M3U")"
    echo "EXTINF 计数: $SEG_NEW"
    echo "DISCONTINUITY: $(grep -c EXT-X-DISCONTINUITY "$OUT_M3U")"
}

# 主循环
while read -r M3U; do
    [[ -z "$M3U" ]] && continue
    [[ "$M3U" =~ ^# ]] && continue
    run_case "$M3U"
done <<EOF
# 测试样本
https%3A%2F%2Fp.bvvvvvvv7f.com%2Fvideo%2Fheigediyiji%2F%E7%AC%AC01%E9%9B%86%2Findex.m3u8
https://hn.bfvvs.com/play/bkRwmXEa/index.m3u8
https://vip.lz-cdn13.com/20220725/11652_a547dff8/index.m3u8
https://vip.lzcdn2.com/20220622/13434_23161577/1200k/hls/mixed.m3u8
https://vip1.lz-cdn5.com/20220503/13930_52a190a4/1200k/hls/mixed.m3u8
https://bfikuncdn.com/20261116/ZNUBEUwL/index.m3u8
https://c1.ddbbffcdn.com/video/xieshenyuchuerbingshaonv/%E7%AC%AC01%E9%9B%86/index.m3u8
https://c1.rrcdnbf6.com/video/guaidanxiaozhendierji/%E7%AC%AC01%E9%9B%86/index.m3u8
https://hd.kuktxu.com/play/elY8pp6a/index.m3u8
https://hn.bfvvs.com/play/bkRwmXEa/index.m3u8
https://p.b8bf.com/video/caifengdejueze/HD/index.m3u8
https://p.bvvvvvvvvv1f.com/video/yizhoubusiquanetuikuan/HD%E4%B8%AD%E5%AD%97/index.m3u8
https://play.hhuus.com/play/bo2vqX3a/index.m3u8
https://play.modujx17.com/20261116/2YEnFAQY/index.m3u8
https://play.xluuss.com/play/dPN6Mrna/index.m3u8
https://player.yzzyvip-35.com/20261117/20779_ce003cad/index.m3u8
https://super.ffzy-online6.com/20261115/45684_3ecf7005/index.m3u8
https://svip.ryiplay18.com/20261115/16348_4a24ec45/index.m3u8
https://svip.xgplay17.com/2026-11-16/47671_DV14HhYAH6cwiw4qBu/index.m3u8
https://v.fengbao14.com/video/zoumashangren/9ab68d70fe8d/index.m3u8
https://v.lfthirtytwo.com/20260305/2399_7b280000/index.m3u8
https://v.lzcdn27.com/20261116/22107_065882b3/index.m3u8
https://v.qq.com/x/cover/mzc00200zsqz54y/l4102dh0nce.html
https://v13.zuidazym3u8.com/yyv13/202611/16/yMta6gH3TV27/video/index.m3u8
https://v3.ppqrrs.com/wjv3/202611/16/Ncg3Rh4G4g93/video/index.m3u8
https://vip.dytt-kan.com/20261115/15022_86b83f4a/index.m3u8
https://vip.lz-cdn3.com/20220725/10028_d2f1cf38/index.m3u8
https://vod1.maowushi.com/20261102/D6q9USVv/index.m3u8
https://vv.jisuzyv.com/play/eVOJ5l1a/index.m3u8
https://vv.jisuzyv.com/play/epY9zQNa/index.m3u8
https://p.b8bf.com/video/caifengdejueze/HD/index.m3u8
EOF

# ========== 汇总输出 ==========
echo -e "\n\n========================================"
echo "               回归测试汇总报告"
echo "========================================"
echo "总用例:            $TOTAL"
echo "成功:              $OK"
echo "失败:              $FAIL"
echo "HTTP 4xx:          $HTTP_4XX"
echo "HTTP 5xx:          $HTTP_5XX"
echo "Master主清单:      $MASTER_PLAYLIST"
echo "Live无ENDLIST:     $LIVE_NO_ENDLIST"
echo "成功剔除广告:      $HAS_REMOVED_AD"
echo "分片数量发生变化:  $SEG_CHANGE"
echo "----------------------------------------"
if [[ ${#ERR_LIST[@]} -gt 0 ]]; then
    echo "失败清单:"
    for line in "${ERR_LIST[@]}"; do
        echo "  $line"
    done
else
    echo "✅ 无失败用例"
fi
echo "========================================"


# https://hn.bfvvs.com/play/bkRwmXEa/index.m3u8