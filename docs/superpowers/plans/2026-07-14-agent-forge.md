# Agent Forge (Phase 17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** UI-driven plan/work/review pipeline: pick a model per role, run a ticket through agents in a git-worktree sandbox, watch narration live, and Promote/Discard after a passing review.

**Architecture:** New `src/forge/` module inside the sidecar. Reuses `src/relay/` prompts, invoke, and config. Sandbox = git worktree at `~/.vibeops/sandbox/<ticketId>` on branch `forge/<ticketId>`, created off the relay `workdir`. Run manager holds in-memory runs; UI polls `GET /forge/runs/:id/output?after=N`. Review PASS leaves the ticket in `review` with the sandbox kept; `POST /forge/tickets/:id/promote` merges and closes.

**Tech Stack:** Node 22, Hono, Drizzle, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-agent-forge-design.md` — read it first.

## Global Constraints

- Agent command templates live ONLY in `~/.vibeops/relay.json`; `/forge/agents` returns names+roles only; no route ever echoes `cmd`.
- All spawns arg-vector (`spawn(cmd0, rest)`), stdin `"ignore"`. Never `shell: true`.
- Every `/forge/*` route: `requireAdmin`.
- Forge never pushes to any remote.
- Suite must stay deterministic: run `npx vitest run` twice before declaring a task done if it touched tests.
- Rank-based ANN assertions are forbidden (membership or direct row checks only) — not expected in this phase, stated for completeness.
- App API facade `app/src/lib/api.ts` returns the body DIRECTLY — never `.data`.
- Windows dev box: paths via `node:path.join`, no `/tmp` literals.

---

### Task 1: Output secret redaction

**Files:**
- Create: `src/forge/redact.ts`
- Test: `tests/forge-redact.test.ts`

**Interfaces:**
- Produces: `redactSecrets(chunk: string): string` — pure, used by Task 4 on every captured chunk.

- [ ] **Step 1: Write the failing test**

```ts
// tests/forge-redact.test.ts
import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/forge/redact.js";

describe("redactSecrets", () => {
  it("redacts common key shapes", () => {
    expect(redactSecrets("key sk-abcdefghij0123456789 ok")).toBe("key [redacted] ok");
    expect(redactSecrets("voyage pa-AbCd_efgh-ij0123456789")).toBe("voyage [redacted]");
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y")).toBe(
      "Authorization: [redacted]",
    );
    expect(redactSecrets('{"apiKey":"supersecretvalue123"}')).toBe('{"apiKey":"[redacted]"}');
  });
  it("leaves ordinary text alone", () => {
    const s = "git diff --stat shows 3 files, task passed";
    expect(redactSecrets(s)).toBe(s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/forge-redact.test.ts`
Expected: FAIL — cannot find module `src/forge/redact.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/forge/redact.ts
// Best-effort, per-chunk: a key split across a chunk boundary can slip through.
// Defense in depth only — forge never puts secrets into prompts to begin with.
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bpa-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
const KEY_FIELD = /("(?:apiKey|api_key|token|secret)"\s*:\s*")[^"]+(")/gi;

export function redactSecrets(chunk: string): string {
  let out = chunk;
  for (const p of PATTERNS) out = out.replace(p, "[redacted]");
  return out.replace(KEY_FIELD, "$1[redacted]$2");
}
```

Note: `Authorization: Bearer <jwt>` → `Authorization: [redacted]` because the Bearer pattern consumes `Bearer <token>`. The test above encodes the exact expected strings — match them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/forge-redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/forge/redact.ts tests/forge-redact.test.ts
git commit -m "feat(forge): output secret redaction"
```

---

### Task 2: Streaming capture in runAgent

**Files:**
- Modify: `src/relay/invoke.ts` (runAgent signature)
- Test: `tests/relay-unit.test.ts` (add one test to the existing file)

**Interfaces:**
- Produces: `runAgent(agent: RelayAgent, prompt: string, workdir: string, onData?: (chunk: string) => void): Promise<{ ok: boolean; output: string }>` — 4th param optional; existing callers (relay runner) unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/relay-unit.test.ts` (it already imports from `../src/relay/invoke.js` and uses `tests/fixtures/fake-agent.mjs`; follow the existing test style in that file for constructing the fake agent — it builds a RelayAgent whose cmd is `[process.execPath, "tests/fixtures/fake-agent.mjs", "{prompt}"]` with `FAKE_MODE` set via env... NOTE: fake-agent reads FAKE_MODE from env, and `runAgent` does not pass env. Look at how existing invoke tests in this file set `process.env.FAKE_MODE` before calling and restore after — do the same):

```ts
it("runAgent streams chunks to onData as they arrive", async () => {
  process.env.FAKE_MODE = "plan";
  const chunks: string[] = [];
  const agent = { cmd: [process.execPath, "tests/fixtures/fake-agent.mjs", "{prompt}"], roles: ["plan"] };
  const res = await runAgent(agent, "hi", process.cwd(), (c) => chunks.push(c));
  expect(res.ok).toBe(true);
  expect(chunks.join("")).toContain("do the thing");
  expect(res.output).toContain("do the thing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/relay-unit.test.ts`
Expected: FAIL — onData never called / TS error (runAgent takes 3 args).

- [ ] **Step 3: Implement**

In `src/relay/invoke.ts`, change the signature and the capture closure:

```ts
export async function runAgent(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
): Promise<{ ok: boolean; output: string }> {
```

and inside, extend `capture`:

```ts
      const capture = (chunk: Buffer) => {
        const s = chunk.toString("utf-8");
        if (output.length < OUTPUT_CAP) output += s;
        onData?.(s);
      };
```

Nothing else changes. Existing 3-arg callers compile untouched.

- [ ] **Step 4: Run the relay suites**

Run: `npx vitest run tests/relay-unit.test.ts tests/relay-pipeline.test.ts tests/relay-workflow.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/relay/invoke.ts tests/relay-unit.test.ts
git commit -m "feat(relay): optional onData streaming callback in runAgent"
```

---

### Task 3: Sandbox worktree lifecycle

**Files:**
- Create: `src/forge/sandbox.ts`
- Modify: `tests/fixtures/fake-agent.mjs` (add FAKE_WRITE mode, used by Task 4)
- Test: `tests/forge-sandbox.test.ts`

**Interfaces:**
- Produces (all exported from `src/forge/sandbox.ts`):
  - `assertTicketId(id: string): void` — throws `Error` unless `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
  - `sandboxPath(ticketId: string): string` — `join(homedir(), ".vibeops", "sandbox", ticketId)`, overridable root via `process.env.VIBEOPS_SANDBOX_ROOT` (tests need this; production never sets it).
  - `sandboxExists(ticketId: string): boolean`
  - `ensureSandbox(workdir: string, ticketId: string): Promise<string>` — returns the sandbox path.
  - `forgeCommit(ticketId: string, title: string): Promise<boolean>` — stage+commit everything in the sandbox; false when nothing changed.
  - `sandboxDiff(workdir: string, ticketId: string): Promise<string>` — merge-base diff `git diff HEAD...forge/<id>`, capped 150_000.
  - `promoteSandbox(workdir: string, ticketId: string): Promise<void>` — throws `ConflictError` (from `src/services/errors.js`) on dirty workdir or merge conflict.
  - `discardSandbox(workdir: string, ticketId: string): Promise<void>`

- [ ] **Step 1: Extend the fake agent fixture**

In `tests/fixtures/fake-agent.mjs`, after the OUTPUTS lookup and before printing, add:

```js
if (process.env.FAKE_WRITE) {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(process.cwd(), "forge-made.txt"), "made by fake agent\n");
}
```

(The file is ESM — top-level await is fine.)

- [ ] **Step 2: Write the failing tests**

```ts
// tests/forge-sandbox.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertTicketId, sandboxPath, sandboxExists, ensureSandbox,
  forgeCommit, sandboxDiff, promoteSandbox, discardSandbox,
} from "../src/forge/sandbox.js";
import { ConflictError } from "../src/services/errors.js";

const TID = "11111111-2222-3333-4444-555555555555";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

let workdir: string;
let sandboxRoot: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "forge-base-"));
  sandboxRoot = mkdtempSync(join(tmpdir(), "forge-sbx-"));
  process.env.VIBEOPS_SANDBOX_ROOT = sandboxRoot;
  git(workdir, "init", "-b", "main");
  git(workdir, "config", "user.email", "t@t");
  git(workdir, "config", "user.name", "t");
  writeFileSync(join(workdir, "a.txt"), "hello\n");
  git(workdir, "add", "-A");
  git(workdir, "commit", "-m", "base");
});

afterEach(() => {
  delete process.env.VIBEOPS_SANDBOX_ROOT;
  rmSync(workdir, { recursive: true, force: true });
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("forge sandbox", () => {
  it("rejects non-uuid ticket ids", () => {
    expect(() => assertTicketId("../../etc")).toThrow();
    expect(() => assertTicketId(TID)).not.toThrow();
  });

  it("create -> edit -> commit -> diff -> promote merges and cleans up", async () => {
    const sp = await ensureSandbox(workdir, TID);
    expect(sp).toBe(sandboxPath(TID));
    writeFileSync(join(sp, "b.txt"), "new file\n");
    expect(await forgeCommit(TID, "add b")).toBe(true);
    const diff = await sandboxDiff(workdir, TID);
    expect(diff).toContain("b.txt");
    expect(diff).toContain("+new file");
    await promoteSandbox(workdir, TID);
    expect(existsSync(join(workdir, "b.txt"))).toBe(true);
    expect(sandboxExists(TID)).toBe(false);
    expect(git(workdir, "branch", "--list", `forge/${TID}`).trim()).toBe("");
  });

  it("forgeCommit returns false when nothing changed", async () => {
    await ensureSandbox(workdir, TID);
    expect(await forgeCommit(TID, "noop")).toBe(false);
  });

  it("ensureSandbox reuses an existing tree (rework keeps state)", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "wip.txt"), "wip\n");
    const again = await ensureSandbox(workdir, TID);
    expect(again).toBe(sp);
    expect(existsSync(join(sp, "wip.txt"))).toBe(true);
  });

  it("promote refuses a dirty workdir", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    writeFileSync(join(workdir, "a.txt"), "dirty\n");
    await expect(promoteSandbox(workdir, TID)).rejects.toThrow(ConflictError);
    expect(sandboxExists(TID)).toBe(true); // sandbox survives refusal
  });

  it("promote aborts cleanly on merge conflict, sandbox kept", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "a.txt"), "sandbox version\n");
    await forgeCommit(TID, "conflict");
    writeFileSync(join(workdir, "a.txt"), "base version\n");
    git(workdir, "add", "-A");
    git(workdir, "commit", "-m", "diverge");
    await expect(promoteSandbox(workdir, TID)).rejects.toThrow(ConflictError);
    expect(git(workdir, "status", "--porcelain").trim()).toBe(""); // merge aborted
    expect(sandboxExists(TID)).toBe(true);
  });

  it("discard removes tree and branch, base repo untouched", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "x\n");
    await forgeCommit(TID, "b");
    await discardSandbox(workdir, TID);
    expect(sandboxExists(TID)).toBe(false);
    expect(git(workdir, "branch", "--list", `forge/${TID}`).trim()).toBe("");
    expect(existsSync(join(workdir, "b.txt"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/forge-sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/forge/sandbox.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConflictError } from "../services/errors.js";

const DIFF_CAP = 150_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTicketId(id: string): void {
  if (!UUID.test(id)) throw new Error(`invalid ticket id "${id}"`);
}

function sandboxRoot(): string {
  return process.env.VIBEOPS_SANDBOX_ROOT ?? join(homedir(), ".vibeops", "sandbox");
}

export function sandboxPath(ticketId: string): string {
  assertTicketId(ticketId);
  return join(sandboxRoot(), ticketId);
}

export function branchName(ticketId: string): string {
  assertTicketId(ticketId);
  return `forge/${ticketId}`;
}

export function sandboxExists(ticketId: string): boolean {
  return existsSync(sandboxPath(ticketId));
}

// Arg-vector git, never shell. Returns code+combined output; callers decide what's fatal.
function git(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (d: Buffer) => { if (out.length < DIFF_CAP) out += d.toString("utf-8"); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.slice(0, DIFF_CAP) }));
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
  });
}

async function must(cwd: string, ...args: string[]): Promise<string> {
  const { code, out } = await git(cwd, ...args);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${out.trim()}`);
  return out;
}

export async function ensureSandbox(workdir: string, ticketId: string): Promise<string> {
  const path = sandboxPath(ticketId);
  if (existsSync(path)) return path; // rework continues in the same tree
  const branch = branchName(ticketId);
  // Branch may survive a removed worktree (e.g. manual cleanup): attach, else create.
  const attach = await git(workdir, "worktree", "add", path, branch);
  if (attach.code !== 0) await must(workdir, "worktree", "add", path, "-b", branch);
  return path;
}

export async function forgeCommit(ticketId: string, title: string): Promise<boolean> {
  const path = sandboxPath(ticketId);
  await must(path, "add", "-A");
  const { out } = await git(path, "status", "--porcelain");
  if (!out.trim()) return false;
  await must(path, "-c", "user.email=forge@vibeops.local", "-c", "user.name=VibeOps Forge",
    "commit", "-m", `forge: ${title}`);
  return true;
}

export async function sandboxDiff(workdir: string, ticketId: string): Promise<string> {
  const { out } = await git(workdir, "diff", `HEAD...${branchName(ticketId)}`);
  return out.slice(0, DIFF_CAP);
}

export async function promoteSandbox(workdir: string, ticketId: string): Promise<void> {
  const dirty = await git(workdir, "status", "--porcelain");
  if (dirty.out.trim()) {
    throw new ConflictError("workdir has uncommitted changes; commit or stash before promoting");
  }
  const merge = await git(workdir, "merge", "--no-ff", branchName(ticketId),
    "-m", `forge: promote ${ticketId}`);
  if (merge.code !== 0) {
    await git(workdir, "merge", "--abort");
    throw new ConflictError(`merge failed: ${merge.out.trim().slice(0, 500)}`);
  }
  await cleanup(workdir, ticketId);
}

export async function discardSandbox(workdir: string, ticketId: string): Promise<void> {
  await cleanup(workdir, ticketId);
}

async function cleanup(workdir: string, ticketId: string): Promise<void> {
  await git(workdir, "worktree", "remove", "--force", sandboxPath(ticketId));
  await git(workdir, "branch", "-D", branchName(ticketId));
  await git(workdir, "worktree", "prune");
}
```

Check `src/services/errors.ts` for ConflictError's constructor signature before using it — match how existing services construct it.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/forge-sandbox.test.ts`
Expected: all 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/forge/sandbox.ts tests/forge-sandbox.test.ts tests/fixtures/fake-agent.mjs
git commit -m "feat(forge): git-worktree sandbox lifecycle"
```

---

### Task 4: Run manager + pipeline

**Files:**
- Create: `src/forge/runs.ts`
- Test: `tests/forge-runs.test.ts`

**Interfaces:**
- Consumes: `runAgent(agent, prompt, workdir, onData?)` (Task 2); sandbox functions (Task 3); `redactSecrets` (Task 1); `composePlanPrompt/composeWorkPrompt/composeReviewPrompt/parseVerdict` from `src/relay/prompts.js`; `updateTicket` from `src/services/tickets.js`; `addComment` from `src/services/comments.js`; `getTicket` from `src/services/history.js`; `listComments` from `src/services/comments.js`; `searchKnowledge` from `src/services/knowledge.js`; `RelayConfig` type from `src/relay/config.js`.
- Produces:
  - `type RunSummary = { id: string; ticketId: string; stage: "plan" | "work" | "review"; status: "running" | "passed" | "failed" | "stopped"; agents: { plan: string; work: string; review: string }; startedAt: string; finishedAt?: string }`
  - `startPipeline(actorId: string, config: RelayConfig, opts: { ticketId: string; planAgent: string; workAgent: string; reviewAgent: string; extraPrompt?: string }): Promise<{ runId: string }>` — validates and starts; resolves once the run is registered (pipeline continues in background). Throws `ConflictError` for: active run on ticket, ≥3 active runs, ticket not in `open`/`planned` status. Throws `Error` for unknown agent / role mismatch / extraPrompt > 10_000 chars.
  - `listRuns(): RunSummary[]` (newest first, finished runs trimmed to last 20)
  - `getRunOutput(id: string, after: number): { chunk: string; next: number; stage: string; status: string } | undefined`
  - `stopRun(id: string): boolean`
  - `awaitRun(id: string): Promise<void>` — resolves when the pipeline settles (TEST HOOK; routes never call it)

- [ ] **Step 1: Write the failing tests**

The DB-backed tests follow the existing integration style (see `tests/relay-pipeline.test.ts` for how project/actor/ticket fixtures are created — reuse the same helpers/patterns from that file, including how it builds a RelayConfig pointing at `tests/fixtures/fake-agent.mjs` and sets `FAKE_MODE`). Structure:

```ts
// tests/forge-runs.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startPipeline, listRuns, getRunOutput, awaitRun } from "../src/forge/runs.js";
import { sandboxExists } from "../src/forge/sandbox.js";
import { getTicket } from "../src/services/history.js";
import { listComments } from "../src/services/comments.js";
import type { RelayConfig } from "../src/relay/config.js";
// + the fixture helpers this suite copies from relay-pipeline.test.ts:
//   createProject/createActor/createTicket service calls to make a real ticket.

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-run-base-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "readme.md"), "base\n");
  g("add", "-A");
  g("commit", "-m", "base");
  return dir;
}

const FAKE = (mode: string) => ({
  cmd: [process.execPath, "tests/fixtures/fake-agent.mjs", "{prompt}"],
  roles: ["plan", "work", "review"],
});
// FAKE_MODE / FAKE_WRITE are process-level env; set per stage is impossible with
// one env, so the fake agent is driven by FAKE_SCRIPT: a comma list consumed
// left-to-right via a counter file (see Step 2 fixture change).
```

**Fixture change needed:** one pipeline spawns the fake agent three times (plan, work, review) with different desired outputs. Extend `tests/fixtures/fake-agent.mjs`: if `FAKE_SCRIPT` is set (e.g. `"plan,work,review-pass"`), read+increment a counter in the file `process.env.FAKE_COUNTER_FILE`, and use the mode at that index (clamped to last). `FAKE_WRITE` applies only when the selected mode is `work`. Keep existing `FAKE_MODE` behavior when `FAKE_SCRIPT` unset.

Tests to write (each creates its own project/actor/ticket and its own temp repo + `VIBEOPS_SANDBOX_ROOT`, and cleans up in afterEach):

1. **happy path, PASS leaves ticket in review awaiting promote**: ticket status `open`; `FAKE_SCRIPT="plan,work,review-pass"`, `FAKE_WRITE=1`; `startPipeline` → `awaitRun`. Assert: run status `passed`; ticket status `review`; comments contain one `plan`, one `report`, one `review` (kinds); review comment body contains `VERDICT: PASS`; `sandboxExists(ticketId)` true; output from `getRunOutput(id, 0)` contains `=== FORGE plan` and `=== FORGE work` and `=== FORGE review` markers.
2. **FAIL verdict bounces to planned, sandbox kept**: `FAKE_SCRIPT="plan,work,review-fail"`. Run status reflects pipeline EXECUTION, not the verdict — the verdict lives in the review comment and the ticket status. Assert: run status `"passed"` (pipeline ran to completion), ticket status `planned`, sandbox kept.
3. **worker process failure bounces to planned**: `FAKE_SCRIPT="plan,exit"` — add an `exit` mode to the fixture that prints `boom` and exits 1. Assert: run status `failed`; ticket status `planned`; a `report` comment containing `worker failed`.
4. **second pipeline on same ticket → ConflictError** while first is running: use a `slow` fixture mode (add to fixture: sleeps 2000ms via `await new Promise(r=>setTimeout(r,2000))` then prints plan output). Start one, immediately expect `startPipeline` same ticket to reject with ConflictError. Then `awaitRun` the first.
5. **planned ticket skips the plan stage**: ticket seeded with a `plan` comment and status `planned`; `FAKE_SCRIPT="work,review-pass"`. Assert output has no `=== FORGE plan` marker and exactly one new `plan`-kind comment total (the seeded one).
6. **output polling with offset**: after a finished run, `getRunOutput(id, 0)` returns full text and `next` = length; `getRunOutput(id, next)` returns empty chunk, same `next`.
7. **redaction applied**: fixture mode `leaky` printing `token sk-abcdefghij0123456789` → output contains `[redacted]`, not the key.

- [ ] **Step 2: Extend the fixture** (FAKE_SCRIPT + counter file + `exit`, `slow`, `leaky` modes) as described above. Keep it under ~60 lines.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/forge-runs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/forge/runs.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { RelayConfig, RelayAgent } from "../relay/config.js";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict } from "../relay/prompts.js";
import { runAgent } from "../relay/invoke.js";
import { redactSecrets } from "./redact.js";
import { ensureSandbox, forgeCommit, sandboxDiff } from "./sandbox.js";
import { updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket } from "../services/history.js";
import { searchKnowledge } from "../services/knowledge.js";
import { ConflictError } from "../services/errors.js";

const OUTPUT_CAP = 400_000;
const MAX_ACTIVE = 3;
const KEEP_FINISHED = 20;
const MAX_EXTRA_PROMPT = 10_000;

const NARRATION =
  "\n\nNarrate your reasoning out loud as you work: before each step, print what " +
  "you are about to do and why. Your narration is read live by the supervisor " +
  "and by the reviewing model.";

type Stage = "plan" | "work" | "review";
type Status = "running" | "passed" | "failed" | "stopped";

type Run = {
  id: string; ticketId: string; stage: Stage; status: Status;
  agents: { plan: string; work: string; review: string };
  output: string; startedAt: string; finishedAt?: string;
  child?: ChildProcess; // unused v1 (stop kills via flag); reserved
  stopped: boolean;
  done: Promise<void>;
};

const runs = new Map<string, Run>();

export type RunSummary = Omit<Run, "output" | "child" | "stopped" | "done">;

function summarize(r: Run): RunSummary {
  const { output, child, stopped, done, ...rest } = r;
  void output; void child; void stopped; void done;
  return rest;
}

function append(run: Run, text: string): void {
  if (run.output.length < OUTPUT_CAP) run.output += redactSecrets(text);
}

function activeRuns(): Run[] {
  return [...runs.values()].filter((r) => r.status === "running");
}

function getAgent(config: RelayConfig, name: string, role: Stage): RelayAgent {
  const a = config.agents[name];
  if (!a) throw new Error(`relay config has no agent "${name}"`);
  if (!a.roles.includes(role)) throw new Error(`agent "${name}" is not configured for role "${role}"`);
  return a;
}

export async function startPipeline(
  actorId: string, config: RelayConfig,
  opts: { ticketId: string; planAgent: string; workAgent: string; reviewAgent: string; extraPrompt?: string },
): Promise<{ runId: string }> {
  if ((opts.extraPrompt ?? "").length > MAX_EXTRA_PROMPT) throw new Error("extraPrompt too long");
  const agents = {
    plan: getAgent(config, opts.planAgent, "plan"),
    work: getAgent(config, opts.workAgent, "work"),
    review: getAgent(config, opts.reviewAgent, "review"),
  };
  if (activeRuns().some((r) => r.ticketId === opts.ticketId)) {
    throw new ConflictError(`ticket ${opts.ticketId} already has an active run`);
  }
  if (activeRuns().length >= MAX_ACTIVE) throw new ConflictError("too many active runs");

  const ticket = await getTicket(opts.ticketId);
  if (ticket.status !== "open" && ticket.status !== "planned") {
    throw new ConflictError(`ticket is ${ticket.status}; pipeline needs open or planned`);
  }

  const run: Run = {
    id: randomUUID(), ticketId: opts.ticketId, stage: "plan", status: "running",
    agents: { plan: opts.planAgent, work: opts.workAgent, review: opts.reviewAgent },
    output: "", startedAt: new Date().toISOString(), stopped: false,
    done: Promise.resolve(),
  };
  runs.set(run.id, run);
  trim();
  run.done = pipeline(run, actorId, config, agents, opts.extraPrompt).catch((e) => {
    append(run, `\nforge: pipeline error: ${(e as Error).message}\n`);
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
  });
  return { runId: run.id };
}

async function pipeline(
  run: Run, actorId: string, config: RelayConfig,
  agents: { plan: RelayAgent; work: RelayAgent; review: RelayAgent }, extraPrompt?: string,
): Promise<void> {
  const extra = extraPrompt ? `\n\nOperator instructions:\n${extraPrompt}` : "";
  const onData = (c: string) => append(run, c);
  let ticket = await getTicket(run.ticketId);

  // plan
  let plan: string;
  if (ticket.status === "open") {
    append(run, `=== FORGE plan (${run.agents.plan}) ===\n`);
    const knowledge = await getKnowledgeSafe(ticket.title);
    const res = await runAgent(agents.plan, composePlanPrompt({ ticket, knowledge }) + extra, config.workdir, onData);
    if (run.stopped) return settle(run, "stopped");
    if (!res.ok) { await bounce(run, actorId, "planner failed", res.output); return settle(run, "failed"); }
    await addComment(actorId, ticket.id, res.output, "plan");
    ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
    plan = res.output;
  } else {
    const prior = [...(await listComments(ticket.id))].reverse().find((c) => c.kind === "plan");
    plan = prior?.body ?? "";
  }

  // work — claim, then run inside the sandbox
  run.stage = "work";
  append(run, `\n=== FORGE work (${run.agents.work}) ===\n`);
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "in_progress" });
  const sandbox = await ensureSandbox(config.workdir, ticket.id);
  const knowledge = await getKnowledgeSafe(ticket.title);
  const workPrompt = composeWorkPrompt({ ticket, plan, knowledge, workdir: sandbox })
    + NARRATION + "\n\nDo NOT run git commit; the supervisor commits for you." + extra;
  const workRes = await runAgent(agents.work, workPrompt, sandbox, onData);
  if (run.stopped) { await bounce(run, actorId, "run stopped", ""); return settle(run, "stopped"); }
  if (!workRes.ok) { await bounce(run, actorId, "worker failed", workRes.output); return settle(run, "failed"); }
  await forgeCommit(ticket.id, ticket.title);
  await addComment(actorId, ticket.id, workRes.output, "report");
  ticket = await updateTicket(actorId, ticket.id, ticket.version, { status: "review" });

  // review — against the sandbox branch diff
  run.stage = "review";
  append(run, `\n=== FORGE review (${run.agents.review}) ===\n`);
  const diff = await sandboxDiff(config.workdir, ticket.id);
  const reviewRes = await runAgent(
    agents.review,
    composeReviewPrompt({ ticket, plan, report: workRes.output, diff }),
    config.workdir, onData,
  );
  if (run.stopped) return settle(run, "stopped");
  const verdict = parseVerdict(reviewRes.output);
  await addComment(actorId, ticket.id, verdict.raw, "review");
  if (!verdict.pass) {
    // FAIL: back to planned; sandbox kept for the rework pass.
    await updateTicket(actorId, ticket.id, ticket.version, { status: "planned" });
  }
  // PASS: ticket STAYS in review — promotion is a human action.
  settle(run, "passed");
}

function settle(run: Run, status: Status): void {
  run.status = status;
  run.finishedAt = new Date().toISOString();
}

async function bounce(run: Run, actorId: string, why: string, output: string): Promise<void> {
  try {
    const t = await getTicket(run.ticketId);
    await addComment(actorId, t.id, `forge: ${why}\n\n${output.slice(0, 20_000)}`, "report");
    if (t.status === "in_progress") await updateTicket(actorId, t.id, t.version, { status: "planned" });
  } catch { /* never mask the original failure */ }
}

