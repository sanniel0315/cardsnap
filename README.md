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

## 🚀 在本機跑

純靜態前端，無需 build。任選一種起一個本機伺服器（OCR 需在 http/https 下才能用相機）：

```bash
# Python
python3 -m http.server 8080
# 或 Node
npx serve .
```

然後開 <http://localhost:8080>。

## ☁️ 部署到 GitHub Pages（自動）

本專案內含 `.github/workflows/deploy-pages.yml`：**推到 `main` 分支就自動部署**。

1. 在 GitHub 建立 repo 並推送（見下方）。
2. repo → **Settings → Pages → Build and deployment → Source 選「GitHub Actions」**。
3. 之後每次 `git push`，網站自動更新，網址為
   `https://<你的帳號>.github.io/<repo 名>/`。

## 📦 首次推上 GitHub

> 注意：本資料夾若有殘留的 `.git_broken` 資料夾可直接刪除（雲端環境產生的無用檔）。

**方法 A — 一鍵腳本（最快）**：在 `cardsnap/` 目錄下執行，把網址換成你的 repo：

```bash
# Windows（命令提示字元）
setup-github.bat https://github.com/你的帳號/cardsnap.git

# Mac / Linux / Git Bash
bash setup-github.sh https://github.com/你的帳號/cardsnap.git
```

**方法 B — GitHub Desktop（不用打指令）**：
File → Add Local Repository → 選 `cardsnap` 資料夾 → Publish repository。

**方法 C — 手動指令**：

```bash
git init && git add -A && git commit -m "feat: CardSnap web MVP"
git branch -M main
git remote add origin https://github.com/你的帳號/cardsnap.git
git push -u origin main
```

## 🧱 技術

| 項目 | 用什麼 |
|---|---|
| OCR | [Tesseract.js](https://tesseract.projectnaptha.com/)（端上，免費、離線） |
| QR | [qrcode](https://www.npmjs.com/package/qrcode) |
| 儲存 | 瀏覽器 `localStorage` |
| 部署 | GitHub Pages + Actions |

無框架、無打包，方便日後接到藍圖規劃的 Next.js / React Native 版本。

## 🗺️ 後續（對應藍圖）

- [ ] Google Drive 同步（用戶自有雲端備份）
- [ ] 批次掃描
- [ ] 帳號登入與多裝置同步
- [ ] RevenueCat 訂閱 / AdMob 廣告（App 版）
- [ ] React Native App 上架 iOS / Android

## 📄 授權

MIT © 2026 sanniel
