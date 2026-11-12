import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCommand } from "./run.ts";
import type { ClipOptions } from "./output-budget.ts";

export type StepResult = { done?: boolean } | void;
export type HaltAlert = {
  kind: "verify-loop-halted"; repo: string; reason: string; attempts: number; consecutiveFailures: number;
  baseline: string; headBefore: string; stash: string | null; rollbackOk: boolean; rollbackError?: string; lastOutput: string; at: string;
};
export type LoopOptions = {
  repo: string;
  testCommand: string;
  step: (feedback: string | null, attempt: number) => Promise<StepResult>;
  maxConsecutiveFailures?: number;
  maxSteps?: number;
  testTimeoutMs?: number;
  clip?: ClipOptions;
  shell?: string[];
  alert?: (a: HaltAlert) => void | Promise<void>;
};
export type LoopResult =
  | { status: "passed"; attempts: number }
  | { status: "refused"; reason: string }
  | { status: "halted"; attempts: number; alert: HaltAlert };

const execFileP = promisify(execFile);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function defaultAlert(a: HaltAlert): Promise<void> {
  process.stderr.write(JSON.stringify(a) + "\n");
  const hook = process.env.VERIFY_ALERT_WEBHOOK;
  if (!hook) return;
  try {
    const res = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a), signal: AbortSignal.timeout(5000) });
    if (!res.ok) process.stderr.write(`alert webhook returned ${res.status}\n`);
  } catch (e) {
    process.stderr.write(`alert webhook failed: ${msg(e)}\n`);
  }
}

export async function verifyLoop(o: LoopOptions): Promise<LoopResult> {
  const git = async (...args: string[]) =>
    (await execFileP("git", ["-C", o.repo, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  const maxFail = o.maxConsecutiveFailures ?? 3;
  const maxSteps = o.maxSteps ?? 25;

  let baseline: string;
  try {
    await git("rev-parse", "--show-toplevel");
  } catch {
    return { status: "refused", reason: "not a git repository" };
  }
  let branch = "";
  try {
    baseline = await git("rev-parse", "HEAD");
    branch = await git("symbolic-ref", "-q", "--short", "HEAD").catch(() => "");
  } catch {
    return { status: "refused", reason: "repository has no commits" };
  }
  try {
    if ((await git("status", "--porcelain")) !== "") {
      return { status: "refused", reason: "working tree has uncommitted changes; refusing to start because a rollback would destroy them" };
    }
  } catch (e) {
    return { status: "refused", reason: `cannot read git status: ${msg(e)}` };
  }

  let consecutive = 0;
  let feedback: string | null = null;
  let attempts = 0;
  let reason = `max steps (${maxSteps}) reached`;
  for (let attempt = 1; attempt <= maxSteps; attempt++) {
    attempts = attempt;
    let res: StepResult = undefined;
    let stepFailed = false;
    try {
      res = await o.step(feedback, attempt);
    } catch (e) {
      stepFailed = true;
      feedback = "agent step failed: " + msg(e);
    }
    if (!stepFailed) {
      const t = await runCommand(o.testCommand, { cwd: o.repo, timeoutMs: o.testTimeoutMs, clip: o.clip, shell: o.shell })
        .catch((e) => ({ exitCode: null, timedOut: false, output: "test run failed: " + msg(e) }));
      if (t.exitCode === 0 && !t.timedOut) {
        consecutive = 0;
        feedback = null;
        if (!res || res.done !== false) return { status: "passed", attempts: attempt };
        continue;
      }
      feedback = t.output;
    }
    consecutive++;
    if (consecutive >= maxFail) {
      reason = `${consecutive} consecutive failed verification runs`;
      break;
    }
  }

  let headBefore = baseline;
  let stash: string | null = null;
  let rollbackOk = true;
  let rollbackError: string | undefined;
  try {
    headBefore = await git("rev-parse", "HEAD");
    const top = () => git("rev-parse", "-q", "--verify", "refs/stash").catch(() => "");
    const prev = await top();
    await git("stash", "push", "--include-untracked", "-m", `verify-loop rollback ${new Date().toISOString()}`);
    const now = await top();
    stash = now && now !== prev ? now : null;
    await git("checkout", "-q", branch || baseline);
    if ((await git("rev-parse", "HEAD")) !== baseline) await git("reset", "--hard", baseline);
    const left = await git("status", "--porcelain");
    if (left !== "") {
      rollbackOk = false;
      rollbackError = `working tree not clean after rollback:\n${left}`;
    }
  } catch (e) {
    rollbackOk = false;
    rollbackError = msg(e);
  }
  const alert: HaltAlert = {
    kind: "verify-loop-halted", repo: o.repo, reason, attempts, consecutiveFailures: consecutive,
    baseline, headBefore, stash, rollbackOk, ...(rollbackError !== undefined ? { rollbackError } : {}),
    lastOutput: feedback ?? "", at: new Date().toISOString(),
  };
  try {
    await (o.alert ?? defaultAlert)(alert);
  } catch (e) {
    process.stderr.write(`alert failed: ${msg(e)}\n`);
  }
  return { status: "halted", attempts, alert };
}
