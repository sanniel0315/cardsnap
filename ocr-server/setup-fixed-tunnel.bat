@echo off
chcp 65001 >nul
REM === CardSnap 地端 OCR 固定網址一鍵設定 ===
REM 把 ocr.name-car-box.com 永久指向本機 OCR 伺服器(port 8765)
setlocal
set TUNNEL=cardsnap-ocr
set HOSTN=ocr.name-car-box.com
set PORT=8765

echo [1/5] 登入 Cloudflare(瀏覽器會打開,請選 name-car-box.com 授權)
cloudflared tunnel login
if errorlevel 1 goto err

echo [2/5] 建立具名 tunnel: %TUNNEL%
cloudflared tunnel create %TUNNEL%

echo [3/5] 綁定 DNS %HOSTN% -^> %TUNNEL%
cloudflared tunnel route dns %TUNNEL% %HOSTN%

echo [4/5] 寫入設定檔 %USERPROFILE%\.cloudflared\config.yml
> "%USERPROFILE%\.cloudflared\config.yml" (
  echo tunnel: %TUNNEL%
  echo ingress:
  echo   - hostname: %HOSTN%
  echo     service: http://localhost:%PORT%
  echo   - service: http_status:404
)

echo [5/5] 安裝為開機自動服務
cloudflared service install

echo.
echo ✅ 完成!ocr.name-car-box.com 已綁到本機 %PORT%。
echo 確認 OCR 伺服器(run.bat)有在跑即可。
goto end
:err
echo ❌ 登入失敗,請重跑。
:end
pause
