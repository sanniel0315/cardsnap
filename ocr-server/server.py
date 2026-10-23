"""
CardSnap 本機 GPU OCR 伺服器
  - 接收 App 傳來的名片影像(base64 JPEG)
  - 呼叫本機 Ollama 的視覺模型(預設 qwen2.5vl:7b)做 OCR + 結構化抽取
  - 回傳 { text, fields }  fields = {name, company, title, phones[], email, website, address, fax, taxId, note}

啟動:  run.bat   (或  python -m uvicorn server:app --host 0.0.0.0 --port 8000)
需求:  先安裝 Ollama 並  ollama pull qwen2.5vl:7b
"""
import os, json, base64, re, traceback, threading
import cv2
import numpy as np
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL  = os.environ.get("OCR_MODEL", "qwen2.5vl:32b")   # 預設 32b(小字/密集名片較準,5090 熱機後夠快);靠開機預載+keep_alive 避免冷載破 Cloudflare 100s;要換設環境變數 OCR_MODEL
FALLBACK_MODEL = "qwen2.5vl:7b"

app = FastAPI(title="CardSnap Local OCR")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

def _warmup():
    # 開機就把模型載進 VRAM(空 prompt = 只載入不推論),避免第一張使用者請求冷載破 Cloudflare 100s
    try:
        requests.post(f"{OLLAMA}/api/generate",
                      json={"model": MODEL, "keep_alive": "30m"}, timeout=600)
    except Exception:
        pass

@app.on_event("startup")
def _on_startup():
    threading.Thread(target=_warmup, daemon=True).start()

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
            "keep_alive": "30m",                 # 模型常駐 VRAM,避免下一張又要冷載
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

# ===== 名片自動裁切拉正(相簿/上傳的照片用;App 原生掃描器拍的已裁好)=====
# 找名片四個角 → 透視校正成正面矩形。找不到可信的四邊形就回原圖,不硬裁。
def _order(pts: np.ndarray) -> np.ndarray:
    # 依 左上、右上、右下、左下 排序
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], np.float32)

def _plausible(quad: np.ndarray, area_img: float) -> bool:
    q = _order(quad)
    w = max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3]))
    h = max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1]))
    if min(w, h) < 1:
        return False
    ratio = max(w, h) / min(w, h)
    frac = cv2.contourArea(q) / area_img
    # 四邊都完全水平/垂直 = 截圖或掃描檔裡的框,不是手機拍的名片
    sides = [q[(i + 1) % 4] - q[i] for i in range(4)]
    if all(min(abs(np.degrees(np.arctan2(dy, dx))) % 90, 90 - abs(np.degrees(np.arctan2(dy, dx))) % 90) < 0.5 for dx, dy in sides):
        return False
    return 0.12 <= frac <= 0.97 and 1.1 <= ratio <= 2.4 and cv2.isContourConvex(q.astype(np.int32))

def _side_support(edges: np.ndarray, q: np.ndarray) -> float:
    # 四條邊各自有多少比例落在邊緣上,取最弱的一邊(真名片四邊都該有邊緣)
    h, w = edges.shape
    worst = 1.0
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        t = np.linspace(0.08, 0.92, 40)[:, None]       # 避開圓角
        p = np.rint(a + (b - a) * t).astype(int)
        p[:, 0] = p[:, 0].clip(0, w - 1); p[:, 1] = p[:, 1].clip(0, h - 1)
        worst = min(worst, float((edges[p[:, 1], p[:, 0]] > 0).mean()))
    return worst

def _inout_contrast(lab: np.ndarray, q: np.ndarray) -> float:
    # 名片內側一圈 vs 外側一圈的平均色差(Lab)。截圖裡的表格框線內外同底色 → 色差小,排除
    m = np.zeros(lab.shape[:2], np.uint8)
    cv2.fillConvexPoly(m, q.astype(np.int32), 255)
    near, far = np.ones((7, 7), np.uint8), np.ones((25, 25), np.uint8)   # 跳過邊界線本身(框線顏色不算)
    inner = cv2.subtract(cv2.erode(m, near), cv2.erode(m, far))
    outer = cv2.subtract(cv2.dilate(m, far), cv2.dilate(m, near))
    if not inner.any() or not outer.any():
        return 0.0
    return float(np.linalg.norm(np.array(cv2.mean(lab, inner)[:3]) - np.array(cv2.mean(lab, outer)[:3])))

