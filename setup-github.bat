@echo off
REM CardSnap -> GitHub 一鍵推送 (Windows 命令提示字元)
REM 用法:  setup-github.bat https://github.com/你的帳號/cardsnap.git
setlocal

set "REPO_URL=%~1"
if "%REPO_URL%"=="" (
  echo 請提供 GitHub repo 網址,例如:
  echo   setup-github.bat https://github.com/你的帳號/cardsnap.git
  exit /b 1
)

REM 清掉可能殘留的損壞 git 資料夾
if exist ".git" rmdir /s /q ".git"
if exist ".git_broken" rmdir /s /q ".git_broken"

git init
git add -A
git commit -m "feat: CardSnap web MVP - 拍照 OCR 名片整理 PWA"
git branch -M main
git remote add origin "%REPO_URL%"
git push -u origin main

echo.
echo [OK] 已推送到 %REPO_URL%
echo 下一步:到 GitHub repo -^> Settings -^> Pages -^> Source 選 GitHub Actions,即自動部署。
endlocal
