import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, runGuarded } from "./run.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bp-run-"));
const rm = (d: string) => {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {}
};

test("runGuarded blocks rm -rf / without spawning", async () => {
  const d = tmp();
  try {
    const r = await runGuarded("rm -rf /", { cwd: d, firewall: { workspace: d } });
    assert.equal(r.exitCode, null);
    assert.equal(r.timedOut, false);
    assert.ok(r.blocked);
    assert.equal(r.blocked.rule, "delete-outside");
    assert.match(r.output, /^\[blocked by firewall: delete-outside\] /);
    assert.equal(r.stats, undefined);
  } finally {
    rm(d);
  }
});

test("runGuarded runs an allowed command", async () => {
  const d = tmp();
  try {
    const r = await runGuarded("echo hello", { cwd: d, firewall: { workspace: d } });
    assert.equal(r.blocked, undefined);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /hello[\s\S]*\[exit 0\]$/);
  } finally {
    rm(d);
  }
});

test("runCommand clips 100000 lines and ends with [exit 0]", async () => {
  const d = tmp();
  try {
    const r = await runCommand(`node -e "for(let i=1;i<=100000;i++)console.log('line '+i+' filler text')"`, { cwd: d });
    assert.equal(r.exitCode, 0);
    assert.ok(r.output.endsWith("\n[exit 0]"));
    assert.ok(r.stats?.truncated);
    assert.ok(r.output.length < 20000, `len ${r.output.length}`);
    assert.ok(r.output.includes("line 100000 filler text"));
  } finally {
    rm(d);
  }
});

test("runCommand reports a non-zero exit and merges stderr", async () => {
  const d = tmp();
  try {
    const r = await runCommand(`node -e "console.error('Error: boom');process.exit(3)"`, { cwd: d });
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /Error: boom/);
    assert.ok(r.output.endsWith("\n[exit 3]"));
  } finally {
    rm(d);
  }
});

test("runCommand timeout kills the whole process tree", async () => {
  const d = tmp();
  try {
    const script = path.join(d, "hang.mjs");
    fs.writeFileSync(script, `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(path.join(d, "pid"))}, String(process.pid));setInterval(()=>{},1000);`);
    const t0 = Date.now();
    const r = await runCommand(`node "${script.replace(/\\/g, "/")}"`, { cwd: d, timeoutMs: 1500 });
    assert.equal(r.timedOut, true);
    assert.match(r.output, /\[timed out after 1\.5s; process tree killed\]$/);
    assert.ok(Date.now() - t0 < 15000);
    const pid = Number(fs.readFileSync(path.join(d, "pid"), "utf8"));
    assert.ok(pid > 0);
    await new Promise((res) => setTimeout(res, 500));
    assert.throws(() => process.kill(pid, 0), "hanging node process must be dead");
  } finally {
    rm(d);
  }
});

test("runCommand spawn error settles with null exit code", async () => {
  const d = tmp();
  try {
    const r = await runCommand("x", { cwd: d, shell: ["definitely-not-a-real-binary-xyz", "-c"] });
    assert.equal(r.exitCode, null);
    assert.match(r.output, /ENOENT|spawn/);
  } finally {
    rm(d);
  }
});

test("runCommand settles quickly when a background child holds the pipes", async () => {
  const d = tmp();
  let pid = 0;
  try {
    const t0 = Date.now();
    const r = await runCommand(
      `node -e "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},9000)'],{stdio:'inherit'}); c.unref(); console.log('started',c.pid)"`,
      { cwd: d },
    );
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
    pid = Number(/started (\d+)/.exec(r.output)?.[1]);
    assert.ok(pid > 0, r.output);
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rm(d);
  }
});