def _find_card(img: np.ndarray):
    scale = min(1.0, 800 / max(img.shape[:2]))
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else img
    area = small.shape[0] * small.shape[1]
    blur = cv2.GaussianBlur(small, (5, 5), 0)
    gray = cv2.cvtColor(blur, cv2.COLOR_BGR2GRAY)
    lab = cv2.cvtColor(blur, cv2.COLOR_BGR2LAB)

    # 邊緣:灰階多組門檻 + 各色版(低對比的白卡淺桌、彩色雜物都抓得到)
    edge_maps = [cv2.Canny(gray, lo, hi) for lo, hi in ((10, 30), (25, 75), (50, 150))]
    edge_maps.append(np.max([cv2.Canny(blur[:, :, k], 25, 75) for k in range(3)], axis=0))
    support = cv2.dilate(np.max(edge_maps, axis=0), np.ones((5, 5), np.uint8))

    masks = [cv2.morphologyEx(e, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) for e in edge_maps]
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    masks += [otsu, 255 - otsu]                 # 名片比背景亮或暗都試

    best, best_score = None, 0.0
    for m in masks:
        cnts, _ = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:12]:
            if cv2.contourArea(c) < 0.05 * area and cv2.arcLength(c, True) < 0.5 * (small.shape[0] + small.shape[1]):
                break
            hull = cv2.convexHull(c)
            cands = [cv2.approxPolyDP(hull, e * cv2.arcLength(hull, True), True) for e in (0.02, 0.04)]
            quads = [a.reshape(4, 2).astype(np.float32) for a in cands if len(a) == 4]
            quads.append(cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float32))   # 圓角/邊緣破碎:最小外接矩形
            for quad in quads:
                if not _plausible(quad, area):
                    continue
                s = _side_support(support, _order(quad))
                if s < 0.6 or _inout_contrast(lab, quad) < 15:
                    continue
                score = s * cv2.contourArea(quad) / area
                if score > best_score:
                    best, best_score = quad, score
    return None if best is None else _order(best / scale)

def crop_card(b64: str) -> tuple[str, bool]:
    """回傳 (JPEG base64, 是否有裁切)。"""
    img = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)   # 會套用 EXIF 方向
    if img is None:
        raise ValueError("影像無法解碼")
    q = _find_card(img)
    if q is None:
        return b64, False
    w = int(max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3])))
    h = int(max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1])))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    out = cv2.warpPerspective(img, cv2.getPerspectiveTransform(q, dst), (w, h))
    s = 1600 / max(w, h)
    if s < 1:
        out = cv2.resize(out, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf.tobytes()).decode(), True

async def _read_image(req: Request):
    try:
        body = await req.json()
    except Exception:
        return None, None
    img = body.get("image") or ""
    if "," in img and img.strip().startswith("data:"):
        img = img.split(",", 1)[1]            # 容許 dataURL
    return body, img

@app.get("/")
def health():
    return {"ok": True, "model": MODEL, "ollama": OLLAMA, "crop": True}

@app.post("/crop")
async def crop(req: Request):
    # 只裁切不辨識:{image} → {image, cropped}
    body, img = await _read_image(req)
    if not img:
        return JSONResponse({"error": "no image"}, status_code=400)
    try:
        out, cropped = await run_in_threadpool(crop_card, img)
        return {"image": out, "cropped": cropped}
    except Exception as e:
        return JSONResponse({"error": f"裁切失敗:{e}"}, status_code=400)

@app.post("/ocr")
async def ocr(req: Request):
    # 帶 crop:true → 先裁切拉正再辨識,回應多 image(裁好的 JPEG base64)與 cropped
    body, img = await _read_image(req)
    if body is None:
        return JSONResponse({"error": "bad json"}, status_code=400)
    if not img:
        return JSONResponse({"error": "no image"}, status_code=400)
    extra = {}
    if body.get("crop"):
        try:
            img, cropped = await run_in_threadpool(crop_card, img)
            extra = {"image": img, "cropped": cropped} if cropped else {"cropped": False}
        except Exception:
            traceback.print_exc()             # 裁切失敗不影響辨識
    try:
        raw = await run_in_threadpool(call_ollama, img)
        return {**normalize(raw), **extra}
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"error": f"辨識失敗:{e}"}, status_code=502)
