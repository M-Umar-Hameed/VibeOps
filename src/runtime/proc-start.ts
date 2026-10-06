import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Reads a LIVE process's OS start time to confirm the pid is still OUR agent
// child and not an unrelated, recycled pid (which necessarily has a different
// start time). Cross-platform: Linux reads /proc/<pid>/stat field 22 (a plain
// file read); Windows reads StartTime.Ticks via PowerShell; macOS/others shell
// `ps -o lstart=`. Returns null wherever the value can't be read (dead/unreadable
// pid) -> caller treats as unverifiable -> interrupt. The SAME reader runs at
// spawn and at boot, so the platform's string compares by equality.
function readLinuxStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // comm (field 2) is parenthesised and may hold spaces/parens; start after the
    // LAST ')'. starttime (field 22) is then index 19 of the remaining fields.
    const after = stat.slice(stat.lastIndexOf(")") + 2);
    return after.split(" ")[19] || null;
  } catch {
    return null;
  }
}
function readPsLstart(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", windowsHide: true });
  const out = r.stdout?.trim();
  return out ? out : null;
}
function readWinStart(pid: number): string | null {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.Ticks`], { encoding: "utf-8", windowsHide: true });
  const out = r.stdout?.trim();
  return out && /^\d+$/.test(out) ? out : null;
}
function readProcStartTimeDefault(pid: number): string | null {
  if (process.platform === "linux") return readLinuxStart(pid);
  if (process.platform === "win32") return readWinStart(pid);
  return readPsLstart(pid);
}

// Injectable start-time reader for testing; production reads the real OS start
// time, tests substitute a controllable stub to exercise match/mismatch on every
// platform. Exported as an object so the .read property is mutable in tests.
export const startTimeReader = { read: readProcStartTimeDefault };
