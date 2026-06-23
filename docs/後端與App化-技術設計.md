# CardSnap 後端與 App 化 — 技術設計（v0.1，待審查）

> 本文件是「推進前後台系統 + 後續轉 App」的**設計基準**，先行於任何程式碼。
> 目的：把架構決策、資料模型、API 合約、遷移策略講清楚、可審查、可回溯。
> 範圍對齊 `docs/前後台系統規劃.html`，但只把**階段一（後端基礎）**展開到可實作層級；後續階段僅給路線與驗收門檻。

---

## 0. 現況基準（Where we are）

| 面向 | 現況 |
|---|---|
| 前端 | 純靜態 PWA（vanilla JS），`assets/app.js`（UI/狀態）+ `assets/core.js`（純邏輯，可 Node 測試） |
| 資料儲存 | `localStorage`（key `cardsnap.contacts.v1`）；去重鍵 `contactKey`、刪除用 tombstone |
| 雲端同步 | 兩種模式：①「雲端」存**擁有者** Drive，經 Cloudflare `functions/api/sync.js`（owner refresh token，多用戶）②使用者自己的 Drive `appDataFolder` |
| 登入 | Google Identity（`assets/config.js` 的 client id） |
| OCR | 預設打自架本機 GPU（`ocr.name-car-box.com`）→ 失敗退回端上 Tesseract；Google Vision 為非預設後援 |
| 部署 | GitHub Pages / Cloudflare Pages（`name-car-box.com`）/ Netlify |

**現有 contact 物件實際欄位**（以 `app.js` 為準）：
```
id, created, updated, favorite, source, raw,
name, company, title,
phone, phones:[{label,value}], fax, taxId,
email, website, address,
tags:[string], note, group,
image, images:[dataURL]
```

---

## 1. 目標與非目標

**目標（本設計涵蓋）**
- 以一套**共用後端**同時服務現在的 Web 與**未來的 React Native App**。
- 把 contacts 的「真實來源（source of truth）」從 localStorage / Drive JSON，遷移到**關聯式資料庫**，localStorage 退居離線快取。
- 資料模型、權限（RLS）對齊規劃文件，為後續訂閱／Admin／RBAC 預留位置。
- 全程**不破壞現有功能**：每一步 lint + test 綠燈、既有使用流程不退化。

**非目標（本階段不做）**
- 訂閱付費牆、廣告、RevenueCat（規劃的「變現」階段）。
- Admin 後台、RBAC、稽核日誌（規劃的「後台 v1」階段）。
- React Native App 本體（僅做「不擋路」的相容性設計）。

---

## 2. 技術選型決策（ADR）

**決策：後端採 Supabase（Postgres + Auth + RLS + Storage）。**

| 需求 | Supabase 對應 |
|---|---|
| Web + App 共用一套後端 | 官方 JS SDK，vanilla Web 與 React Native 共用同一 Auth/DB/Storage |
| 規劃的關聯式 schema | 就是 Postgres，DDL 幾乎照抄規劃文件 |
| 「使用者只能讀寫自己名片」 | Row Level Security 內建 |
| 後台分權（後續） | RLS + Postgres role，對齊規劃 RBAC |

**已評估的替代方案與否決理由**
- **沿用 Cloudflare D1**：貼近現有部署，但 Auth、跨裝置同步、RN 整合都要自造；偏離規劃的 Postgres/RLS 願景。
- **Firebase**：RN 一級支援，但 NoSQL 與規劃的關聯式 schema、後台報表查詢對不上。

> 待用戶確認後才會註冊 Supabase 專案並取得 `Project URL` / `anon key`。設計階段不接外部服務。

---

## 3. 目標架構

```
        ┌─────────── 前台 ───────────┐         ┌──── 後台(後續) ────┐
 現在 →  Web PWA (vanilla JS)         未來 →  RN App        Admin (Next.js)
        └──────────────┬─────────────┘                 │
                       │  Supabase JS SDK / REST        │
                       ▼                                ▼
                 ┌──────────────── Supabase ────────────────┐
                 │ Auth(Google) · Postgres(RLS) · Storage   │
                 └──────────────────────────────────────────┘
                       │  影像備份(image_drive_id 參照)
                       ▼
                 使用者自己的 Google Drive(沿用現有機制)
```

**隱私原則（對齊規劃）**：名片**影像**仍存使用者自己的 Drive，DB 只存中繼資料與 `image_drive_id` 參照。後台日後只看得到統計，看不到名片內容明細。

---

## 4. 資料模型（階段一 DDL）

