// Proves the cmd child is attached to the agent's console, so the console process list contains the agent pid.
import { execFileSync } from "node:child_process";

const ps = `
$ProgressPreference = 'SilentlyContinue'
$sig = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint GetConsoleProcessList(uint[] processList, uint processCount);
[DllImport("kernel32.dll")]
public static extern IntPtr GetConsoleWindow();
'@
Add-Type -MemberDefinition $sig -Name "WinConsole" -Namespace "Win32"
$arr = [uint32[]]::new(64)
$c = [Win32.WinConsole]::GetConsoleProcessList($arr, 64)
$h = [Win32.WinConsole]::GetConsoleWindow()
$p = if ($c -gt 0) { ($arr[0..([int]$c - 1)]) -join ',' } else { '' }
Write-Output "list=$p hwnd=$h"
`.trim();

const enc = Buffer.from(ps, "utf16le").toString("base64");
const cmdLine = `"echo child-ok & powershell -NoProfile -NonInteractive -EncodedCommand ${enc}"`;

const out = execFileSync("cmd.exe", ["/d", "/s", "/c", cmdLine], {
  encoding: "utf-8",
  windowsVerbatimArguments: true,
});

process.stdout.write(`agent=${process.pid}\n${out}`);
process.exit(0);
