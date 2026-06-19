# CardSnap 本機 OCR — 全自動設定(開機自跑 + 固定網址)

一次設定,之後**開機自動啟動、網址永遠不變**,不用每次跑 .bat。
(前提:這台 5090 電腦要開著;Ollama 在 Windows 本來就會背景自動啟動。)

## 一次性設定(在 5090 這台,依序做)

### 1. 下載模型(只需一次)
雙擊 `pull-model.bat`(下載 qwen2.5vl:7b)。

### 2. 設定「開機自動啟動伺服器」
雙擊 `install-autostart.bat`。
它會把啟動器放進 Windows 啟動資料夾,並立刻在背景啟動伺服器(:8765)。
以後每次開機自動跑,不用再手動。
(要取消:雙擊 `uninstall-autostart.bat`)

### 3. 裝 Tailscale + 開固定網址
- 下載安裝 Tailscale:https://tailscale.com/download(用 Google 帳號登入即可)。
- 裝好後,雙擊 `start-tunnel-fixed.bat`。
  - 第一次若提示要啟用 Funnel,照它給的連結點一下啟用(在 Tailscale 後台,免費)。
  - 成功後它會印出你的**固定網址**,長得像:
    `https://你的電腦名.你的tailnet.ts.net`
- Tailscale 是系統服務,開機自動恢復;`--bg` 會記住設定,重開機網址不變。

### 4. 把固定網址填進 App(只需一次)
CardSnap → 設定 →「自訂辨識伺服器網址」填:
```
https://你的電腦名.你的tailnet.ts.net/ocr
```
(結尾 `/ocr`)→ 儲存 → 按「測試連線」應顯示「連線成功 · 模型 qwen2.5vl:7b」。
建議把「只用本機伺服器」也打開,確保一定走 GPU。

## 完成後
以後開機 → 伺服器自動跑 + Tailscale 自動恢復固定網址 → 手機/桌機拍名片直接走 5090,
不用開任何視窗、網址也不再變。App 設定一次就好。

## 備註
- 那台電腦關機/睡眠時辨識會連不上(會提示),開機後自動恢復。
- 想臨時手動跑(不自動):用 `START-ALL.bat`(quick tunnel,網址會變)。
- 換模型:設環境變數 `OCR_MODEL`(例如 qwen2.5vl:7b 更快)。