只建階段一必要的表。其餘表（`subscriptions` / `admin_users` / `feature_flags` / `audit_logs` …）在後續階段依規劃文件 §05 補上，此處不預先建立（YAGNI）。

```sql
-- users:鏡射 auth.users,存 app 層的方案/狀態(供後續訂閱/後台用)
create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  auth_provider text,
  plan          text not null default 'free',   -- free | pro
  status        text not null default 'active',  -- active | suspended
  created_at    timestamptz not null default now()
);

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.users(id) on delete cascade,
  name          text,
  company       text,
  title         text,
  phones        jsonb not null default '[]',     -- [{label,value}],對齊現有 phones[]
  fax           text,
  tax_id        text,
  email         text,
  website       text,
  address       text,
  note          text,
  "group"       text default '',
  source        text default '',
  is_favorite   boolean not null default false,
  image_drive_id text,                            -- 影像存 Drive,DB 只存參照
  ocr_confidence real,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on public.contacts (owner_id);
create index on public.contacts (owner_id, updated_at desc);

create table public.tags (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid not null references public.users(id) on delete cascade,
  name      text not null,
  color     text,
  unique (owner_id, name)
);

create table public.contact_tags (
  contact_id uuid references public.contacts(id) on delete cascade,
  tag_id     uuid references public.tags(id) on delete cascade,
  primary key (contact_id, tag_id)
);
```

**與現有資料的映射差異（需在遷移層處理）**
- 現有 `phone`（主電話）= `phones[0].value`：DB 不另存單一 `phone` 欄，由前端從 `phones` 衍生（與現有 `syncPhones` 一致）。
- 現有 `tags:[string]`：寫入時拆解到 `tags` + `contact_tags` 關聯。
  - **權衡**：階段一也可先把 `tags` 存成 `contacts.tags jsonb` 簡化，待後台需要標籤統計再正規化。**建議**：直接用關聯表，避免日後再遷一次（符合「最嚴謹」訴求）。
- 現有 `image`/`images[]`（dataURL）：上傳到 Drive，DB 存 `image_drive_id`；離線快取仍可留 dataURL 於本地。
- `updated_at`：取代現有毫秒數 `updated`，作為同步衝突解（較新者勝），與現有 `syncMerge` 策略一致。
- 刪除：DB 採真實 DELETE（RLS 限本人）。本地 tombstone 機制在「離線刪除→上線同步」時仍需要，保留。

---

## 5. 權限（RLS 政策）

```sql
alter table public.contacts     enable row level security;
alter table public.tags         enable row level security;
alter table public.contact_tags enable row level security;
alter table public.users        enable row level security;

-- 本人才能讀寫自己的名片
create policy contacts_owner on public.contacts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy tags_owner on public.tags
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy contact_tags_owner on public.contact_tags
  for all using (
    exists (select 1 from public.contacts c
            where c.id = contact_id and c.owner_id = auth.uid())
  );

create policy users_self on public.users
  for select using (id = auth.uid());
```

**驗收**：以兩個測試帳號，A 不得讀到 B 的 contacts（SQL 直查驗證 RLS 生效）。

---

## 6. 前台資料存取合約

對齊規劃文件 §04 的前台 API。Supabase 下多數 CRUD 走 SDK（PostgREST），少數複合動作走 Edge Function。

| 動作 | 規劃端點 | 階段一實作方式 |
|---|---|---|
| 登入 | `POST /auth/login` | Supabase Auth（Google OAuth） |
| 取名單 | `GET /contacts` | SDK `from('contacts').select()`（搭配搜尋/標籤/分頁） |
| 新增 | `POST /contacts` | SDK `insert` |
| 編輯/收藏 | `PATCH /contacts/:id` | SDK `update` |
| 刪除 | `DELETE /contacts/:id` | SDK `delete` |
| Drive 影像備份 | `POST /sync/drive` | 沿用現有 Drive 上傳，回填 `image_drive_id` |
| 匯出 | `GET /export?fmt=` | **前端現成** `toCSV`/`toVCard` 直接產生，暫不上後端 |
| 訂閱查詢 | `GET /me/subscription` | 後續階段 |

---

## 7. 儲存層遷移策略（最關鍵、風險最高）

**核心手法：在 `app.js` 與資料之間插入一層 `Store` 抽象介面**，把現在散落的 `localStorage.getItem/setItem`、`load/save/cloudSync` 收斂到單一介面。前端其餘程式只依賴介面，不關心底層是 localStorage 還是 Supabase。

