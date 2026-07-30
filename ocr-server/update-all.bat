@echo off
chcp 65001 >nul
cd /d %~dp0
REM === CardSnap OCR 一鍵更新:git pull + 視覺模型 + 重啟 server ===
REM 在 5090(OCR 機)雙擊即可。建議「以系統管理員身分執行」。

echo === CardSnap OCR 一鍵更新 ===
echo.

echo [1/4] 更新程式(git pull)
cd /d %~dp0..
git pull
cd /d %~dp0
echo.

echo [2/4] 確認/下載視覺模型 qwen2.5vl:32b(已有會很快;第一次約 20GB 較久)
ollama pull qwen2.5vl:32b
echo.

echo [3/4] 重啟 OCR server(釋放 8765 舊程式 -^> 由工作排程重啟)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
schtasks /end /tn "CardSnap OCR Server" >nul 2>&1
schtasks /run /tn "CardSnap OCR Server" >nul 2>&1
echo.

echo [4/4] 等 8 秒後本機測試...
timeout /t 8 >nul
curl -s http://127.0.0.1:8765/
echo.
echo.
echo === 完成 ===
echo 上面回 {"ok":true,...} 代表 server 已重啟。model 欄顯示的是預設(32b);
echo 實際辨識時:32b 有下載就用 32b,否則自動退回 7b。
echo.
echo 若「外面」 https://ocr.name-car-box.com 連不到(通道問題),請改跑 fix-tunnel.bat。
pause
