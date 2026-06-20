$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$set = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$set.ExecutionTimeLimit = 'PT0S'
$prin = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$trig = New-ScheduledTaskTrigger -AtLogOn
$ocr  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $dir 'run.bat') + '"')
$tun  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c cloudflared tunnel run cardsnap-ocr'
Register-ScheduledTask -TaskName 'CardSnap OCR Server' -Action $ocr -Trigger $trig -Settings $set -Principal $prin -Force | Out-Null
Register-ScheduledTask -TaskName 'CardSnap Tunnel'     -Action $tun -Trigger $trig -Settings $set -Principal $prin -Force | Out-Null
Write-Host '[OK] Scheduled tasks created: auto-start at logon + auto-restart on crash.'
Start-ScheduledTask -TaskName 'CardSnap OCR Server'
Start-ScheduledTask -TaskName 'CardSnap Tunnel'
Write-Host '[OK] Both tasks started now. OCR should be back online shortly.'