```js
// store 介面(階段一目標形狀)
const Store = {
  async list(),                 // 取全部(本地快取優先,背景與雲端對帳)
  async upsert(contact),        // 新增/更新(樂觀更新本地 → 背景推雲)
  async remove(id),             // 刪除
  async sync(),                 // 拉雲端 → 與本地 syncMerge → 回寫
  onChange(cb),                 // 資料變動通知 UI 重繪
};
```

**遷移分三小步，每步可獨立驗證、可回退**
1. **抽象但不換底層**：把現有 localStorage 讀寫包進 `Store`，行為 100% 不變。驗收：所有現有功能照舊、lint+test 綠燈。
2. **接 Supabase 為第二後端**：登入後 `Store.sync()` 與 Supabase 對帳，localStorage 變離線快取。沿用現有 `core.syncMerge`（較新者勝）+ tombstone。驗收：兩瀏覽器同帳號，新增/編輯/刪除會同步。
3. **影像搬家**：新名片影像上傳 Drive、DB 存 `image_drive_id`；舊的 dataURL 漸進式搬遷。驗收：DB 不含 base64 影像、清掉後仍能從 Drive 取回顯示。

**離線優先**：localStorage 永遠是即時讀寫對象（UI 不等網路）；雲端同步在背景 debounce（沿用現有 `schedulePush` 2.5s）。離線可用，連線後自動對帳。

---

## 8. App 化相容性（不擋路設計）

轉 React Native 時 **UI 會重寫**，但要確保現在的投資不白費：

- **抽 `assets/core.js` 成框架無關的共用模組**（`parseCard`/`toVCard`/`toCSV`/`parseCSV`/`mergeContacts`/`syncMerge`）。它本來就無 DOM、UMD 雙導出 —— 可直接被 RN 引用，或轉為 TS package（`@cardsnap/core`）給 Web + App 共用。
- **`Store` 介面跨端一致**：Web 用 localStorage 快取，RN 用 SQLite/MMKV 快取，但對 UI 暴露同一組 `list/upsert/remove/sync`，後端同為 Supabase。
- **Auth 與 DB 用 Supabase 官方 SDK**，Web 與 RN 共用同一專案與 RLS。

> 原則：**現在每個後端決策都以「RN 也能直接用」為篩選條件**，因此選 Supabase、把 core 邏輯保持框架無關。

---

## 9. 分階段路線圖與驗收門檻

| 階段 | 內容 | 驗收門檻（Definition of Done） |
|---|---|---|
| **0. 設計審查** | 本文件 | 用戶核可選型與資料模型 |
| **1a. Store 抽象** | 包住現有 localStorage | 功能零退化、lint+test 綠 |
| **1b. Supabase schema** | DDL + RLS | 跨用戶讀取被 RLS 擋下（SQL 驗證） |
| **1c. Auth + 同步** | Google 登入 + contacts 對帳 | 雙裝置同帳號 CRUD 即時同步 |
| **1d. 影像備份** | Drive + `image_drive_id` | DB 無 base64、影像可還原 |
| **2. 後台 v1** | 使用者管理 / 儀表板 / 稽核 / feature flags | 依規劃 §03、§07 另立設計 |
| **3. 變現** | 訂閱 / 付費牆 / 廣告 | 依規劃 §06② 另立設計 |
| **4. App 上架** | RN App + 後台補強 | core 模組共用、EAS Build |

---

## 10. 待決問題（需用戶拍板）

1. **Supabase 專案**：由用戶建立並提供 `Project URL` / `anon key`（我無法代為註冊）。dev / prod 是否一開始就分兩個專案？
2. **既有「擁有者 Drive 多用戶同步」（`functions/api/sync.js`）的去留**：遷到 Supabase 後，此 function 是直接退役，還是過渡期並存？建議：階段 1c 上線並驗證後退役。
3. **tags 正規化時機**：階段一就用關聯表（建議），或先 jsonb 之後再遷？
4. **登入策略**：沿用現有 Google Identity client，或改用 Supabase Auth 內建 Google provider（建議後者，省一層自管 token）？

---

## 11. 風險

- **資料遷移**：現有使用者 localStorage / Drive 既有資料需一次性匯入 Supabase；需寫遷移腳本並在 staging 演練，避免去重鍵不一致造成重複或遺失。
- **`app.js` 體積**（~1600 行、UI 與儲存耦合）：抽 `Store` 時要小步重構、隨時可回退，避免大改一次性破壞。
- **離線/線上衝突**：沿用 `syncMerge`（較新者勝）+ tombstone；需測「離線編輯 vs 他端編輯」的合併結果。
```
