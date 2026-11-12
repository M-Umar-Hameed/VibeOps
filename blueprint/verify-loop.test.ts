import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultAlert, verifyLoop } from "./verify-loop.ts";
import type { HaltAlert } from "./verify-loop.ts";

const CHECK = `import fs from "node:fs";
if (fs.readFileSync("a.txt", "utf8").includes("ok")) process.exit(0);
console.log("check failed: a.txt does not contain ok");
process.exit(1);
`;

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();

function makeRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bp-vl-"));
  git(d, "init", "-q");
  git(d, "config", "user.name", "t");
  git(d, "config", "user.email", "t@example.com");
  git(d, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(d, "a.txt"), "ok\n");
  fs.writeFileSync(path.join(d, "check.mjs"), CHECK);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "init");
  return d;
}

async function withRepo(fn: (repo: string) => Promise<void>) {
  const d = makeRepo();
  try {
    await fn(d);
  } finally {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

const bad = (repo: string) => {
  fs.writeFileSync(path.join(repo, "a.txt"), "bad\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
};
const good = (repo: string) => fs.writeFileSync(path.join(repo, "a.txt"), "ok\n");
const base = { testCommand: "node check.mjs", testTimeoutMs: 60000 };

test("passes on attempt 1", async () => {
  await withRepo(async (repo) => {
    const r = await verifyLoop({ ...base, repo, step: async () => {} });
    assert.deepEqual(r, { status: "passed", attempts: 1 });
  });
});

test("fail, fail, pass -> passed with attempts 3 and no alert", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    const feedbacks: (string | null)[] = [];
    const r = await verifyLoop({
      ...base,
      repo,
      alert: (a) => void alerts.push(a),
      step: async (fb, n) => {
        feedbacks.push(fb);
        if (n < 3) bad(repo);
        else good(repo);
      },
    });
    assert.deepEqual(r, { status: "passed", attempts: 3 });
    assert.equal(alerts.length, 0);
    assert.equal(feedbacks[0], null);
    assert.match(feedbacks[1] ?? "", /check failed/);
  });
});

test("three failing steps halt, roll back and stash", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    const r = await verifyLoop({ ...base, repo, alert: (a) => void alerts.push(a), step: async () => bad(repo) });
    assert.equal(r.status, "halted");
    assert.equal(alerts.length, 1);
    const a = alerts[0];
    assert.equal(a.consecutiveFailures, 3);
    assert.equal(a.attempts, 3);
    assert.equal(a.rollbackOk, true);
    assert.equal(a.kind, "verify-loop-halted");
    assert.match(a.reason, /3 consecutive failed verification runs/);
    assert.match(a.lastOutput, /check failed/);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ok\n");
    assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
    assert.ok(a.stash);
    assert.equal(git(repo, "stash", "list").split("\n").filter(Boolean).length, 1);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(a.headBefore, a.baseline);
    if (r.status === "halted") assert.deepEqual(r.alert, a);
  });
});

test("a pass with done:false resets the failure counter", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    const r = await verifyLoop({
      ...base,
      repo,
      alert: (a) => void alerts.push(a),
      step: async (_fb, n) => {
        if (n === 1 || n === 3 || n === 4) {
          bad(repo);
          return;
        }
        good(repo);
        if (n === 2) return { done: false };
        return { done: true };
      },
    });
    assert.deepEqual(r, { status: "passed", attempts: 5 });
    assert.equal(alerts.length, 0);
  });
});

test("dirty tree at start is refused and step never runs", async () => {
  await withRepo(async (repo) => {
    fs.writeFileSync(path.join(repo, "dirty.txt"), "mine\n");
    let called = 0;
    const r = await verifyLoop({ ...base, repo, step: async () => void called++ });
    assert.equal(r.status, "refused");
    assert.match((r as { reason: string }).reason, /uncommitted changes/);
    assert.equal(called, 0);
    assert.equal(fs.readFileSync(path.join(repo, "dirty.txt"), "utf8"), "mine\n");
  });
});

