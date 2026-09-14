# Read-only Stage Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forge plan, forge review and explain-diff run their agent in a throwaway read-only git worktree instead of the real project folder; claude-sdk role checkboxes are shown but locked to work.

**Architecture:** One helper, `withReadOnlyView`, in `src/forge/sandbox.ts` creates a detached worktree under `<sandboxRoot>/views/`, runs a callback in it, reports changed files via `git status --porcelain`, and always removes it. Plan (ref `HEAD`), review and explain-diff (ref `forge/<ticketId>`) call it. The manual cleanup sweep deletes views older than 24 hours.

**Tech Stack:** TypeScript, Node 22, git worktrees, Vitest; React 19 + Testing Library for the UI task.

**Spec:** docs/superpowers/specs/2026-09-14-read-only-stage-views-design.md

## Global Constraints

- Views live at `<sandboxRoot>/views/<ticketId>-<stage>-<8 hex>`; `stage` is one of `plan`, `review`, `explain`.
- Views never get deps links; never call `linkDeps` for a view.
- Plan stray edits: run log line `[forge: planner changed files in its read-only copy; discarded: <comma-separated paths>]`, run continues.
- Review stray edits: `bounce(run, actorId, "reviewer changed files in its read-only copy", <newline-separated paths>)` then `settle(run, "failed")`.
- Explain-diff stray edits: ignored.
- Sweep deletes `views/*` entries whose mtime is older than 24 hours.
- claude-sdk hover text, exact: `The SDK lane runs the work stage only`.
- Minimal comments, no emojis, no em dashes. Commit messages carry no co-author or AI attribution lines. Never push.
- UI changes follow docs/UI_GUIDELINES.md.
- Server tests run on the embedded lane from the repo root (PowerShell): `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs <test files>`. App tests: `cd app; npx vitest run <file>`.

---

### Task 1: `withReadOnlyView` helper

**Files:**
- Modify: `src/forge/sandbox.ts` (imports at top; new code after `ensureSandbox`, which ends at line 203)
- Test: `tests/forge-sandbox.test.ts`

**Interfaces:**
- Produces: `export type ViewStage = "plan" | "review" | "explain";`, `export function viewsRoot(): string`, `export async function withReadOnlyView<T>(workdir: string, ticketId: string, stage: ViewStage, ref: string, fn: (viewPath: string) => Promise<T>): Promise<{ result: T; strayPaths: string[] }>`

- [ ] **Step 1: Write the failing tests**

In `tests/forge-sandbox.test.ts`, add `withReadOnlyView` to the import list from `"../src/forge/sandbox.js"`. Append at the end of the file:

```ts
describe("withReadOnlyView", () => {
  it("checks out the ref, reports nothing when untouched, and removes the view", async () => {
    let seen = "";
    const { result, strayPaths } = await withReadOnlyView(workdir, TID, "plan", "HEAD", async (p) => {
      seen = p;
      return readFileSync(join(p, "a.txt"), "utf-8");
    });
    expect(result).toBe("hello\n");
    expect(strayPaths).toEqual([]);
    expect(seen.startsWith(join(sandboxRoot, "views"))).toBe(true);
    expect(existsSync(seen)).toBe(false);
    expect(git(workdir, "worktree", "list")).not.toContain("views");
  });

  it("reports files the callback wrote, leaves the base repo untouched, and removes the view", async () => {
    let seen = "";
    const { strayPaths } = await withReadOnlyView(workdir, TID, "review", "HEAD", async (p) => {
      seen = p;
      writeFileSync(join(p, "a.txt"), "changed\n");
      writeFileSync(join(p, "new.txt"), "x\n");
    });
    expect([...strayPaths].sort()).toEqual(["a.txt", "new.txt"]);
    expect(existsSync(seen)).toBe(false);
    expect(readFileSync(join(workdir, "a.txt"), "utf-8")).toBe("hello\n");
  });

  it("checks out a forge branch ref", async () => {
    const sp = await ensureSandbox(workdir, TID);
    writeFileSync(join(sp, "b.txt"), "work\n");
    await forgeCommit(TID, "work");
    const { result } = await withReadOnlyView(workdir, TID, "review", branchName(TID), async (p) => existsSync(join(p, "b.txt")));
    expect(result).toBe(true);
  });

  it("gives two views of the same ticket and stage different paths", async () => {
    const paths: string[] = [];
    await withReadOnlyView(workdir, TID, "explain", "HEAD", async (p) => { paths.push(p); });
    await withReadOnlyView(workdir, TID, "explain", "HEAD", async (p) => { paths.push(p); });
    expect(paths[0]).not.toBe(paths[1]);
  });

  it("removes the view when the callback throws", async () => {
    let seen = "";
    await expect(withReadOnlyView(workdir, TID, "plan", "HEAD", async (p) => {
      seen = p;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });

  it("does not link node_modules into the view", async () => {
    const linked = await withReadOnlyView(workdir, TID, "plan", "HEAD", async (p) => existsSync(join(p, "node_modules")));
    expect(linked.result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-sandbox.test.ts`
