import { spawn } from "node:child_process";
import fs from "node:fs";
import { createClip } from "./output-budget.ts";
import type { ClipOptions, ClipStats } from "./output-budget.ts";
import { checkCommand } from "./firewall.ts";
import type { FirewallOptions } from "./firewall.ts";

export type RunOptions = { cwd: string; timeoutMs?: number; clip?: ClipOptions; env?: NodeJS.ProcessEnv; shell?: string[] };
export type RunResult = { command: string; exitCode: number | null; timedOut: boolean; blocked?: { rule: string; reason: string }; output: string; stats?: ClipStats; durationMs: number };

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

export function defaultShell(): string[] {
  if (process.platform === "win32") {
    return fs.existsSync(GIT_BASH) ? [GIT_BASH, "-c"] : [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c"];
  }
  return ["/bin/sh", "-c"];
}

const killTree = (pid: number | undefined) => {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else process.kill(-pid, "SIGKILL");
  } catch {}
};

export function runCommand(command: string, opts: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 600000;
  const shell = opts.shell ?? defaultShell();
  const clip = createClip(opts.clip);
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let exitTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    const verbatim = /(^|[\\/])cmd(\.exe)?$/i.test(shell[0]);
    const child = spawn(shell[0], [...shell.slice(1), verbatim ? `"${command}"` : command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      hardTimer = setTimeout(() => settle(null), 5000);
      hardTimer.unref();
    }, timeoutMs);
    const settle = (exitCode: number | null, errorText?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      clearTimeout(hardTimer);
      const { text, stats } = clip.finish();
      const tail = timedOut ? `\n[timed out after ${timeoutMs / 1000}s; process tree killed]` : `\n[exit ${exitCode}]`;
      resolve({
        command,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        output: errorText !== undefined ? `${text}${errorText}` : text + tail,
        stats,
        durationMs: Date.now() - t0,
      });
    };
    child.stdout.on("data", (c) => clip.push(c));
    child.stderr.on("data", (c) => clip.push(c));
    child.on("error", (e) => settle(null, `${e.message}`));
    child.on("exit", (code) => {
      // a grandchild can keep the pipes open after the shell exits
      exitTimer = setTimeout(() => {
        if (process.platform !== "win32") killTree(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        settle(code);
      }, 2000);
    });
    child.on("close", (code) => settle(code));
  });
}

export async function runGuarded(command: string, opts: RunOptions & { firewall: Omit<FirewallOptions, "cwd"> }): Promise<RunResult> {
  const t0 = Date.now();
  const v = checkCommand(command, { ...opts.firewall, cwd: opts.cwd });
  if (!v.allow) {
    return {
      command,
      exitCode: null,
      timedOut: false,
      blocked: { rule: v.rule, reason: v.reason },
      output: `[blocked by firewall: ${v.rule}] ${v.reason}`,
      durationMs: Date.now() - t0,
    };
  }
  return runCommand(command, opts);
}
