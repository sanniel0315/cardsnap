@echo off
cd /d %~dp0
if not exist .venv ( python -m venv .venv )
call .venv\Scripts\activate
if not exist .venv\.deps_ok (
  python -m pip install --upgrade pip >nul
  pip install -r requirements.txt && type nul > .venv\.deps_ok
)
echo === CardSnap 本機 OCR 伺服器 http://localhost:8000 ===
python -m uvicorn server:app --host 0.0.0.0 --port 8000
