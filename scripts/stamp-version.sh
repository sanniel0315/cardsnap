#!/usr/bin/env bash
# 把 sw.js 的 __BUILD_ID__ 戳成唯一版本號(commit SHA 前 7 碼)
# 來源優先序:第一參數 > Netlify 的 COMMIT_REF > git 短 SHA > 'dev'
set -e
SHA="${1:-${COMMIT_REF:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}}"
SHA="${SHA:0:7}"
sed -i.bak "s/__BUILD_ID__/${SHA}/g" sw.js index.html app.html && rm -f sw.js.bak index.html.bak app.html.bak
echo "Stamped sw.js build id: ${SHA}"
