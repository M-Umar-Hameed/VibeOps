import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { mkdirSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { RelayAgent } from "./config.js";
import { pidAlive } from "../db/lifecycle.js";

const OUTPUT_CAP = 100_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_TIMEOUT_MS = 10_000;
const EXIT_DRAIN_MS = 2_000;
// How long the liveness poll waits for Node to reap a vanished child and report
// its exit status before declaring failure. Generous: a wrong "failed" on a
// successful run is worse than settling a truly-lost child a second later.
const EXIT_REAP_GRACE_MS = 5_000;

export type AgentResult = { ok: boolean; output: string; usage?: { tokens: number; cost: number } };

// Pure: only replaces placeholders present as keys in `vars`; anything else
// in the cmd array passes through untouched.
export function substituteCmd(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) =>
    Object.entries(vars).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), part),
  );
}

// Resolves only once the process has actually exited, so callers can await
// termination before deleting files the tree still holds open (Windows EPERM).
// Bound lives HERE, in the kill path: a process that refuses to die logs and
// releases the awaiter instead of hanging the run forever. Common case resolves
// on the "exit" event, not the timer — the deadline is not a disguised sleep.
export function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  // Already dead: "exit" will never fire again, so awaiting it would hang.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      console.warn(`forge: killTree pid ${child.pid} did not exit within ${KILL_TIMEOUT_MS}ms`);
      done();
    }, KILL_TIMEOUT_MS);
    timer.unref();
    child.once("exit", done);
  });
}

