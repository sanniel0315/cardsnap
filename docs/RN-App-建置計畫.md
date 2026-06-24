# CardSnap React Native App — 建置計畫(v0.1)

> 把已上線的 Web 邏輯延伸到原生 App。**核心原則:商業邏輯不重寫**——`@cardsnap/core` 已是無 DOM 純模組,App 與 Web 共用同一份;只重做 UI 與平台整合(相機、儲存、推播)。
> 本文件是「在獨立 Expo 專案照著起」的指引,**不在這個純靜態 web repo 內塞 RN 程式碼**(無法安裝/驗證)。

---

## 1. 技術選型

| 項目 | 選擇 | 理由 |
|---|---|---|
| 框架 | **Expo(React Native)+ TypeScript** | 最快起專案、EAS Build 出 iOS/Android、OTA 熱更新(對齊規劃文件) |
| 導航 | expo-router | 檔案式路由,簡單 |
| 後端 | **Supabase JS SDK**(與 Web 同一專案) | 共用 Auth/DB/RLS,零重複 |
| 本地儲存 | expo-sqlite 或 react-native-mmkv | 取代 Web 的 localStorage 作離線快取 |
| 相機 | expo-camera | 取景拍照 |
| OCR | 見 §6(三層,與 Web 對齊) |

---

## 2. 如何複用 `@cardsnap/core`(關鍵)

App 與 Web 共用同一份:`parseCard` / `toVCard` / `toCSV` / `parseCSV` / `parseVCards` / `mergeContacts` / `contactKey` / `syncMerge` / `migrate` / `dropJunk` / `fillMissing`。

兩種接法,擇一:
- **A. monorepo workspace(建議)**:把現有 repo 與 RN App 放進 pnpm/npm workspace,App `package.json` 依賴 `"@cardsnap/core": "workspace:*"`。Metro 直接解析。
- **B. 先發佈成 npm 套件**:依 `packages/core/README.md` 的演進路徑,把 `assets/core.js` 內容搬進 `packages/core/index.js`(脫離相對路徑),App 安裝該套件。

> `packages/core/index.d.ts` 已提供型別,RN(TS)直接有自動完成與型別檢查。

---

## 3. Store:跨端統一介面(承接設計文件 §7/§8)

App 與 Web 對 UI 暴露**同一組高階介面**,只換底層 adapter:

```ts
interface Store {
  list(): Promise<Contact[]>;
  upsert(c: Contact): Promise<void>;
  remove(id: string): Promise<void>;
  sync(): Promise<void>;          // 用 core.syncMerge + tombstone 與 Supabase 對帳
}
```

- **Web**:底層 localStorage(同步),即現有 `assets/store.js` 的演進。
- **RN**:底層 expo-sqlite / MMKV。
- **同步/非同步鴻溝**(重要):Web 的 `load()` 是同步、RN 儲存多為非同步。對策:App 啟動時一次 `await store.list()` 載入記憶體快取,之後 UI 讀記憶體(同步)、寫時非同步落地 + 背景 `sync()`。與現有「localStorage 即時、雲端 debounce」模型一致。

---

## 4. 螢幕結構(對應現有 Web 功能)

| 螢幕 | 對應 Web | 重點 |
|---|---|---|
| 名單 | 清單/搜尋/標籤/收藏 | 用 core 的排序/篩選邏輯 |
| 掃描 | captureModal | expo-camera 取景 → OCR → `parseCard` → 確認頁 |
| 確認/編輯 | editModal | 含**正反面互補**:沿用 `fillMissing`,UI 給「掃背面補欄位」 |
| 詳情/分享 | detail modal | 撥號/寄信/vCard/QR(expo-sharing) |
| 設定 | settings | 儲存模式、OCR 來源 |
| 登入 | login | Supabase Auth Google(原生 OAuth) |

> 正反面互補(A 補拍 / B 確認頁掃背面)的**規則層已在 core**,App 只接 UI。

---

## 5. Supabase 接法

- 同一個 Supabase 專案、同一套 RLS——App 與 Web 帳號互通、資料同步。
- Auth 用 `supabase.auth.signInWithOAuth({ provider: 'google' })` + expo-auth-session 處理原生回跳。
- contacts CRUD 走 SDK;`Store.sync()` 邏輯與 Web 的 `supabase-sync.js` 對帳一致(可把對帳邏輯也抽進 core 共用)。

---

## 6. OCR(三層,與 Web 對齊)

1. **自架 GPU 伺服器**(`ocr-server/`,預設):App 同樣 POST 影像到 `ocr.name-car-box.com/ocr`。
2. **雲端 Vision 代理**:後援。
3. **裝置端 OCR**:Web 用 Tesseract.js;**RN 改用 expo 的 ML Kit 文字辨識**(`@react-native-ml-kit/text-recognition`)——比 Tesseract.js 在手機上快很多。

辨識出文字後一律丟給 `core.parseCard`,欄位解析邏輯與 Web 完全相同。

---

## 7. 目錄結構與起步

```
cardsnap-app/                 # 新的 Expo 專案(獨立 repo 或 workspace 一員)
├── app/                      # expo-router 螢幕
│   ├── index.tsx             # 名單
│   ├── scan.tsx              # 掃描
│   └── contact/[id].tsx      # 詳情
├── src/
│   ├── store/                # SQLite/MMKV adapter,實作 §3 介面
│   ├── ocr/                  # 三層 OCR(§6)
│   └── supabase.ts           # client
└── package.json              # 依賴 @cardsnap/core
```

```bash
npx create-expo-app cardsnap-app -t expo-template-blank-typescript
cd cardsnap-app
npx expo install expo-camera expo-sqlite expo-auth-session @supabase/supabase-js
# 接上 @cardsnap/core(workspace 或 npm)
npx expo start
```

---

## 8. 分階段(每階段可獨立驗收)

| 階段 | 內容 | 驗收 |
|---|---|---|
| R1 | Expo 骨架 + 接 `@cardsnap/core` + 名單(讀 Supabase) | 列出雲端名片 |
| R2 | 掃描:相機 + OCR + `parseCard` + 確認頁 | 拍一張能建檔 |
| R3 | 正反面互補(`fillMissing`)、編輯、刪除 | 正面人名→掃背面補齊 |
| R4 | Store adapter + 離線快取 + `sync()` 對帳 | 離線可用、上線同步;與 Web 互通 |
| R5 | 分享/匯出、設定、推播 | vCard/QR/CSV |
| R6 | EAS Build + 送審上架 | TestFlight / Play 內測 |

---

## 9. 風險與注意

- **同步/非同步**:見 §3,啟動載入記憶體快取是關鍵。
- **OCR 一致性**:三層來源辨識文字後都走同一個 `core.parseCard`,確保 App 與 Web 解析結果一致。
- **共用程式碼邊界**:只有 `@cardsnap/core`(純邏輯)跨端共用;UI、相機、儲存 adapter 各平台各自實作,不強求共用。
- 對帳邏輯(`syncMerge` + tombstone)建議也下沉 core,避免 App/Web 各寫一份。
