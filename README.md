# ◈ CardSnap — 名片整理 App（網頁 / PWA）

拍照即建檔的名片整理工具。手機或桌機瀏覽器拍照 → **端上 OCR 辨識** → 自動填入姓名/公司/職稱/電話/Email/地址 → 名單管理、搜尋、標籤 → 一鍵匯出 **CSV / vCard** 與分享。

> 影像只在你的瀏覽器辨識（Tesseract.js），**不會上傳任何伺服器**。資料存在本機 `localStorage`，隱私優先。

這是 [技術藍圖](../名片整理APP_技術藍圖.html) 的第一版可運作實作（Web MVP）。

---

## ✨ 功能

- 📷 **拍照 / 上傳 OCR**：呼叫相機或選圖，端上辨識（支援繁體中文 + 英文）
- 🧠 **欄位自動解析**：正則 + 關鍵字推斷姓名、公司、職稱、電話、Email、網站、地址
- 🗂️ **名單管理**：清單檢視、全文搜尋、標籤分類、收藏、備註
- 📤 **匯出**：CSV（Excel / Google 通訊錄）、vCard（.vcf）、JSON 備份
- 🔗 **分享**：Web Share API、複製、vCard 下載、**QR Code** 掃描存入通訊錄
- 📱 **PWA**：可「加入主畫面」當 App 用，支援離線開啟

## 🚀 開發（本機）

純靜態前端，無需 build。純邏輯集中在 `assets/core.js`（可被瀏覽器與 Node 共用）。

```bash
npm run dev     # 起本機伺服器 http://localhost:8080（OCR 需 http/https 才能用相機）
npm run lint    # 語法檢查（node --check，零相依）
npm test        # 單元測試（node --test）
npm run ci      # lint + test，等同 CI 跑的內容
```

## ✅ 測試（自動）

`test/core.test.js` 用 Node 內建 test runner 測 `parseCard`／`toVCard`／`toCSV`，**零第三方相依**。

- `.github/workflows/ci.yml`：**每次 push 任何分支、每個 PR** 自動跑 lint + 測試。
- 測試不過 → CI 紅燈、且 **不會部署**（見下）。

## ☁️ 部署（自動，且需測試通過）

`.github/workflows/deploy-pages.yml`：**推到 `main` → 先跑測試 → 通過才部署**到 GitHub Pages。

1. repo → **Settings → Pages → Source 選「GitHub Actions」**（只需設定一次）。
2. 之後每次 `git push` 到 `main`，自動測試 + 部署，網址：
   `https://<你的帳號>.github.io/<repo 名>/`。

> 開發 → 測試 → 部署全自動：你只要 `git push`，其餘交給 GitHub Actions。

## 📦 首次推上 GitHub

> 注意：本資料夾若有殘留的 `.git_broken` 資料夾可直接刪除（雲端環境產生的無用檔）。

**方法 A — 一鍵腳本（最快）**：在 `cardsnap/` 目錄下執行，把網址換成你的 repo：

```bash
# Windows（命令提示字元）
setup-github.