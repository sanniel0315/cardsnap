# CardSnap OCR 看門狗
#
# 每次執行會做兩件事:
#   1. 檢查本機 OCR 服務 http://127.0.0.1:8765/ -> 掛了就重啟排程「CardSnap OCR Server」
#   2. 檢查對外端點 https://ocr.name-car-box.com/ -> 掛了就重啟排程「CardSnap Tunnel」
#
# 由排程「CardSnap Watchdog」每 5 分鐘呼叫一次。日誌在 %LOCALAPPDATA%\cardsnap\watchdog.log。
# 手動測試:powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$LocalUrl  = 'http://127.0.0.1:8765/'
$PublicUrl = 'https://ocr.name-car-box.com/'
$TaskServer = 'CardSnap OCR Server'
$TaskTunnel = 'CardSnap Tunnel'
# 通道身分:重啟通道時用來精準比對「本通道」的孤兒 cloudflared。
# 這台同時跑著鄰居 stockdesk-home,兩條通道不可以互相影響。
$TunnelName    = 'cardsnap-ocr'   # 本通道名(cloudflared tunnel run 命令列會帶)
$TunnelId      = 'c3de357c'       # 本通道 UUID 前綴(改用 config/credentials 執行時命令列帶的是 UUID)
# ⚠ 這裡原本填鄰居的 UUID 前綴 '0024ebee',那是無效的:鄰居走 --token,命令列上只有
#   base64 字串,UUID 不會以明文出現(實測比對永遠 false)。真正在保護鄰居的是下面
#   Stop-TunnelOrphan 的正向條件「命令列必須含本通道名或 UUID」。改用鄰居的專屬
#   路徑當 guard,才真的有第二道防線。
$NeighborGuard = 'stockdesk'      # 鄰居的 binary 與 config 都在 C:\cloudflared\stockdesk\,絕不誤殺

$LogDir  = Join-Path $env:LOCALAPPDATA 'cardsnap'
$LogFile = Join-Path $LogDir 'watchdog.log'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    # 日誌超過 1MB 就輪替一份,避免無限長大
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
        Move-Item $LogFile "$LogFile.1" -Force
    }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
}

# 打一次 URL,200 才算活著
function Test-Endpoint([string]$url, [int]$timeoutSec = 12) {
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec $timeoutSec -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# 連兩次都失敗才判定為掛掉,避開偶發抖動
function Test-EndpointTwice([string]$url) {
    if (Test-Endpoint $url) { return $true }
    Start-Sleep -Seconds 10
    return (Test-Endpoint $url)
}

# 清掉孤兒化的「本通道」cloudflared。
# schtasks /end 只殺 powershell launcher,底下 cloudflared 會孤兒化;不清的話 schtasks /run 會再拉一條 → 兩條 cardsnap-ocr。
# 只按命令列比對本通道(名或 UUID),且硬性跳過含鄰居 token 的行程;絕不照 process 名(cloudflared.exe)砍,免得殺到 stockdesk。
function Stop-TunnelOrphan {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            $cl = $p.CommandLine
            if (-not $cl) { continue }
            if ($cl -match [regex]::Escape($NeighborGuard)) { continue }   # 鄰居 stockdesk,永遠不碰
            if (($cl -match [regex]::Escape($TunnelName)) -or ($cl -match [regex]::Escape($TunnelId))) {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                Write-Log "已清掉孤兒 cardsnap-ocr cloudflared PID $($p.ProcessId)"
            }
        }
    } catch {}
}

# 強制結束占用某 port 的行程。
# 服務「凍死」時 port 仍 LISTENING,新 uvicorn 綁不上就會靜靜死掉 → schtasks /run 變空轉。
# 重啟前一定要先把占 port 的舊行程清掉。
function Stop-PortOwner([int]$port) {
    try {
        $owners = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess |
                  Sort-Object -Unique
        foreach ($procId in $owners) {
            if ($procId) {
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                Write-Log "已強制結束占用 $port 的舊行程 PID $procId"
            }
        }
    } catch {}
}

# 外網是否通。外網本來就斷的話不該亂重啟通道。
# 注意:單用 1.1.1.1:443 會被部分台灣 ISP/路由器擋 → 永遠 false → 誤鎖通道分支(曾空轉兩小時)。
# 改成:多個公共 DNS 的 443 任一通即算通;全失敗再退一步用正常 DNS+HTTPS 抓公開頁(涵蓋「只擋裸 IP、放行網域」的網路)。
function Test-Internet {
    foreach ($addr in @('1.1.1.1', '8.8.8.8', '9.9.9.9')) {
        try {
            $c = New-Object Net.Sockets.TcpClient
            $ar = $c.BeginConnect($addr, 443, $null, $null)
            $ok = $ar.AsyncWaitHandle.WaitOne(3000, $false)
            if ($ok) { $c.EndConnect($ar); $c.Close(); return $true }
            $c.Close()
        } catch {}
    }
    try {
        $null = Invoke-WebRequest -Uri 'https://www.cloudflare.com/cdn-cgi/trace' -TimeoutSec 5 -UseBasicParsing
        return $true
    } catch {}
    return $false
}

# --- 1. 本機 OCR 服務 ---
if (Test-EndpointTwice $LocalUrl) {
    $localOk = $true
} else {
    $localOk = $false
    Write-Log "本機服務無回應,先結束舊排程+清掉占 8765 的凍死行程,再重啟排程「$TaskServer」"
    schtasks /end /tn "$TaskServer" 2>$null | Out-Null   # 先終結排程自己的 process tree
    Stop-PortOwner 8765                                   # 再補殺任何仍占著 8765 的孤兒行程
    Start-Sleep -Seconds 2
    schtasks /run /tn "$TaskServer" | Out-Null
    Start-Sleep -Seconds 25
    if (Test-Endpoint $LocalUrl 20) {
        $localOk = $true
        Write-Log "本機服務已恢復"
    } else {
        Write-Log "本機服務重啟後仍無回應(模型載入可能較慢,下輪再看)"
    }
}

# --- 2. Cloudflare 通道 ---
# 本機服務沒起來時,通道就算重開對外一樣是 502,先跳過等下一輪
if (-not $localOk) {
    Write-Log "本機服務未就緒,本輪略過通道檢查"
    return
}

if (Test-EndpointTwice $PublicUrl) { return }

if (-not (Test-Internet)) {
    Write-Log "對外端點無回應,但本機外網也不通 -> 判定為網路問題,不重啟通道"
    return
}

Write-Log "對外端點無回應(本機正常、外網正常)-> 重啟排程「$TaskTunnel」"
# 只用 schtasks /end(它只終結該排程自己的 process tree)。
# 絕對不要用 Stop-Process -Name cloudflared:這台機器同時跑著另一條無關的 tunnel
# (stockdesk-home → api.stockdesk.dev),照名字砍會把它一起殺掉。
schtasks /end /tn "$TaskTunnel" 2>$null | Out-Null
Start-Sleep -Seconds 2
Stop-TunnelOrphan            # /end 只殺 launcher,先清掉孤兒 cloudflared,否則 /run 會又拉一條變兩條
Start-Sleep -Seconds 1
schtasks /run /tn "$TaskTunnel" | Out-Null

# 通道建立需要一點時間,最多等 60 秒
$recovered = $false
for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Seconds 10
    if (Test-Endpoint $PublicUrl) { $recovered = $true; break }
}
if ($recovered) {
    Write-Log "通道已恢復"
} else {
    Write-Log "通道重啟後仍無回應,下輪再試"
}
