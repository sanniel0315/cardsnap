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

## 六、同一台機器跑多條 tunnel 時的隔離(重要)

具名 tunnel 上正式環境後,很容易演變成「一台機器上跑好幾條互不相干的通道」。
預設裝法會讓它們共用資源,於是動一條就傷到另一條。**三個共用點都要拆開**:

| 共用點 | 為什麼會互相影響 | 做法 |
|---|---|---|
| 同一顆 `cloudflared.exe`(PATH 上那顆) | 執行中的 exe 被鎖住,**升級必須同時停掉所有通道** | 每條通道自己一份 exe,各放各的目錄 |
| 預設設定檔 `%USERPROFILE%\.cloudflared\config.yml` | 沒帶 `--config` 的通道都會讀到它 —— 也就是讀到別條的設定 | 每條 `--config` 指向自己的檔 |
| autoupdate(預設開啟) | 自動更新會**就地換掉正在執行的 exe 再自我重啟**,連帶換掉別條在用的那顆 | 每份 config 都寫 `no-autoupdate: true` |
| 憑證同放 `%USERPROFILE%\.cloudflared\` | 共用目錄=共用故障面,清理或重裝時容易誤傷另一條 | 憑證也搬進各自目錄,整個共用目錄退役 |

本專案的實際配置(這台機器另有一條無關的通道),**目錄內自足、不依賴 `%USERPROFILE%\.cloudflared\`**:

```
C:\cloudflared\cardsnap\
  cloudflared.exe                      ← 專屬 binary,升級只動這顆
  config.yml                           ← tunnel / origincert / credentials-file / no-autoupdate / ingress
  cert.pem                             ← origincert:`tunnel run <名稱>` 靠它把名稱解析成 UUID
  c3de357c-….json                      ← credentials-file:這條通道的憑證
```

`origincert` 與 `credentials-file` 一定要在 config 裡寫成絕對路徑 —— 不寫的話 cloudflared 會回頭
去找 `%USERPROFILE%\.cloudflared\`,隔離就破功了。

工作排程「CardSnap Tunnel」的動作:

```
cmd.exe /c C:\cloudflared\cardsnap\cloudflared.exe --config C:\cloudflared\cardsnap\config.yml tunnel run cardsnap-ocr
```

⚠ **路徑不要加引號。** 工作排程是把整串引數原字串交給 `cmd.exe`,而 cmd 在字串以引號開頭時
會砍掉頭尾各一個引號,把命令切壞(症狀:排程秒退、`LastTaskResult=1`、完全沒有 cloudflared 程序)。
上面兩個路徑刻意選在沒有空白的位置,就是為了不需要引號。

升級只動這條(另一條完全無感):

```powershell
Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "$env:TEMP\cf-new.exe"
schtasks /end /tn "CardSnap Tunnel"
Copy-Item "$env:TEMP\cf-new.exe" "C:\cloudflared\cardsnap\cloudflared.exe" -Force
schtasks /run /tn "CardSnap Tunnel"
```

因為裝在使用者可寫的目錄,這個流程**不需要系統管理員權限**。

### 要換 binary/路徑/設定又不能中斷服務

Cloudflare 允許同一條 tunnel 掛多個 connector,利用這點做滾動切換:

1. **先** `Disable-ScheduledTask` 停用 watchdog。否則它會在切換途中把你暫時起的 connector 當成
   異常殘留清掉(它認的是通道身分,不認是誰起的)。
2. 用新設定**另起**一條 connector(直接跑 `cloudflared.exe --config <新> tunnel run <名稱>`),
   確認 log 出現 `Registered tunnel connection`、對外端點正常 —— 此時新舊同時服務。
3. 停掉舊的那條,連續探測確認對外仍然正常。
4. 讓排程用新設定重新啟動,再收掉步驟 2 的暫時 connector。
5. 恢復 watchdog,並手動跑一次確認乾淨通過。

⚠ 強制終結(`Stop-Process -Force`)的 connector 不會向 edge 註銷,Cloudflare 可能還會往它送幾個
請求,實測會有 1~2 秒的 502 窗口。要完全無縫,就讓新 connector 多註冊一會兒再收舊的。

## 備註
- trycloudflare.com 免費網址每次重開會變,變了就更新設定欄位;要固定網址可用具名 tunnel。
- 換模型/連別台 Ollama:設環境變數 OCR_MODEL、OLLAMA_URL 再啟動。
- 影像只在你的區網/通道內處理,不送第三方。
