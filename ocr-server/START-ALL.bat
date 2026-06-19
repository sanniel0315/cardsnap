@echo off
cd /d %~dp0
echo === 啟動 CardSnap 本機 OCR 伺服器 + Cloudflare Tunnel ===
start "CardSnap OCR Server" cmd /k run.bat
timeout /t 4 >nul
start "CardSnap Tunnel" cmd /k cloudflared tunnel --url http://localhost:8765
echo.
echo 已開兩個視窗:Server(:8765)與 Tunnel。
echo 在 Tunnel 視窗找到 https://xxxx.trycloudflare.com,後面加 /ocr 填進 App 設定。
timeout /t 6 >nul