test("non-repo directory is refused", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bp-vl-nogit-"));
  try {
    let called = 0;
    const r = await verifyLoop({ ...base, repo: d, step: async () => void called++ });
    assert.equal(r.status, "refused");
    assert.match((r as { reason: string }).reason, /not a git repository/);
    assert.equal(called, 0);
  } finally {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

test("repo with no commits is refused", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bp-vl-empty-"));
  try {
    git(d, "init", "-q");
    const r = await verifyLoop({ ...base, repo: d, step: async () => {} });
    assert.equal(r.status, "refused");
    assert.match((r as { reason: string }).reason, /no commits/);
  } finally {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

test("a step that commits a bad change is reset to baseline", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    let lastSha = "";
    const r = await verifyLoop({
      ...base,
      repo,
      alert: (a) => void alerts.push(a),
      step: async (_fb, n) => {
        fs.writeFileSync(path.join(repo, "a.txt"), `bad${n}\n`);
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", `bad ${n}`);
        lastSha = git(repo, "rev-parse", "HEAD");
      },
    });
    assert.equal(r.status, "halted");
    const a = alerts[0];
    assert.equal(a.headBefore, lastSha);
    assert.notEqual(a.headBefore, a.baseline);
    assert.equal(git(repo, "rev-parse", "HEAD"), a.baseline);
    assert.equal(a.rollbackOk, true);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ok\n");
  });
});

test("a step that throws three times halts without running tests", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    const r = await verifyLoop({
      ...base,
      testCommand: "node -e \"process.exit(0)\"",
      repo,
      alert: (a) => void alerts.push(a),
      step: async () => {
        throw new Error("ECONNRESET");
      },
    });
    assert.equal(r.status, "halted");
    assert.equal(alerts[0].consecutiveFailures, 3);
    assert.match(alerts[0].lastOutput, /agent step failed: ECONNRESET/);
  });
});

test("max steps reached halts", async () => {
  await withRepo(async (repo) => {
    const r = await verifyLoop({ ...base, repo, maxSteps: 2, alert: () => {}, step: async () => ({ done: false }) });
    assert.equal(r.status, "halted");
    if (r.status === "halted") {
      assert.equal(r.attempts, 2);
      assert.match(r.alert.reason, /max steps \(2\) reached/);
    }
  });
});

test("an alert callback that throws still resolves halted with rollback done", async () => {
  await withRepo(async (repo) => {
    const r = await verifyLoop({
      ...base,
      repo,
      alert: () => {
        throw new Error("pager down");
      },
      step: async () => bad(repo),
    });
    assert.equal(r.status, "halted");
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ok\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
});

test("test command timeout counts as a failure and the process dies", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    const t0 = Date.now();
    const r = await verifyLoop({
      repo,
      testCommand: "node -e \"setInterval(()=>{},1000)\"",
      testTimeoutMs: 1500,
      maxConsecutiveFailures: 1,
      alert: (a) => void alerts.push(a),
      step: async () => {},
    });
    assert.equal(r.status, "halted");
    assert.match(alerts[0].lastOutput, /timed out/);
    assert.ok(Date.now() - t0 < 30000);
  });
});

test("defaultAlert with an unreachable webhook resolves without throwing", async () => {
  const prev = process.env.VERIFY_ALERT_WEBHOOK;
  process.env.VERIFY_ALERT_WEBHOOK = "http://127.0.0.1:9/";
  try {
    await defaultAlert({
      kind: "verify-loop-halted", repo: "r", reason: "x", attempts: 1, consecutiveFailures: 1, baseline: "b", headBefore: "b",
      stash: null, rollbackOk: true, lastOutput: "o", at: new Date().toISOString(),
    });
  } finally {
    if (prev === undefined) delete process.env.VERIFY_ALERT_WEBHOOK;
    else process.env.VERIFY_ALERT_WEBHOOK = prev;
  }
});

test("a step that checks out another existing branch leaves it untouched and returns to the start branch", async () => {
  await withRepo(async (repo) => {
    const start = git(repo, "symbolic-ref", "--short", "HEAD");
    git(repo, "checkout", "-q", "-b", "other");
    fs.writeFileSync(path.join(repo, "other.txt"), "o\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "other");
    const otherSha = git(repo, "rev-parse", "other");
    git(repo, "checkout", "-q", start);
    const alerts: HaltAlert[] = [];
    const r = await verifyLoop({
      ...base,
      repo,
      alert: (a) => void alerts.push(a),
      step: async () => {
        if (git(repo, "symbolic-ref", "--short", "HEAD") !== "other") git(repo, "checkout", "-q", "other");
        bad(repo);
      },
    });
    assert.equal(r.status, "halted");
    const a = alerts[0];
    assert.equal(a.rollbackOk, true);
    assert.equal(git(repo, "rev-parse", "other"), otherSha);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), start);
    assert.equal(git(repo, "rev-parse", "HEAD"), a.baseline);
  });
});

test("a shell that fails to spawn halts with a rollback instead of rejecting", async () => {
  await withRepo(async (repo) => {
    const alerts: HaltAlert[] = [];
    const r = await verifyLoop({ ...base, repo, shell: [""], alert: (a) => void alerts.push(a), step: async () => bad(repo) });
    assert.equal(r.status, "halted");
    assert.equal(alerts[0].rollbackOk, true);
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
});
