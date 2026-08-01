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

# 外網是否通(TCP 443 到 1.1.1.1)。外網本來就斷的話不該亂重啟通道
function Test-Internet {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $ar = $c.BeginConnect('1.1.1.1', 443, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(4000, $false)
        if ($ok) { $c.EndConnect($ar) }
        $c.Close()
        return $ok
    } catch {
        return $false
    }
}

# --- 1. 本機 OCR 服務 ---
if (Test-EndpointTwice $LocalUrl) {
    $localOk = $true
} else {
    $localOk = $false
    Write-Log "本機服務無回應,重啟排程「$TaskServer」"
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
schtasks /end /tn "$TaskTunnel" 2>$null | Out-Null
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
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
