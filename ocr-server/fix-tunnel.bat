@echo off
chcp 65001 >nul
cd /d %~dp0
REM === CardSnap OCR 通道一鍵修復 ===
REM 修正兩個問題:
REM   1) config.yml 用 localhost -> Windows 解析成 IPv6 ::1,但 server 綁 IPv4 -> actively refused
REM   2) service + 排程 + 手動 可能有多個同名通道 -> 時好時壞(flapping)
REM 請「以系統管理員身分執行」此檔。

echo === CardSnap OCR 通道修復(IPv4 + 去重複 + 乾淨重啟)===
echo.

echo [1/6] 停掉所有 cloudflared 通道(清重複)
taskkill /f /im cloudflared.exe >nul 2>&1
cloudflared service uninstall >nul 2>&1

echo [2/6] 停掉舊的 8765 server(避免占用埠)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo [3/6] 覆寫 config.yml -^> 127.0.0.1(修 IPv6 連不到)
> "%USERPROFILE%\.cloudflared\config.yml" (
  echo tunnel: cardsnap-ocr
  echo ingress:
  echo   - hostname: ocr.name-car-box.com
  echo     service: http://127.0.0.1:8765
  echo   - service: http_status:404
)

echo [4/6] 用工作排程乾淨啟動(單一實例 + 當機自動重啟)
schtasks /end /tn "CardSnap Tunnel" >nul 2>&1
schtasks /end /tn "CardSnap OCR Server" >nul 2>&1
schtasks /run /tn "CardSnap OCR Server"
timeout /t 6 >nul
schtasks /run /tn "CardSnap Tunnel"

echo [5/6] 等 12 秒讓通道連上...
timeout /t 12 >nul

echo [6/6] 本機測試(應回 JSON):
curl -s http://127.0.0.1:8765/
echo.
echo.
echo === 完成 ===
echo 若上面有回 {"ok":true,"model":...},外面 https://ocr.name-car-box.com 就穩了。
echo 之後開機由排程自動起(單一實例);別再手動雙擊 run.bat / 開通道視窗。
pause
