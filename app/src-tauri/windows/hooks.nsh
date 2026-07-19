!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToStack `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name node,VibeOps -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$LOCALAPPDATA\VibeOps\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
  Pop $1
!macroend
