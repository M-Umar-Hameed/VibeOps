# Removes the keep-alive watchdog on uninstall (POSTUNINSTALL embeds this base64).
Unregister-ScheduledTask -TaskName "VibeOps" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA "VibeOps\keepalive.vbs") -Force -ErrorAction SilentlyContinue
