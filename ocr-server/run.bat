@echo off
cd /d %~dp0
if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate
python -m pip install --upgrade pip >nul
pip install -r requirements.txt
echo.
echo === CardSnap 本機 OCR 伺服器啟動於 http://localhost:8000 ===
echo === 另開一個視窗執行:  cloudflared tunnel --url http://localhost:8000 ===
echo.
python -m uvicorn server:app --host 0.0.0.0 --port 8000
