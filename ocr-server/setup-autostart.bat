@echo off
chcp 65001 >nul
cd /d %~dp0
echo === CardSnap 自動啟動設定(工作排程:登入啟動 + 當機自動重啟)===
REM 移除舊版啟動資料夾捷徑,避免重複
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CardSnapOCR.vbs" 2>nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CardSnapTunnel.vbs" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1"
if errorlevel 1 (echo. ^& echo [X] 失敗,請改用「右鍵→以系統管理員身分執行」此檔。) else (echo. ^& echo [OK] 完成!以後登入即自動啟動,當機會自動重啟。)
echo.
echo 若要「開機未登入也自動跑」:開 netplwiz 設定自動登入(需你的密碼,我不能代設)。
pause
