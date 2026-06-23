# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本專案規範：所有回應、說明、註解一律使用**繁體中文**；Git commit 訊息使用繁體中文。

## 專案概觀

CardSnap 是「拍照即建檔」的名片整理 PWA：相機/上傳 → OCR 辨識 → 解析欄位 → 名單管理/搜尋/標籤 → 匯出 CSV/vCard。**純靜態前端，無 build 步驟**，直接服務根目錄。資料預設存本機 `localStorage`，可選 Google 雲端同步。

## 常用指令

```bash
npm run dev     # 本機伺服器 http://localhost:8080(= python3 -m http.server）
                # 注意:相機/OCR 需 http/https 才能用,直接開檔(file://)不行
npm run lint    # 語法檢查:node --check assets/core.js / app.js / sw.js(零相依)
npm test        # 單元測試:node --test(跑 test/core.test.js,18 項)
npm run ci      # lint + test,等同 CI
```

跑單一測試：`node --test --test-name-pattern="<名稱片段>"`。測試只涵蓋 `assets/core.js` 的純邏輯（`parseCard`/`toVCard`/`toCSV`/`parseCSV`/`parseVCards`/`mergeContacts`）；UI 程式 `assets/app.js` 無自動測試，改動後請手動於瀏覽器驗證。

## 架構重點

### 純邏輯與 UI 的分離（重要）
- **`assets/core.js`** — 無 DOM 的純函式，**同時供瀏覽器與 Node 測試使用**（用 UMD 風格 `module.exports` / `window.CardSnapCore` 雙導出）。所有可測試的解析/格式化/去重邏輯都放這裡。修改解析規則就改這裡並補測試。
- **`assets/app.js`**（~1600 行）— 全部 UI、狀態、相機、OCR 串接、事件綁定。從 `window.CardSnapCore` 取用核心函式。檔內以 `/* ===== 區塊名 ===== */` 分段（擷取流程、匯入、名單渲染、分組、批次、編輯、詳情/分享、匯出、Drive 同步、設定、事件綁定）。
- **`assets/config.js`** — Google OAuth Client ID（雲端同步用）。

兩個入口 HTML：`index.html` 是行銷/登入頁，`app.html` 是實際 App。

### OCR 多層後援（fallback chain）
辨識來源依設定逐層退回，任何一層失效都不會壞：
1. **自訂 GPU 伺服器**（`settings.ocrEndpoint`，預設 `ocr.name-car-box.com`）— 見 `ocr-server/`，用本機顯卡跑 Qwen2.5-VL（Ollama），透過 Cloudflare Tunnel 連回，準確度最高、資料不外流。
2. **雲端 OCR 代理**（`/.netlify/functions/ocr`）— `netlify/functions/ocr.js` 代呼 Google Cloud Vision，金鑰存 Netlify 環境變數 `VISION_API_KEY`。
3. **端上 Tesseract.js** — 瀏覽器本地辨識，完全不上傳。

`app.js` 內 `remoteOCR()` / `preprocess()` / `srcToBase64()` 負責影像前處理與呼叫。

### 資料模型與同步
- 聯絡人存 `localStorage`（key `cardsnap.contacts.v1`），設定存 `cardsnap.settings`，刪除墓碑存 `cardsnap.tombstones`。
- **去重鍵 `contactKey`**：`e:email` → `p:純數字電話` → `n:name|company`。前端 `core.js` 與後端 `functions/api/sync.js` 的 `tkey` **必須對齊**，改一邊要改另一邊。
- **同步策略**：`syncMerge`（前端）/ `mergeContacts`（後端）做聯集去重，`updated`/`created` 時間戳較新者勝；刪除以 tombstone 傳播（>180 天的墓碑會被清掉）。
- 兩種雲端後端：`netlify/functions/ocr.js`（OCR）與 `functions/api/sync.js`（Cloudflare Pages Functions，多用戶同步到「擁有者」Google Drive，需 `OWNER_REFRESH_TOKEN` / `GOOGLE_CLIENT_SECRET`）。

### Service Worker 與版本戳記
- `sw.js` 用**網路優先**策略快取 app-shell，離線才回退快取。
- 原始碼裡版本號是佔位字串 `__BUILD_ID__`，**部署時由 CI 戳成 commit 短 SHA**（`scripts/stamp-version.sh` / `scripts/cf-build.sh`），原始碼保持乾淨——**不要手動把 `__BUILD_ID__` 改成真實值**。

## CI/CD（推送即自動測試與部署）

- `.github/workflows/ci.yml` — 每次 push 任何分支、每個 PR 跑 lint + test。
- `.github/workflows/deploy-pages.yml` — 推 `main` → 先測試 → 通過才部署到 **GitHub Pages**（部署前戳版本）。
- `.github/workflows/cloudflare-deploy.yml` — 推 `main` → `npm run ci` → `scripts/cf-build.sh` 組 `dist/` → Wrangler 部署到 **Cloudflare Pages**（正式網域 `name-car-box.com`），部署後輪詢線上 `app.js?v=<sha>` 做 smoke test。需 secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。
- 測試不過 → 不部署。

部署目標同時支援 GitHub Pages、Cloudflare Pages、Netlify（各有對應設定檔 `netlify.toml` / `wrangler.toml`）。`dist/` 為建置產物，已 gitignore。

## 本機 GPU OCR 伺服器（`ocr-server/`）

Python FastAPI（`server.py`），接 base64 影像 → 呼叫本機 Ollama 視覺模型（預設 `qwen2.5vl:7b`，可用 `OCR_MODEL` / `OLLAMA_URL` 覆寫）→ 回傳 `{ text, fields }`。`run.bat` 自動建 venv 裝套件並啟動於 :8765。詳見 `ocr-server/README.md`。
