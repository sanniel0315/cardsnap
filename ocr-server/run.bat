@echo off
cd /d %~dp0
if "%OCR_PORT%"=="" set OCR_PORT=8765
if not exist .venv ( python -m venv .venv )
call .venv\Scripts\activate
if not exist .venv\.deps_ok (
  python -m pip install --upgrade pip >nul
  pip install -r requirements.txt && type nul > .venv\.deps_ok
)
rem uvicorn 的輸出一律導到檔案,不要留在主控台。排程是 InteractiveToken,會開出真的
rem console 視窗;一旦有人在視窗裡選取文字(QuickEdit)或緩衝區沒人讀,寫入就會永久
rem 阻塞,整個行程凍住 —— port 還 LISTEN、連線收得進來卻永遠不回應。2026-08-06 掛掉
rem 兩小時就是這個原因。
set LOGDIR=%LOCALAPPDATA%\cardsnap
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOGFILE=%LOGDIR%\ocr-server.log
if exist "%LOGFILE%" for %%A in ("%LOGFILE%") do if %%~zA GTR 5000000 move /y "%LOGFILE%" "%LOGFILE%.1" >nul

echo === CardSnap 本機 OCR 伺服器 http://localhost:%OCR_PORT%(日誌:%LOGFILE%) ===
python -m uvicorn server:app --host 0.0.0.0 --port %OCR_PORT% >>"%LOGFILE%" 2>&1