Expected: FAIL, `withReadOnlyView` is not exported.

- [ ] **Step 3: Implement**

In `src/forge/sandbox.ts` add to the imports: `import { randomBytes } from "node:crypto";` (`mkdirSync` and `rmSync` are already imported from `node:fs`). Insert directly after `ensureSandbox`:

```ts
export type ViewStage = "plan" | "review" | "explain";

export function viewsRoot(): string {
  return join(sandboxRoot(), "views");
}

// Throwaway detached checkout for stages that must only READ code. Removing it
// is what discards any edits; no deps links, so the recursive delete cannot
// traverse into the base repo.
export async function withReadOnlyView<T>(
  workdir: string, ticketId: string, stage: ViewStage, ref: string,
  fn: (viewPath: string) => Promise<T>,
): Promise<{ result: T; strayPaths: string[] }> {
  assertTicketId(ticketId);
  mkdirSync(viewsRoot(), { recursive: true });
  const path = join(viewsRoot(), `${ticketId}-${stage}-${randomBytes(4).toString("hex")}`);
  await must(workdir, "worktree", "add", "--detach", path, ref);
  try {
    const result = await fn(path);
    const { out } = await git(path, "status", "--porcelain");
    const strayPaths = out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    return { result, strayPaths };
  } finally {
    await git(workdir, "worktree", "remove", "--force", path);
    try { rmSync(path, { recursive: true, force: true }); } catch {}
    await git(workdir, "worktree", "prune");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-sandbox.test.ts`
Expected: PASS, all tests in the file. Then `npm run typecheck`, expected exit 0.

- [ ] **Step 5: Commit**

```
git add src/forge/sandbox.ts tests/forge-sandbox.test.ts
git commit -m "Add withReadOnlyView: throwaway detached worktree for read-only stages"
```

---

### Task 2: Plan and review run in views

**Files:**
- Modify: `tests/fixtures/fake-agent.mjs`
- Modify: `src/forge/runs.ts` (sandbox import at line 18; `PLAN_ONLY` comment at lines 89-90; plan call at lines 591-595; review loop at lines 821-848; review-failure check at lines 859-863)
- Test: `tests/forge-runs.test.ts`

**Interfaces:**
- Consumes: `withReadOnlyView`, `branchName` from `src/forge/sandbox.ts` (Task 1).
- Produces: fake-agent env hooks `FAKE_CWD_OUT` (appends `<mode>\t<cwd>\n`), `FAKE_WRITE_PLAN`, `FAKE_WRITE_REVIEW`.

- [ ] **Step 1: Add the fake-agent hooks**

In `tests/fixtures/fake-agent.mjs`, add `appendFileSync` to the `node:fs` import. Directly after `let mode = selectMode();` add:

```js
// Test hook: record which directory each stage ran in.
if (process.env.FAKE_CWD_OUT) {
  appendFileSync(process.env.FAKE_CWD_OUT, `${mode}\t${process.cwd()}\n`);
}
```

Directly before the final `console.log(out);` add:

```js
// Plan/review agents that write files anyway: must never reach the work commit.
if (process.env.FAKE_WRITE_PLAN && mode === "plan") {
  writeFileSync(join(process.cwd(), "plan-scribble.txt"), "planner wrote this\n");
}
if (process.env.FAKE_WRITE_REVIEW && mode.startsWith("review")) {
  writeFileSync(join(process.cwd(), "review-scribble.txt"), "reviewer wrote this\n");
}
```

- [ ] **Step 2: Write the failing tests**

In `tests/forge-runs.test.ts`, add `realpathSync` to the `node:fs` import. Append at the end of the file:

