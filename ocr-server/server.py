"""
CardSnap 本機 GPU OCR 伺服器
  - 接收 App 傳來的名片影像(base64 JPEG)
  - 呼叫本機 Ollama 的視覺模型(預設 qwen2.5vl:32b)做 OCR + 結構化抽取
  - 回傳 { text, fields }  fields = {name, company, title, phones[], email, website, address, fax, taxId, note}

啟動:  run.bat   (或  python -m uvicorn server:app --host 0.0.0.0 --port 8000)
需求:  先安裝 Ollama 並  ollama pull qwen2.5vl:32b
"""
import os, json, base64, re
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL  = os.environ.get("OCR_MODEL", "qwen2.5vl:32b")

app = FastAPI(title="CardSnap Local OCR")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

PROMPT = (
    "你是名片資訊擷取引擎。請辨識這張名片影像,輸出「繁體中文」的 JSON,只輸出 JSON,不要說明。\n"
    "鍵值固定為:\n"
    '{ "name": 姓名, "company": 公司全名, "title": 職稱, '
    '"phones": [ {"label":"手機/市話/傳真", "value":"號碼"} ], '
    '"email": 電子郵件, "website": 網站, "address": 完整地址, '
    '"fax": 傳真號碼, "taxId": 統一編號(8碼數字), "note": 其他備註, '
    '"raw_text": 名片上所有文字原樣 }\n'
    "找不到的欄位留空字串或空陣列。手機為 09 開頭;市話含區碼;傳真歸到 fax 也可放入 phones。"
)

def call_ollama(b64: str) -> dict:
    body = {
        "model": MODEL,
        "prompt": PROMPT,
        "images": [b64],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }
    r = requests.post(f"{OLLAMA}/api/generate", json=body, timeout=120)
    r.raise_for_status()
    resp = r.json().get("response", "").strip()
    # 模型理應回純 JSON;保險起見抽出第一個 JSON 物件
    try:
        return json.loads(resp)
    except Exception:
        m = re.search(r"\{.*\}", resp, re.S)
        if m:
            return json.loads(m.group(0))
        raise

def normalize(d: dict) -> dict:
    d = d or {}
    phones = []
    for p in (d.get("phones") or []):
        if isinstance(p, str):
            phones.append({"label": "電話", "value": p})
        elif isinstance(p, dict) and (p.get("value") or p.get("number")):
            phones.append({"label": p.get("label") or p.get("type") or "電話",
                           "value": p.get("value") or p.get("number")})
    fields = {
        "name": d.get("name", "") or "",
        "company": d.get("company", "") or "",
        "title": d.get("title", "") or "",
        "phones": phones,
        "email": d.get("email", "") or "",
        "website": d.get("website", "") or "",
        "address": d.get("address", "") or "",
        "fax": d.get("fax", "") or "",
        "taxId": d.get("taxId", d.get("tax_id", "")) or "",
        "note": d.get("note", "") or "",
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
        raw = call_ollama(img)
        return normalize(raw)
    except requests.HTTPError as e:
        return JSONResponse({"error": f"Ollama 錯誤:{e}"}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": f"辨識失敗:{e}"}, status_code=502)
