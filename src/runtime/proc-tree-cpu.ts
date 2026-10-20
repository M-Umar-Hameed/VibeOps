import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

type ProcEntry = { ppid: number; cpuMs: number };

function readLinuxProcTable(): Map<number, ProcEntry> | null {
  try {
    const entries = readdirSync("/proc");
    const table = new Map<number, ProcEntry>();
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf-8");
        const after = stat.slice(stat.lastIndexOf(")") + 2);
        const f = after.split(" ");
        const ppid = Number(f[1]);
        const utime = Number(f[11]);
        const stime = Number(f[12]);
        // ponytail: assumes CLK_TCK=100
        const cpuMs = (utime + stime) * 10;
        table.set(pid, { ppid, cpuMs });
      } catch {
        // process may have exited during scan
      }
    }
    return table;
  } catch {
    return null;
  }
}

function readWinProcTable(): Map<number, ProcEntry> | null {
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.UserModeTime + $_.KernelModeTime)" }',
      ],
      { encoding: "utf-8", windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const table = new Map<number, ProcEntry>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const rawCpu = Number(parts[2]);
      if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rawCpu)) {
        table.set(pid, { ppid, cpuMs: Math.round(rawCpu / 10_000) });
      }
    }
    return table;
  } catch {
    return null;
  }
}

function parsePsTime(timeStr: string): number {
  let days = 0;
  let rest = timeStr.trim();
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    days = parseInt(rest.slice(0, dash), 10) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":");
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
    seconds = parseFloat(parts[2]) || 0;
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10) || 0;
    seconds = parseFloat(parts[1]) || 0;
  } else if (parts.length === 1) {
    seconds = parseFloat(parts[0]) || 0;
  }
  return Math.round((days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000);
}

function readPsProcTable(): Map<number, ProcEntry> | null {
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf-8", windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const table = new Map<number, ProcEntry>();
    for (const line of r.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const cpuMs = parsePsTime(parts[2]);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) {
        table.set(pid, { ppid, cpuMs });
      }
    }
    return table;
  } catch {
    return null;
  }
}

function readProcTable(): Map<number, ProcEntry> | null {
  if (process.platform === "linux") return readLinuxProcTable();
  if (process.platform === "win32") return readWinProcTable();
  return readPsProcTable();
}

// ponytail: a grandchild whose parent died is re-parented and missed, and the reader does one process-table read per active run per sweep (batch these if many runs are ever active at once).
function readTreeCpuMsDefault(pid: number): number | null {
  try {
    const table = readProcTable();
    if (!table || !table.has(pid)) return null;

    const children = new Map<number, number[]>();
    for (const [procId, entry] of table) {
      const list = children.get(entry.ppid);
      if (list) list.push(procId);
      else children.set(entry.ppid, [procId]);
    }

    let totalCpu = 0;
    const queue = [pid];
    const visited = new Set<number>([pid]);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const entry = table.get(curr);
      if (entry) totalCpu += entry.cpuMs;
      const kids = children.get(curr);
      if (kids) {
        for (const kid of kids) {
          if (!visited.has(kid)) {
            visited.add(kid);
            queue.push(kid);
          }
        }
      }
    }
    return totalCpu;
  } catch {
    return null;
  }
}

export const treeCpuReader = { read: readTreeCpuMsDefault };
