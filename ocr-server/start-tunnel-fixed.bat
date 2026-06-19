@echo off
echo === 用 Tailscale Funnel 給本機 8000 一個固定 https 網址 ===
echo (需先安裝 Tailscale 並登入;Funnel 第一次用需在後台啟用,指令會給連結)
echo.
tailscale funnel --bg 8000
echo.
echo === 你的固定網址(把下面 https://... 後面加 /ocr 填進 App)===
tailscale funnel status
echo.
pause
