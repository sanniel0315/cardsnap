@echo off
chcp 65001 >nul
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del "%STARTUP%\CardSnapOCR.vbs" 2>nul
del "%STARTUP%\CardSnapTunnel.vbs" 2>nul
echo [OK] 已移除開機自動啟動(OCR + Tunnel)。
pause