async function getKnowledgeSafe(q: string): Promise<{ content: string; citation: string }[]> {
  try { return await searchKnowledge(q, { limit: 5 }); } catch { return []; }
}

function trim(): void {
  const finished = [...runs.values()].filter((r) => r.status !== "running")
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  for (const r of finished.slice(KEEP_FINISHED)) runs.delete(r.id);
}

export function listRuns(): RunSummary[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(summarize);
}

export function getRunOutput(id: string, after: number) {
  const r = runs.get(id);
  if (!r) return undefined;
  const from = Math.max(0, Math.min(after, r.output.length));
  return { chunk: r.output.slice(from), next: r.output.length, stage: r.stage, status: r.status };
}

export function stopRun(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status !== "running") return false;
  r.stopped = true; // checked between stages; the in-flight agent finishes or times out
  return true;
}

export function awaitRun(id: string): Promise<void> {
  return runs.get(id)?.done ?? Promise.resolve();
}
```

**Known v1 limitation to note in a code comment on `stopRun`:** stop is cooperative between stages; it does not kill the in-flight CLI (that dies at its own `timeoutMs`). If the reviewer flags it as Important, wire the current ChildProcess through runAgent — but do not build it preemptively.

**Check services first:** `getTicket` lives in `src/services/history.ts` — verify its exact export/signature and what it throws for missing tickets before wiring. Also verify `searchKnowledge`'s return type field names (`citation` exists — see `src/services/knowledge.ts:102`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/forge-runs.test.ts` then the whole relay set to prove no regression: `npx vitest run tests/relay-unit.test.ts tests/relay-pipeline.test.ts tests/relay-workflow.test.ts`
Expected: all PASS. Run forge-runs twice — must be deterministic.

