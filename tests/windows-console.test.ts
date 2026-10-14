import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, killTree } from "../src/relay/invoke.js";
import { runChecks } from "../src/forge/checks.js";
import { pidAlive } from "../src/db/lifecycle.js";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/console-agent.mjs");

function shared(out: string) {
  expect(out).toContain("child-ok");
  const agentMatch = out.match(/agent=(\d+)/);
  expect(agentMatch).not.toBeNull();
  const agentPid = agentMatch![1];
  const listMatch = out.match(/list=([\d,]*)/);
  expect(listMatch).not.toBeNull();
  const pids = listMatch![1].split(",").map((s) => s.trim());
  expect(pids).toContain(agentPid);
}

describe.skipIf(process.platform !== "win32")("windows console inheritance", () => {
  test("case A: Forge path with logPath shares console with children", async () => {
    const wd = mkdtempSync(join(tmpdir(), "win-console-a-"));
    try {
      const res = await runAgent(
        { cmd: [process.execPath, FIXTURE], roles: [] } as never,
        "unused",
        wd,
        undefined,
        undefined,
        join(wd, "r.log"),
      );
      expect(res.ok).toBe(true);
      shared(res.output);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  test("case B: piped path shares console with children", async () => {
    const wd = mkdtempSync(join(tmpdir(), "win-console-b-"));
    try {
      const res = await runAgent(
        { cmd: [process.execPath, FIXTURE], roles: [] } as never,
        "unused",
        wd,
      );
      expect(res.ok).toBe(true);
      shared(res.output);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  test("case C: Forge checks share console with children", async () => {
    const wd = mkdtempSync(join(tmpdir(), "win-console-c-"));
    try {
      const results = await runChecks([`node "${FIXTURE}"`], wd);
      expect(results[0].code).toBe(0);
      shared(results[0].tail);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  test("case D: killTree through the host kills agent without orphans", async () => {
    const wd = mkdtempSync(join(tmpdir(), "win-console-d-"));
    try {
      let data = "";
      let agentPid: number | undefined;
      const res = await runAgent(
        {
          cmd: [process.execPath, "-e", "console.log('pid='+process.pid);setInterval(()=>{},1000)"],
          roles: [],
          timeoutMs: 60_000,
        } as never,
        "unused",
        wd,
        (chunk) => { data += chunk; },
        (child) => {
          const start = Date.now();
          const poll = setInterval(() => {
            const m = data.match(/pid=(\d+)/);
            if (m) {
              agentPid = Number(m[1]);
              clearInterval(poll);
              void killTree(child);
            } else if (Date.now() - start > 10_000) {
              clearInterval(poll);
              void killTree(child);
            }
          }, 50);
        },
        join(wd, "r.log"),
      );
      expect(res.ok).toBe(false);
      expect(agentPid).toBeDefined();
      const deadStart = Date.now();
      while (agentPid && pidAlive(agentPid) && Date.now() - deadStart < 5_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pidAlive(agentPid!)).toBe(false);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);

  test("case E: wall-time timeout through the host kills agent", async () => {
    const wd = mkdtempSync(join(tmpdir(), "win-console-e-"));
    try {
      let data = "";
      let agentPid: number | undefined;
      const res = await runAgent(
        {
          cmd: [process.execPath, "-e", "console.log('pid='+process.pid);setInterval(()=>{},1000)"],
          roles: [],
          timeoutMs: 1500,
        } as never,
        "unused",
        wd,
        (chunk) => {
          data += chunk;
          const m = data.match(/pid=(\d+)/);
          if (m) agentPid = Number(m[1]);
        },
        undefined,
        join(wd, "r.log"),
      );
      expect(res.ok).toBe(false);
      expect(res.output).toContain("agent timed out");
      expect(agentPid).toBeDefined();
      const deadStart = Date.now();
      while (agentPid && pidAlive(agentPid) && Date.now() - deadStart < 5_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pidAlive(agentPid!)).toBe(false);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  }, 60_000);
});
