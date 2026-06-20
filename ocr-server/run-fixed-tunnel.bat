@echo off
chcp 65001 >nul
REM 前景執行固定 tunnel(ocr.name-car-box.com)
cloudflared tunnel run cardsnap-ocr
pause
