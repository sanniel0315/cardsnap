#!/usr/bin/env bash
# CardSnap → GitHub 一鍵推送 (Mac / Linux / Windows Git Bash)
# 用法:  bash setup-github.sh https://github.com/<你的帳號>/cardsnap.git
set -e

REPO_URL="$1"
if [ -z "$REPO_URL" ]; then
  echo "請提供 GitHub repo 網址,例如:"
  echo "  bash setup-github.sh https://github.com/你的帳號/cardsnap.git"
  exit 1
fi

# 清掉本機器上可能殘留的損壞 git 資料夾
rm -rf .git .git_broken 2>/dev/null || true

git init
git add -A
git commit -m "feat: CardSnap web MVP — 拍照 OCR 名片整理 PWA"
git branch -M main
git remote add origin "$REPO_URL"
git push -u origin main

echo ""
echo "✅ 已推送到 $REPO_URL"
echo "下一步:到 GitHub repo → Settings → Pages → Source 選『GitHub Actions』,即自動部署。"
