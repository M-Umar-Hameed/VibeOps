# Source of truth for the hidden VibeOps keep-alive watchdog the NSIS installer
# registers (POSTINSTALL embeds this base64-encoded). Keeps VibeOps always-on:
# a hidden wscript check every minute relaunches it --minimized if it died.
# Logon start is the app's own autostart Run key; this only handles crash-heal.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "VibeOps"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$vbs = @'
Set sh = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\.\root\cimv2")
If wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='VibeOps.exe'").Count = 0 Then
  sh.Run """" & sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\VibeOps\VibeOps.exe"" --minimized", 0, False
End If
'@
Set-Content -LiteralPath (Join-Path $dir "keepalive.vbs") -Value $vbs -Encoding ASCII
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ("//B //Nologo `"" + (Join-Path $dir "keepalive.vbs") + "`"")
# Repetition-only (no logon trigger): the Run-key autostart owns logon so the two
# never race into a duplicate launch. 1-minute poll heals a crash within ~60s.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "VibeOps" -Description "VibeOps crash-heal watchdog (hidden)." -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
