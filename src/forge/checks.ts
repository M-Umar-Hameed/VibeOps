import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "../relay/invoke.js";

export type CheckResult = { command: string; code: number; tail: string };

export const CHECK_TIMEOUT_MS = 5 * 60_000;
const TAIL_LINES = 100;
const MAX_CHECKS = 10;
const OUTPUT_CAP = 200_000;
const EXIT_DRAIN_MS = 2_000;

// forge.checks setting (JSON array of shell commands) wins; unset or invalid
// falls back to detection: package.json with a typecheck script in the sandbox
// -> ["npm run typecheck"], else []. Detected once per run, never persisted.
export function resolveChecks(setting: string | null, sandbox: string): string[] {
  if (setting !== null) {
    try {
      const parsed: unknown = JSON.parse(setting);
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) {
        return parsed.slice(0, MAX_CHECKS);
      }
    } catch { /* invalid JSON -> detection */ }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(sandbox, "package.json"), "utf-8"));
    if (pkg?.scripts?.typecheck) return ["npm run typecheck"];
  } catch { /* no package.json */ }
  return [];
}

export function tailLines(text: string, n = TAIL_LINES): string {
  return text.trimEnd().split(/\r?\n/).slice(-n).join("\n");
}

function runOne(
  command: string, cwd: string, timeoutMs: number,
  onSpawn?: (c: ChildProcess) => void,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    // shell:true — commands are operator-authored strings like "npm run typecheck".
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    onSpawn?.(child);
    let out = "";
    let timedOut = false;
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => { timedOut = true; void killTree(child); }, timeoutMs);
    const cap = (d: Buffer) => { if (out.length < OUTPUT_CAP) out += d.toString("utf-8"); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      if (timedOut) out += `\n[forge: check timed out after ${timeoutMs / 1000}s]`;
      resolve({ command, code, tail: tailLines(out) });
    };
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (e) => { out += String(e); finish(1); });
    // shell:true means the real command is a GRANDCHILD that inherits these pipes.
    // "close" waits for stdio EOF, so if it outlives the shell — which is exactly
    // what a killed hanging check looks like on POSIX — close never fires and this
    // promise never settles. Same defect, same fix as relay/invoke.ts: settle a
    // short drain after the process itself exits; close still wins the normal race.
    child.on("exit", (code) => {
      exitTimer = setTimeout(() => finish(code ?? 1), EXIT_DRAIN_MS);
      exitTimer.unref();
    });
  });
}

// Sequential by design (non-goal: parallel checks).
export async function runChecks(
  commands: string[], cwd: string, timeoutMs = CHECK_TIMEOUT_MS,
  onSpawn?: (c: ChildProcess) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) results.push(await runOne(command, cwd, timeoutMs, onSpawn));
  return results;
}

export function formatChecks(results: CheckResult[]): string {
  return results.map((r) => `$ ${r.command}\nexit ${r.code}\n${r.tail}`).join("\n\n");
}
