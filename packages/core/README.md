# @cardsnap/core

CardSnap 的**共用商業邏輯**:名片解析（`parseCard`）、匯出（`toVCard`/`toCSV`）、匯入（`parseCSV`/`parseVCards`）、去重與雙向同步合併（`mergeContacts`/`contactKey`/`syncMerge`）。

**無 DOM、無第三方相依**，Web 前端與未來的 React Native App 共用同一份邏輯，避免雙端各寫一套而行為不一致。

## 用法

```js
// Node / React Native / 打包工具(Metro、Vite…)
import { parseCard, toVCard, syncMerge } from '@cardsnap/core';
// 或 CommonJS
const { parseCard } = require('@cardsnap/core');
```

```html
<!-- Web(本專案現況):直接以 <script> 載入,掛在 window.CardSnapCore -->
<script src="./assets/core.js"></script>
<script>const c = window.CardSnapCore.parseCard(text);</script>
```

## 真實來源與演進

- **真實來源是 `../../assets/core.js`**（同一份 UMD）。本套件的 `index.js` 只是轉出該模組，確保 Web 與 App **共用同一份程式碼**、不產生分歧。
- Web 端維持「無 build」：瀏覽器以 `<script>` 直接載入 `assets/core.js`。
- **發佈成獨立 npm 套件時**：把 `assets/core.js` 的內容搬進本目錄 `index.js`，Web 改用建置步驟複製，即可脫離相對路徑相依。

型別見 `index.d.ts`。
