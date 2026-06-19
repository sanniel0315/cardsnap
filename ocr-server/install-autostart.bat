@echo off
cd /d %~dp0
set "DIR=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\CardSnapOCR.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%STARTUP%\CardSnapOCR.vbs" echo sh.CurrentDirectory = "%DIR%"
>> "%STARTUP%\CardSnapOCR.vbs" echo sh.Run "cmd /c run.bat", 0, False
echo.
echo [OK] 已設定「開機自動啟動 OCR 伺服器」
echo      啟動器: %STARTUP%\CardSnapOCR.vbs
echo.
echo 現在立即啟動一次(背景)...
start "" /min cmd /c run.bat
echo 完成。可關閉此視窗。
pause
