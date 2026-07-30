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
MODEL  = os.environ.get("OCR_MODEL", "qwen2.5vl:32b")   # 預設 32b(小字/密集名片較準);未安裝自動退回 7b
FALLBACK_MODEL = "qwen2.5vl:7b"

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
    "email 務必仔細辨識(找含 @ 的字串,例如 name@example.com、xxx@msa.hinet.net;若有多個,取第一個放 email、其餘放 note)。raw_text 請務必逐字含所有 email、電話、地址。"
)

def _parse_json(resp: str) -> dict:
    try:
        return json.loads(resp)
    except Exception:
        m = re.search(r"\{.*\}", resp, re.S)
        if m:
            return json.loads(m.group(0))
        raise RuntimeError("模型輸出非 JSON:" + resp[:300])

def call_ollama(b64: str) -> dict:
    # 用 /api/chat(對視覺模型較穩);預設 MODEL,未安裝(400/404)自動退回 FALLBACK_MODEL
    models = [MODEL] + ([FALLBACK_MODEL] if MODEL != FALLBACK_MODEL else [])
    last = ""
    for model in models:
        body = {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT, "images": [b64]}],
            "stream": False,
            "options": {"temperature": 0},
        }
        r = requests.post(f"{OLLAMA}/api/chat", json=body, timeout=300)   # 32b 較慢,給到 300s
        if r.status_code == 200:
            resp = ((r.json().get("message") or {}).get("content") or "").strip()
            return _parse_json(resp)
        last = f"{model} {r.status_code}: {r.text[:200]}"
        if r.status_code in (400, 404) and model != models[-1]:
            continue   # 模型沒安裝 → 試下一個
        raise RuntimeError("ollama /api/chat " + last)
    raise RuntimeError("ollama 全部失敗:" + last)

def _s(v):
    # 把任何值攤平成乾淨字串(model 有時把 address 等回成 list/dict)
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return " ".join(_s(x) for x in v if x)
    if isinstance(v, dict):
        return " ".join(_s(x) for x in v.values() if x)
    return str(v)

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

    # email 後援:模型漏抓時,從整張原文(raw_text)用正則撈第一個 email
    raw = _s(d.get("raw_text"))
    email = _s(d.get("email"))
    if not email and raw:
        m = re.search(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", raw)
        if m:
            email = m.group(0)

    fields = {
        "name": _s(d.get("name")),
        "company": _s(d.get("company")),
        "title": _s(d.get("title")),
        "phones": phones,
        "email": email,
        "website": _s(d.get("website")),
        "address": _s(d.get("address")),
        "fax": _s(fax),
        "taxId": _s(d.get("taxId", d.get("tax_id", ""))),
        "note": _s(note),
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
