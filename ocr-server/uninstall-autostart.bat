@echo off
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del "%STARTUP%\CardSnapOCR.vbs" 2>nul
echo [OK] 已移除開機自動啟動。可關閉此視窗。
pause