// Kills an adopted process tree by PID (used when reattached runs have no ChildProcess handle).
// Confirms death by polling pidAlive rather than waiting for an exit event that will never fire.
export async function killPidTree(pid: number, timeoutMs = KILL_TIMEOUT_MS): Promise<void> {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  const start = Date.now();
  while (pidAlive(pid)) {
    if (Date.now() - start > timeoutMs) {
      console.warn(`forge: killPidTree pid ${pid} did not exit within ${timeoutMs}ms`);
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function runAgent(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
  onSpawn?: (child: ChildProcess) => void,
  logPath?: string,
): Promise<AgentResult> {
  const promptFile = join(tmpdir(), `vibeops-relay-${randomUUID()}.txt`);
  const needsFile = agent.cmd.some((p) => p.includes("{promptFile}"));
  // No placeholder at all -> deliver the prompt on stdin. Windows argv tops out
  // near 32k; long prompts (review diffs) die with ENAMETOOLONG as {prompt}.
  const viaStdin = !needsFile && !agent.cmd.some((p) => p.includes("{prompt}"));

  const [cmd0, ...rest] = substituteCmd(agent.cmd, { prompt, promptFile, workdir });

  // Merge agent.env over the inherited process env; only {workdir} is substituted.
  // {prompt}/{promptFile} intentionally excluded (secrets/size). ponytail: {model}
  // in env unsupported here — model isn't in scope; thread it via resolveCmd if a
  // provider ever needs model-dependent env tokens.
  let childEnv: NodeJS.ProcessEnv | undefined;
  if (agent.env) {
    const keys = Object.keys(agent.env);
    const vals = substituteCmd(Object.values(agent.env), { workdir });
    childEnv = { ...process.env };
    keys.forEach((k, i) => { childEnv![k] = vals[i]; });
  }
  // forge stages routinely idle >5 min between plan and work, so the 1h cache
  // window is the one that matters. Only meaningful under API-key auth; a no-op
  // noise var under subscription auth, so set it only when ANTHROPIC_API_KEY is set.
  if (process.env.ANTHROPIC_API_KEY) {
    childEnv = { ...(childEnv ?? process.env), ENABLE_PROMPT_CACHING_1H: "1" };
  }

  // S2-A2: with a run logPath, the stage child writes stdout+stderr straight to
  // that file (fd stdio) and is spawned detached+unref'd, so an API restart
  // orphans neither the OS process nor its output; live output is tailed from the
  // file instead of read from a pipe. outFd is opened append so sequential stages
  // share one file; readFd + tailStart bound the tail to THIS stage's new bytes.
  // Without a logPath (unit callers) the original piped path runs unchanged.
  // ponytail: the log file is written raw — redaction still happens downstream in
  // append()/res.output before any DB/comment storage; redacting the file at rest
  // is the reattach/security ticket's job, not this one.
  let outFd: number | undefined;
  let readFd: number | undefined;
  let tailStart = 0;
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    outFd = openSync(logPath, "a");
    readFd = openSync(logPath, "r");
    tailStart = fstatSync(outFd).size;
  }

  try {
    // Written inside try so the finally unlinks it on every exit path (spawn
    // throw, agent failure, timeout/kill), never only the happy return.
    if (needsFile) await writeFile(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });
    return await new Promise((resolve) => {
      // stdin ignored unless piping the prompt: headless CLIs (codex exec)
      // otherwise block reading an open stdin.
      const child = outFd !== undefined
        ? spawn(cmd0, rest, { cwd: workdir, env: childEnv, stdio: [viaStdin ? "pipe" : "ignore", outFd, outFd], detached: true, windowsHide: true })
        : spawn(cmd0, rest, { cwd: workdir, env: childEnv, stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"] });
      // Detached child must not keep the parent's event loop alive; the run still
      // awaits its exit via the listeners below (unref drops only the keep-alive
      // ref, not the handlers). This is what lets an API restart leave the child
      // running for the reattach ticket to pick up.
      if (outFd !== undefined) child.unref();
      onSpawn?.(child);
      if (viaStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.write(prompt);
        child.stdin?.end();
      }
      let output = "";
      let settled = false;
      let exitTimer: NodeJS.Timeout | undefined;
      let pollTimer: NodeJS.Timeout | undefined;
      let tailPos = tailStart;

      const timer = setTimeout(() => { void killTree(child); }, agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const push = (s: string) => {
        if (output.length < OUTPUT_CAP) output += s;
        onData?.(s);
      };

      // Read only the bytes appended since tailPos. readSync at an explicit
      // position keeps no shared cursor; drainTail() also runs once at settle so a
      // fast-exiting child's final bytes are never lost to poll timing.
      const drainTail = () => {
        if (readFd === undefined) return;
        const size = fstatSync(readFd).size;
        if (size <= tailPos) return;
        const buf = Buffer.allocUnsafe(size - tailPos);
        const n = readSync(readFd, buf, 0, size - tailPos, tailPos);
        tailPos += n;
        push(buf.toString("utf-8", 0, n));
      };

      if (outFd !== undefined) {
        // fd-to-file stdio has no pipe, so a detached child can exit without its
        // close/exit events ever reaching this handle — the run then sits
        // "running" forever (incident 6e3dcc32: agy finished at 07:14, the run
        // hung 6.6h). Poll OS liveness as the backstop settle.
        //
        // But liveness alone must NOT decide ok/failed: pidAlive can see the
        // process gone before Node reaps it and populates exitCode, and settling
        // on a null exitCode reports a SUCCESSFUL run as failed. So once the pid
        // is gone, wait for the real status, and only give up after a grace
        // period — a run whose status never arrives is a genuine failure.
        let goneAt = 0;
        pollTimer = setInterval(() => {
          drainTail();
          const cpid = child.pid;
          if (cpid !== undefined && pidAlive(cpid)) return;
          if (child.exitCode !== null || child.signalCode !== null) {
            finish(child.exitCode === 0);
            return;
          }
          if (goneAt === 0) { goneAt = Date.now(); return; }
          if (Date.now() - goneAt >= EXIT_REAP_GRACE_MS) finish(false);
        }, 100);
        pollTimer.unref();
      } else {
        const capture = (chunk: Buffer) => push(chunk.toString("utf-8"));
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
      }

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitTimer) clearTimeout(exitTimer);
        if (pollTimer) clearInterval(pollTimer);
        drainTail();
        resolve({ ok, output: output.slice(0, OUTPUT_CAP) });
      };
      child.on("close", (code) => finish(code === 0));
      child.on("error", () => finish(false));
      // "close" waits for stdio EOF, which never comes if a descendant inherited
      // our stdout/stderr pipe and outlived the direct child (live incident: agy
      // exec's subprocess held the pipe, the run sat "running" past its timeout
      // while killTree no-oped on the already-exited child). Settle a short drain
      // after the process itself exits so a wedged pipe can't hang the run; the
      // drain lets any final buffered output flush first, and "close" (normal
      // case) still wins the race and clears this timer. With fd-to-file stdio
      // there is no pipe to wedge, but the same exit-settle keeps behaviour
      // identical and still captures late bytes via drainTail().
      child.on("exit", (code) => {
        exitTimer = setTimeout(() => finish(code === 0), EXIT_DRAIN_MS);
        exitTimer.unref();
      });
    });
  } finally {
    if (readFd !== undefined) closeSync(readFd);
    if (outFd !== undefined) closeSync(outFd);
    if (needsFile) await unlink(promptFile).catch(() => {});
  }
}