- [ ] **Step 6: Commit**

```bash
git add src/forge/runs.ts tests/forge-runs.test.ts tests/fixtures/fake-agent.mjs
git commit -m "feat(forge): run manager — plan/work/review pipeline in sandbox"
```

---

### Task 5: Forge routes + skills listing + authz

**Files:**
- Create: `src/api/forge-routes.ts`
- Modify: `src/api/app.ts` (one import + one register call, mirroring `registerMcpRoutes`)
- Test: `tests/forge-api.test.ts`; Modify: `tests/authz.test.ts` (add /forge coverage)

**Interfaces:**
- Consumes: everything from Tasks 3-4; `loadRelayConfig` from `src/relay/config.js` (path override via `process.env.VIBEOPS_RELAY_CONFIG` — tests point it at a temp relay.json whose agent is the fake fixture); `requireAdmin` from `./auth.js`; `updateTicket`, `getTicket`, `listComments`.
- Produces: `registerForgeRoutes(app: Hono<{ Variables: { actor: Actor } }>): void` and these routes (ALL `requireAdmin`):
  - `GET /forge/agents` → `[{ name, roles }]`
  - `GET /forge/skills` → `[{ name }]` — dir names under `~/.claude/skills` and `<workdir>/.claude/skills`, deduped, never-throw readdir.
  - `POST /forge/pipeline` body `{ ticketId, planAgent, workAgent, reviewAgent, extraPrompt? }` → 201 `{ runId }`; 400 on missing fields/unknown agent; 409 via ConflictError bubbling to app.onError.
  - `GET /forge/runs` → RunSummary[]
  - `GET /forge/runs/:id/output?after=N` → 404 unknown; else `{ chunk, next, stage, status }`
  - `POST /forge/runs/:id/stop` → `{ stopped: boolean }`
  - `GET /forge/tickets/:id/sandbox` → `{ exists, branch, lastVerdict: "pass" | "fail" | null }` (lastVerdict = parseVerdict of newest review comment, null if none)
  - `GET /forge/tickets/:id/diff` → 404 if no sandbox; else `{ diff }`
  - `POST /forge/tickets/:id/promote` → requires sandbox + lastVerdict pass (else 409); merges, closes ticket (status closed via updateTicket with fresh version), audit comment `forge: promoted`, returns updated ticket.
  - `POST /forge/tickets/:id/discard` → requires sandbox (else 404); discards, ticket → planned if it was review, audit comment `forge: sandbox discarded`, returns updated ticket.

