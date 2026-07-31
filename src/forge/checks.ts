import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "../relay/invoke.js";

export type CheckResult = { command: string; code: number; tail: string };

export const CHECK_TIMEOUT_MS = 5 * 60_000;
const TAIL_LINES = 100;
const MAX_CHECKS = 10;
const OUTPUT_CAP = 200_000;

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
    // shell: enabled — commands are operator-authored strings like "npm run typecheck".
    const child = spawn(command, { cwd, shell: !!1, stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(child);
    let out = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const cap = (d: Buffer) => { if (out.length < OUTPUT_CAP) out += d.toString("utf-8"); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) out += `\n[forge: check timed out after ${timeoutMs / 1000}s]`;
      resolve({ command, code, tail: tailLines(out) });
    };
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", (e) => { out += String(e); finish(1); });
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