```ts
describe("read-only stage views", () => {
  let cwdOut: string;
  beforeEach(() => {
    cwdOut = join(counterDir, "cwd.txt");
    process.env.FAKE_CWD_OUT = cwdOut;
  });
  afterEach(() => {
    delete process.env.FAKE_CWD_OUT;
    delete process.env.FAKE_WRITE_PLAN;
    delete process.env.FAKE_WRITE_REVIEW;
  });

  function stageDirs(): Record<string, string> {
    const dirs: Record<string, string> = {};
    for (const line of readFileSync(cwdOut, "utf-8").trim().split("\n")) {
      const [mode, dir] = line.split("\t");
      dirs[mode] = dir.trim();
    }
    return dirs;
  }

  it("plan and review run in views under the sandbox root, work in the ticket sandbox", async () => {
    const { actorId, ticket } = await seedTicket("Views");
    setScript("plan,work,review-pass", true);
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("passed");
    const dirs = stageDirs();
    const views = join(realpathSync(sandboxRoot), "views");
    expect(dirs.plan.startsWith(views)).toBe(true);
    expect(dirs["review-pass"].startsWith(views)).toBe(true);
    expect(dirs.work.startsWith(views)).toBe(false);
    expect(existsSync(dirs.plan)).toBe(false);
    expect(existsSync(dirs["review-pass"])).toBe(false);
  });

  it("a planner that writes files gets a warning and the file never reaches the work commit", async () => {
    const { actorId, ticket } = await seedTicket("Plan scribble");
    setScript("plan,work,review-pass", true);
    process.env.FAKE_WRITE_PLAN = "1";
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    const out = getRunOutput(runId, 0);
    expect(out?.status).toBe("passed");
    expect(out?.chunk).toContain("[forge: planner changed files in its read-only copy; discarded: plan-scribble.txt]");
    expect(await sandboxDiff(workdir, ticket.id)).not.toContain("plan-scribble.txt");
    expect(existsSync(join(workdir, "plan-scribble.txt"))).toBe(false);
  });

  it("a reviewer that writes files fails the run", async () => {
    const { actorId, ticket } = await seedTicket("Review scribble");
    setScript("plan,work,review-pass", true);
    process.env.FAKE_WRITE_REVIEW = "1";
    const { runId } = await startPipeline(actorId, relayConfig(), {
      ticketId: ticket.id, planAgent: "fake", workAgent: "fake", reviewAgent: "fake",
    });
    await awaitRun(runId);

    expect(getRunOutput(runId, 0)?.status).toBe("failed");
    const reports = (await listComments(ticket.id)).filter((c) => c.kind === "report");
    expect(reports.some((c) =>
      c.body.includes("reviewer changed files in its read-only copy") && c.body.includes("review-scribble.txt"),
    )).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-runs.test.ts`
Expected: the three new tests FAIL (plan/review cwd is the workdir, no warning, reviewer run passes).

- [ ] **Step 4: Implement in `src/forge/runs.ts`**

(a) Line 18: add `withReadOnlyView` and `branchName` to the named imports from `"./sandbox.js"`.

(b) Replace the comment at lines 89-90:

```ts
// Plan/review agents run in a throwaway read-only view (withReadOnlyView); this
// prompt text stays as defence in depth (live incident: claude acceptEdits
// implemented during planning).
```

(c) Replace lines 591-595:

```ts
    const res = await track(actorId, ticket.id, "plan", run.agents.plan, planPrompt.length, () => runAgent(
      agents.plan, planPrompt, workdir, onData,
      (child) => recordSpawn(run, child),
      undefined, modelOf(run.agents.plan), run.logPath,
    ));
```

with:

```ts
    const { result: res, strayPaths: planStray } = await withReadOnlyView(workdir, ticket.id, "plan", "HEAD", (view) =>
      track(actorId, ticket.id, "plan", run.agents.plan, planPrompt.length, () => runAgent(
        agents.plan, planPrompt, view, onData,
        (child) => recordSpawn(run, child),
        undefined, modelOf(run.agents.plan), run.logPath,
      )));
    if (planStray.length) append(run, `\n[forge: planner changed files in its read-only copy; discarded: ${planStray.join(", ")}]\n`);
```

(d) Replace lines 821-848 (the "Checks run CONCURRENTLY" comment through `run.child = undefined;`):

