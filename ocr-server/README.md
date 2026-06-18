# CardSnap 本機 GPU OCR 伺服器(給 5090)

用你自己的顯卡跑 **Qwen2.5-VL** 視覺模型,直接從名片圖辨識並擷取結構化欄位(姓名/公司/電話/統編…),準確度勝過雲端、零費用、資料不外流。手機拍照時透過 Cloudflare Tunnel 連回你的電腦。

```
手機(CardSnap, https) ─► Cloudflare Tunnel(https) ─► 本機 server.py(:8000) ─► Ollama + Qwen2.5-VL(5090)
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
雙擊 **run.bat**(自動建虛擬環境、裝套件、啟於 http://localhost:8000),視窗保持開著。
測試:瀏覽器開 http://localhost:8000/ 應看到 {"ok": true, ...}。

## 三、建立 Cloudflare Tunnel(手機要用就需要)
1. 下載 cloudflared:https://github.com/cloudflare/cloudflared/releases(Windows cloudflared.exe)
2. 另開視窗執行:
   ```
   cloudflared tunnel --url http://localhost:8000
   ```
3. 會給你一個網址如 https://abc-xyz.trycloudflare.com,複製它。
> 只在同一台桌機用、不用手機:可跳過此步,設定直接填 http://localhost:8000/ocr

## 四、把網址填進 CardSnap
CardSnap → 右上齒輪「設定」→「自訂辨識伺服器網址」填:
```
https://abc-xyz.trycloudflare.com/ocr
```
(結尾要有 /ocr)儲存。完成後拍名片會顯示「高精準辨識中(本機 GPU)」。
伺服器/通道沒開時,App 自動退回雲端或本機 Tesseract,不會壞。

## 備註
- trycloudflare.com 免費網址每次重開會變,變了就更新設定欄位;要固定網址可用具名 tunnel。
- 換模型/連別台 Ollama:設環境變數 OCR_MODEL、OLLAMA_URL 再啟動。
- 影像只在你的區網/通道內處理,不送第三方。