Config loading: `function forgeConfig() { return loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG); }` — call per request (cheap file read; picks up edits without restart).

- [ ] **Step 1: Write failing tests** — `tests/forge-api.test.ts` follows the existing API-test style (see `tests/knowledge-api.test.ts` / `tests/relay-workflow.test.ts` for how the app is built with `app.request(...)` and how admin/member actors + keys are minted). Cover: agents list has names+roles and NEVER a `cmd` key (assert `JSON.stringify(body)` does not contain `"cmd"`); pipeline happy path end-to-end with the fake relay.json + temp git repo (reuse Task 4's fixture approach; poll `GET .../output` until status !== "running" with a 30s guard instead of importing awaitRun — this exercises the real polling path); promote flow (after PASS → promote → ticket closed, sandbox gone); promote without PASS → 409; discard → ticket planned; output 404 on unknown run id; skills endpoint returns an array (create a fake skills dir inside the temp workdir `.claude/skills/my-skill/` and assert `my-skill` present).
- [ ] **Step 2: Add to `tests/authz.test.ts`:** member key gets 403 on `GET /forge/agents`, `POST /forge/pipeline`, `GET /forge/runs`, `POST /forge/tickets/<uuid>/promote` (follow the file's existing member-403 table pattern).
- [ ] **Step 3: Run both to verify failure.** `npx vitest run tests/forge-api.test.ts tests/authz.test.ts`
- [ ] **Step 4: Implement `src/api/forge-routes.ts`** (routes as specced; `import { readdirSync } from "node:fs"` for skills with try/catch per root; promote/discard call sandbox fns then updateTicket with a freshly fetched version). Register in `app.ts` next to `registerMcpRoutes(app)`.
- [ ] **Step 5: Run:** `npx vitest run tests/forge-api.test.ts tests/authz.test.ts` — PASS. Then `npx tsc --noEmit` — clean.
- [ ] **Step 6: Commit**

```bash
git add src/api/forge-routes.ts src/api/app.ts tests/forge-api.test.ts tests/authz.test.ts
git commit -m "feat(forge): admin-gated forge API — pipeline, output polling, promote/discard, skills"
```

---

### Task 6: Forge UI (gemini dogfood through the relay)

This task is executed by the CONTROLLER (main session), not a subagent: it dogfoods VibeOps itself. Steps:

- [ ] Create a `vibeops` project ticket per component in the running VibeOps instance, each body a full brief (screen layout from the spec §Frontend, the api facade rule, existing component idioms — reference `app/src/routes/knowledge.tsx` and `app/src/components/settings/ActorsCard.tsx` as style anchors):
  1. `app/src/routes/forge.tsx` — screen: ticket list by status (left), run panel (right): agent dropdowns from `/forge/agents`, operator prompt textarea with `/`-triggered skill autocomplete from `/forge/skills`, Run pipeline → `POST /forge/pipeline`, console polling `GET /forge/runs/:id/output?after=` every 1s while status running, diff viewer from `/forge/tickets/:id/diff`, Stop/Promote/Discard buttons gated by `/forge/tickets/:id/sandbox`.
  2. Route + nav registration: `app/src/main.tsx` route `/forge`, Sidebar entry "Forge".
  3. Tests `app/src/routes/forge.test.tsx` mocking `apiFetch` like the existing route tests.
- [ ] Preferred worker: gemini (`npx @google/gemini-cli -p` in relay.json, roles ["work"]) — BLOCKED until the user completes one interactive `gemini` login. If still blocked when this task starts, fall back to codex per the owner's "Approved, build it" choice.
- [ ] Run: `npm run relay -- --role work --agent <gemini|codex> --ticket <id>` per ticket — from Phase 17 code onward, prefer running these through the forge pipeline itself once Tasks 1-5 are merged (self-hosting proof).
- [ ] Controller reviews each diff (spec + quality gates, the `res.data` trap, dead-control honesty rule), fixes or bounces, then commits.
- [ ] Verify: `cd app && npx vitest run && npx tsc --noEmit && npm run build`.

---

### Task 7: Phase close

- [ ] Full root suite twice: `npx vitest run` x2 — identical green results.
- [ ] App suite: `cd app && npx vitest run`.
- [ ] `npx tsc --noEmit` in root and app.
- [ ] Live smoke: boot sidecar, run one real pipeline on a throwaway ticket with codex plan/work/review; verify sandbox created, narration streams via the output endpoint, promote merges.
- [ ] Opus whole-phase review (diff since `fc771e0`), fix wave, re-review to zero Critical/Important.
- [ ] Update `.superpowers/sdd/progress.md` + cross-session memory + README relay section (mention Forge UI).