```ts
  // Checks run CONCURRENTLY with the whole review (single or chunked): the
  // reviewer only needs check RESULTS at verdict time. Checks execute in
  // `sandbox`; the review agent runs in `workdir`, so no filesystem race.
  if (checkCmds.length) run.checksStartedAt = Date.now();
  const checksPromise: Promise<CheckResult[]> = checkCmds.length
    ? runChecks(checkCmds, sandbox, undefined, (child) => {
        run.checksChild = child;
        if (run.stopped) void killTree(child);
      }).then((results) => { run.checksChild = undefined; run.checksEndedAt = Date.now(); return results; })
    : Promise.resolve<CheckResult[]>([]);

  // One review invocation per chunk, sequential: recordSpawn tracks a single
  // live child/pid, and chunked review is the rare oversized-diff path.
  run.reviewStartedAt = Date.now();
  const reviewResults: AgentResult[] = [];
  for (const chunk of chunks) {
    if (run.stopped) { run.child = undefined; return settle(run, "stopped"); }
    const reviewPrompt = composeReviewPrompt({ ticket, plan, report: reportOutput, diff: chunk.payload, operatorNotes: run.operatorNotes, protectedViolation: protectedFinding, amendments, gate: gate.report || undefined, citations: gate.citations || undefined, skills }) + roleStyle("review", styleSetting);
    const res = await track(actorId, ticket.id, "review", run.agents.review, reviewPrompt.length, () => runAgent(
      reviewAgent,
      reviewPrompt,
      workdir, onData,
      (child) => recordSpawn(run, child),
      undefined, modelOf(run.agents.review), run.logPath,
    ));
    reviewResults.push(res);
  }
  run.child = undefined;
```

with:

```ts
  // Checks run CONCURRENTLY with the whole review (single or chunked): the
  // reviewer only needs check RESULTS at verdict time. Checks execute in
  // `sandbox`; the review agent runs in its own read-only view, so no
  // filesystem race.
  if (checkCmds.length) run.checksStartedAt = Date.now();
  const checksPromise: Promise<CheckResult[]> = checkCmds.length
    ? runChecks(checkCmds, sandbox, undefined, (child) => {
        run.checksChild = child;
        if (run.stopped) void killTree(child);
      }).then((results) => { run.checksChild = undefined; run.checksEndedAt = Date.now(); return results; })
    : Promise.resolve<CheckResult[]>([]);

  // One review invocation per chunk, sequential: recordSpawn tracks a single
  // live child/pid, and chunked review is the rare oversized-diff path.
  run.reviewStartedAt = Date.now();
  const { result: reviewResults, strayPaths: reviewStray } = await withReadOnlyView(workdir, ticket.id, "review", branchName(ticket.id), async (view) => {
    const results: AgentResult[] = [];
    for (const chunk of chunks) {
      if (run.stopped) break;
      const reviewPrompt = composeReviewPrompt({ ticket, plan, report: reportOutput, diff: chunk.payload, operatorNotes: run.operatorNotes, protectedViolation: protectedFinding, amendments, gate: gate.report || undefined, citations: gate.citations || undefined, skills }) + roleStyle("review", styleSetting);
      results.push(await track(actorId, ticket.id, "review", run.agents.review, reviewPrompt.length, () => runAgent(
        reviewAgent,
        reviewPrompt,
        view, onData,
        (child) => recordSpawn(run, child),
        undefined, modelOf(run.agents.review), run.logPath,
      )));
    }
    return results;
  });
  run.child = undefined;
  if (run.stopped) return settle(run, "stopped");
```

(e) Directly after the existing block

```ts
  const reviewFailure = reviewResults.find((r) => !r.ok);
  if (reviewFailure) {
    await bounce(run, actorId, "reviewer failed", reviewFailure.output);
    return settle(run, "failed");
  }
```

insert:

```ts
  if (reviewStray.length) {
    await bounce(run, actorId, "reviewer changed files in its read-only copy", reviewStray.join("\n"));
    return settle(run, "failed");
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-runs.test.ts tests/forge-rework.test.ts tests/forge-resume.test.ts tests/forge-sentinel-runs.test.ts tests/forge-stall-runs.test.ts tests/forge-http-runs.test.ts tests/forge-sdk-runs.test.ts tests/prompt-injection.test.ts tests/forge-sandbox.test.ts`
Expected: PASS. Then `npm run typecheck`, expected exit 0. Report any pre-existing failure by name with its output; do not change unrelated tests.

