"""
CardSnap 本機 GPU OCR 伺服器
  - 接收 App 傳來的名片影像(base64 JPEG)
  - 呼叫本機 Ollama 的視覺模型(預設 qwen2.5vl:7b)做 OCR + 結構化抽取
  - 回傳 { text, fields }  fields = {name, company, title, phones[], email, website, address, fax, taxId, note}

啟動:  run.bat   (或  python -m uvicorn server:app --host 0.0.0.0 --port 8000)
需求:  先安裝 Ollama 並  ollama pull qwen2.5vl:7b
"""
import os, json, base64, re, traceback
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL  = os.environ.get("OCR_MODEL", "qwen2.5vl:7b")

app = FastAPI(title="CardSnap Local OCR")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

PROMPT = (
    "你是名片資訊擷取引擎。請辨識這張名片影像,輸出「繁體中文」的 JSON,只輸出 JSON,不要說明。\n"
    "鍵值固定為:\n"
    '{ "name": 姓名, "company": 公司全名, "title": 職稱, '
    '"phones": [ {"label":"手機 或 市話(二選一)", "value":"號碼"} ], '
    '"email": 電子郵件, "website": 網站, "address": 完整地址, '
    '"fax": 傳真號碼, "taxId": 統一編號(8碼數字), "note": 其他備註, '
    '"raw_text": 名片上所有文字原樣 }\n'
    "找不到的欄位留空字串或空陣列。手機=09或行動電話;市話=含區碼室內電話;傳真號碼只放到 fax 欄不要放進 phones。note 請用單一字串(多項用、分隔),不要用陣列。"
)

def call_ollama(b64: str) -> dict:
    # 用 /api/chat(對視覺模型較穩);不開 format=json(部分版本會 500),改用解析
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT, "images": [b64]}],
        "stream": False,
        "options": {"temperature": 0},
    }
    r = requests.post(f"{OLLAMA}/api/chat", json=body, timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"ollama /api/chat {r.status_code}: {r.text[:400]}")
    data = r.json()
    resp = ((data.get("message") or {}).get("content") or "").strip()
    try:
        return json.loads(resp)
    except Exception:
        m = re.search(r"\{.*\}", resp, re.S)
        if m:
            return json.loads(m.group(0))
        raise RuntimeError("模型輸出非 JSON:" + resp[:300])

def normalize(d: dict) -> dict:
    d = d or {}
    fax = d.get("fax", "") or ""
    phones = []
    for p in (d.get("phones") or []):
        if isinstance(p, str):
            val, lab = p, ""
        elif isinstance(p, dict):
            val = p.get("value") or p.get("number") or ""
            lab = p.get("label") or p.get("type") or ""
        else:
            continue
        if not val:
            continue
        digits = re.sub(r"\D", "", val)
        if "傳真" in lab or "fax" in lab.lower():
            if not fax:
                fax = val
            continue
        if digits.startswith("09") or "手機" in lab or "行動" in lab:
            lab = "手機"
        elif lab not in ("手機", "市話"):
            lab = "市話"
        phones.append({"label": lab, "value": val})

    note = d.get("note", "") or ""
    if isinstance(note, list):
        note = "、".join(str(x) for x in note if x)

    fields = {
        "name": d.get("name", "") or "",
        "company": d.get("company", "") or "",
        "title": d.get("title", "") or "",
        "phones": phones,
        "email": d.get("email", "") or "",
        "website": d.get("website", "") or "",
        "address": d.get("address", "") or "",
        "fax": fax,
        "taxId": d.get("taxId", d.get("tax_id", "")) or "",
        "note": note,
    }
    text = d.get("raw_text") or "\n".join(
        v for v in [fields["name"], fields["company"], fields["title"],
                    fields["email"], fields["website"], fields["address"]] if v)
    return {"text": text, "fields": fields}

@app.get("/")
def health():
    return {"ok": True, "model": MODEL, "ollama": OLLAMA}

@app.post("/ocr")
async def ocr(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    img = body.get("image") or ""
    if "," in img and img.strip().startswith("data:"):
        img = img.split(",", 1)[1]            # 容許 dataURL
    if not img:
        return JSONResponse({"error": "no image"}, status_code=400)
    try:
        raw = await run_in_threadpool(call_ollama, img)
        return normalize(raw)
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": f"辨識失敗:{e}"}, status_code=502)
