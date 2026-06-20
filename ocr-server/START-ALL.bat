@echo off
cd /d %~dp0
chcp 65001 >nul
echo === 啟動 CardSnap 地端 OCR + 固定 Tunnel(ocr.name-car-box.com)===
start "CardSnap OCR Server" cmd /k run.bat
timeout /t 4 >nul
start "CardSnap Tunnel" cmd /k cloudflared tunnel run cardsnap-ocr
echo.
echo 已開兩個視窗:Server(:8765)+ 固定 Tunnel(ocr.name-car-box.com)
timeout /t 5 >nul