- [ ] **Step 6: Commit**

```
git add tests/fixtures/fake-agent.mjs src/forge/runs.ts tests/forge-runs.test.ts
git commit -m "Forge plan and review run in throwaway read-only views"
```

---

### Task 3: Explain-diff runs in a view

**Files:**
- Modify: `src/api/forge-routes.ts` (sandbox import at lines 12-14; explain-diff call at line 322)
- Test: `tests/forge-api.test.ts` (existing test at line 940, "explain-diff caches by hash (fake agent) and 404s without sandbox")

**Interfaces:**
- Consumes: `withReadOnlyView` (Task 1); `FAKE_CWD_OUT` fake-agent hook (Task 2).

- [ ] **Step 1: Extend the existing test (failing)**

In `tests/forge-api.test.ts`, make sure `readFileSync`, `existsSync` (from `node:fs`), `tmpdir` (from `node:os`) and `join` (from `node:path`) are imported; add any that are missing to the existing import lines. In the test at line 940, replace:

```ts
  setScript("explain-diff");
  const explainRes = await app.request(`/forge/tickets/${ticket.id}/explain-diff`, { method: "POST", headers: h });
  expect(explainRes.status).toBe(200);
```

with:

```ts
  setScript("explain-diff");
  const cwdOut = join(tmpdir(), `explain-cwd-${Date.now()}.txt`);
  process.env.FAKE_CWD_OUT = cwdOut;
  const explainRes = await app.request(`/forge/tickets/${ticket.id}/explain-diff`, { method: "POST", headers: h });
  delete process.env.FAKE_CWD_OUT;
  expect(explainRes.status).toBe(200);
  const explainDir = readFileSync(cwdOut, "utf-8").trim().split("\t")[1];
  expect(explainDir).toMatch(/[\\/]views[\\/][0-9a-f-]{36}-explain-[0-9a-f]{8}$/);
  expect(existsSync(explainDir)).toBe(false);
```

- [ ] **Step 2: Run to verify it fails**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-api.test.ts`
Expected: the explain-diff test FAILS on the `toMatch` (cwd is the project workdir).

- [ ] **Step 3: Implement**

In `src/api/forge-routes.ts` add `withReadOnlyView` to the named imports from `"../forge/sandbox.js"` (`branchName` is already imported there). Replace:

```ts
    const res = await runAgent(agent, prompt, workdir);
```

with:

```ts
    const { result: res } = await withReadOnlyView(workdir, ticketId, "explain", branchName(ticketId), (view) => runAgent(agent, prompt, view));
```

- [ ] **Step 4: Run to verify it passes**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-api.test.ts`
Expected: PASS. Then `npm run typecheck`, expected exit 0.

- [ ] **Step 5: Commit**

```
git add src/api/forge-routes.ts tests/forge-api.test.ts
git commit -m "Explain-diff runs in a throwaway read-only view"
```

---

### Task 4: Sweep leftover views

**Files:**
- Modify: `src/forge/runs.ts` (`cleanupMergedSandboxes`, insert before the comment "Git-side residue that outlives the on-disk sandbox dirs" at line 322; sandbox import at line 18)
- Test: `tests/forge-cleanup.test.ts`

**Interfaces:**
- Consumes: `viewsRoot()` from `src/forge/sandbox.ts` (Task 1).

- [ ] **Step 1: Write the failing test**

In `tests/forge-cleanup.test.ts` add `utimesSync` to the `node:fs` import. Inside `describe("forge cleanup", ...)` append:

```ts
  it("deletes read-only views older than 24 hours and keeps fresh ones", async () => {
    const views = join(sandboxRoot, "views");
    const old = join(views, "old-view");
    const fresh = join(views, "fresh-view");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "f.txt"), "x");
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(old, past, past);

    await cleanupMergedSandboxes(relayConfig());

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-cleanup.test.ts`
Expected: the new test FAILS (`old` still exists).

- [ ] **Step 3: Implement**

In `src/forge/runs.ts` add `viewsRoot` to the named imports from `"./sandbox.js"`. Make sure `existsSync`, `readdirSync`, `statSync`, `rmSync` are imported from `node:fs` and `join` from `node:path`; add any that are missing to the existing import lines. In `cleanupMergedSandboxes`, directly before the comment line `// Git-side residue that outlives the on-disk sandbox dirs: prunable worktree`, insert:

```ts
  // Views are removed when their stage ends; one a Windows lock kept alive is
  // reclaimed here. ponytail: age-based, views have no owner record; a live-view
  // registry is the upgrade path if a stage ever runs longer than 24 hours.
  const viewCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of existsSync(viewsRoot()) ? readdirSync(viewsRoot()) : []) {
    const p = join(viewsRoot(), name);
    try { if (statSync(p).mtimeMs < viewCutoff) rmSync(p, { recursive: true, force: true }); } catch {}
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `$env:VIBEOPS_TEST_EMBEDDED="1"; node scripts/test-lane.mjs tests/forge-cleanup.test.ts`
Expected: PASS. Then `npm run typecheck`, expected exit 0.

- [ ] **Step 5: Commit**

```
git add src/forge/runs.ts tests/forge-cleanup.test.ts
git commit -m "Cleanup sweep reclaims read-only views older than 24 hours"
```

---

### Task 5: claude-sdk role checkboxes shown but locked

**Files:**
- Modify: `app/src/components/settings/AgentsConfigCard.tsx` (`roleChoices` at line 72; role checkbox `<input>` inside the `roleChoices.map`)
- Test: `app/src/components/settings/AgentsConfigCard.test.tsx` (test "an sdk lane offers only the work role")

**Interfaces:** none.

- [ ] **Step 1: Replace the test (failing)**

In `app/src/components/settings/AgentsConfigCard.test.tsx` replace the whole test `"an sdk lane offers only the work role"` with:

```ts
test("an sdk lane shows all three roles, locked to work", async () => {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/forge/agents" && !opts) {
      return Promise.resolve([{ name: "claude-sdk", roles: ["work"], models: [], type: "sdk" }]);
    }
    return Promise.resolve({ value: "" });
  });

  render(wrap(<AgentsConfigCard />));

  await waitFor(() => expect(screen.getByRole("heading", { name: "claude-sdk" })).toBeInTheDocument());
  const work = screen.getByRole("checkbox", { name: "work" }) as HTMLInputElement;
  const plan = screen.getByRole("checkbox", { name: "plan" }) as HTMLInputElement;
  const review = screen.getByRole("checkbox", { name: "review" }) as HTMLInputElement;
  expect(work.checked).toBe(true);
  expect(plan.checked).toBe(false);
  expect(review.checked).toBe(false);
  for (const c of [work, plan, review]) {
    expect(c.disabled).toBe(true);
    expect(c.title).toBe("The SDK lane runs the work stage only");
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app; npx vitest run src/components/settings/AgentsConfigCard.test.tsx`
Expected: the new test FAILS (no plan/review checkbox).

- [ ] **Step 3: Implement**

In `app/src/components/settings/AgentsConfigCard.tsx` replace:

```ts
  const roleChoices = chatOnly ? ["plan", "review"] : workOnly ? ["work"] : ["plan", "work", "review"];
```

with:

```ts
  const roleChoices = chatOnly ? ["plan", "review"] : ["plan", "work", "review"];
```

and replace the role checkbox:

```tsx
              <input
                type="checkbox"
                checked={roles.has(r)}
                onChange={() => toggleRole(r)}
                className="rounded border-white/20 bg-surface-container-highest"
              />
```

with:

```tsx
              <input
                type="checkbox"
                checked={roles.has(r)}
                onChange={() => toggleRole(r)}
                disabled={workOnly}
                title={workOnly ? "The SDK lane runs the work stage only" : undefined}
                className="rounded border-white/20 bg-surface-container-highest disabled:opacity-50 disabled:cursor-not-allowed"
              />
```

Leave `sanitizeRoles`, `handleSave` and the SDK note text unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `cd app; npx vitest run src/components/settings/AgentsConfigCard.test.tsx`, then `cd app; npx vitest run`, then `cd app; npx tsc --noEmit -p .`
Expected: all PASS, tsc exit 0.

- [ ] **Step 5: Commit**

```
git add app/src/components/settings/AgentsConfigCard.tsx app/src/components/settings/AgentsConfigCard.test.tsx
git commit -m "Agents card shows claude-sdk roles locked to work"
```
