# CardSnap 本機 GPU OCR 伺服器(給 5090)

用你自己的顯卡跑 **Qwen2.5-VL** 視覺模型,直接從名片圖辨識並擷取結構化欄位(姓名/公司/電話/統編…),準確度勝過雲端、零費用、資料不外流。手機拍照時透過 Cloudflare Tunnel 連回你的電腦。

```
手機(CardSnap, https) ─► Cloudflare Tunnel(https) ─► 本機 server.py(:8765) ─► Ollama + Qwen2.5-VL(5090)
```

## 一、安裝 Ollama 與模型
1. 下載安裝 Ollama:https://ollama.com/download(Windows 版)
2. 開 PowerShell/CMD 下載視覺模型:
   ```
   ollama pull qwen2.5vl:7b
   ```
   - 想更快:`qwen2.5vl:3b`;想更準:`qwen2.5vl:32b`(5090 32GB 跑得動)。
   - 抓不到該名稱時的替代:`ollama pull minicpm-v`,啟動前設 `set OCR_MODEL=minicpm-v`。

## 二、啟動本機 OCR 伺服器
雙擊 **run.bat**(自動建虛擬環境、裝套件、啟於 http://localhost:8765),視窗保持開著。
測試:瀏覽器開 http://localhost:8765/ 應看到 {"ok": true, ...}。

## 三、建立 Cloudflare Tunnel(手機要用就需要)
1. 下載 cloudflared:https://github.com/cloudflare/cloudflared/releases(Windows cloudflared.exe)
2. 另開視窗執行:
   ```
   cloudflared tunnel --url http://localhost:8765
   ```
3. 會給你一個網址如 https://abc-xyz.trycloudflare.com,複製它。
> 只在同一台桌機用、不用手機:可跳過此步,設定直接填 http://localhost:8765/ocr

## 四、把網址填進 CardSnap
CardSnap → 右上齒輪「設定」→「自訂辨識伺服器網址」填:
```
https://abc-xyz.trycloudflare.com/ocr
```
(結尾要有 /ocr)儲存。完成後拍名片會顯示「高精準辨識中(本機 GPU)」。
伺服器/通道沒開時,App 自動退回雲端或本機 Tesseract,不會壞。

## 五、看門狗(避免通道半夜自己斷掉)
用工作排程長期跑伺服器與具名 tunnel 時,cloudflared 中途死掉不會自動復活(排程若只設「登入時」觸發,要等下次登入才會起來,對外會一直回 **530**)。

`watchdog.ps1` 解決這件事:每次執行會檢查本機 `http://127.0.0.1:8765/` 與對外端點,任一掛掉就重啟對應的工作排程。連兩次失敗才動作,並且會先確認外網是否正常,ISP 斷線時不會誤重啟。

註冊成每 5 分鐘跑一次(PowerShell,一般權限即可):
```powershell
$xmlArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\ocr-server\watchdog.ps1"'
# 需 TimeTrigger + Repetition PT5M(不設 Duration = 無限重複)、MultipleInstancesPolicy=IgnoreNew
```
排程名稱預設為「CardSnap Watchdog」;它操作的排程名稱寫在腳本開頭的 `$TaskServer` / `$TaskTunnel`,與你實際的排程名稱要一致。
日誌:`%LOCALAPPDATA%\cardsnap\watchdog.log`(只記事件,正常時不寫)。

## 備註
- trycloudflare.com 免費網址每次重開會變,變了就更新設定欄位;要固定網址可用具名 tunnel。
- 換模型/連別台 Ollama:設環境變數 OCR_MODEL、OLLAMA_URL 再啟動。
- 影像只在你的區網/通道內處理,不送第三方。
