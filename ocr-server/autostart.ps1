$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$set = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$set.ExecutionTimeLimit = 'PT0S'   # 不限時(伺服器長跑)
$prin = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$trig = New-ScheduledTaskTrigger -AtLogOn
$ocr  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $dir 'run.bat') + '"')
$tun  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c cloudflared tunnel run cardsnap-ocr'
Register-ScheduledTask -TaskName 'CardSnap OCR Server' -Action $ocr -Trigger $trig -Settings $set -Principal $prin -Force | Out-Null
Register-ScheduledTask -TaskName 'CardSnap Tunnel'     -Action $tun -Trigger $trig -Settings $set -Principal $prin -Force | Out-Null
Write-Host '[OK] 已建立排程:CardSnap OCR Server / CardSnap Tunnel(登入自動啟動 + 當機自動重啟)'
Start-ScheduledTask -TaskName 'CardSnap OCR Server'
Start-ScheduledTask -TaskName 'CardSnap Tunnel'
Write-Host '[OK] 已立即啟動兩者。'
