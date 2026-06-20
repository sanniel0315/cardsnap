@echo off
cd /d %~dp0
chcp 65001 >nul
set "DIR=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

REM 移除可能裝壞的 cloudflared 服務(需系統管理員;非管理員會略過)
cloudflared service uninstall >nul 2>^&1

REM 1) OCR 伺服器(隱藏背景)
> "%STARTUP%\CardSnapOCR.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%STARTUP%\CardSnapOCR.vbs" echo sh.CurrentDirectory = "%DIR%"
>> "%STARTUP%\CardSnapOCR.vbs" echo sh.Run "cmd /c run.bat", 0, False

REM 2) 固定 Tunnel(隱藏背景)
> "%STARTUP%\CardSnapTunnel.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%STARTUP%\CardSnapTunnel.vbs" echo sh.Run "cmd /c cloudflared tunnel run cardsnap-ocr", 0, False

echo [OK] 已設定開機(登入)自動啟動:OCR 伺服器 + 固定 Tunnel
echo      ocr.name-car-box.com -^> 本機 8765
echo.
echo 現在立即啟動一次(背景)...
start "" /min cmd /c run.bat
timeout /t 4 >nul
start "" /min cmd /c cloudflared tunnel run cardsnap-ocr
echo 完成!以後登入就自動啟動,不用手動開視窗。
pause
