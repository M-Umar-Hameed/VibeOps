import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firewallHookCommand } from "../src/relay/wall.js";

describe("relay-firewall-hook", () => {
  let ws: string;

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "fw-hook-ws-"));
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  function run(command: string, toolName = "Bash", env: Record<string, string> = {}) {
    return spawnSync(firewallHookCommand(), {
      shell: true,
      input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: ws }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws, VIBEOPS_ALLOW_COMMAND: "", ...env },
      encoding: "utf8",
    });
  }

  it("sh -c 'rm -rf /' exits 2 and stderr matches /blocked by the forge firewall/", () => {
    const res = run("sh -c 'rm -rf /'");
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/blocked by the forge firewall/);
  });

  it("git --no-pager push exits 2 and stderr contains git-push", () => {
    const res = run("git --no-pager push");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("git-push");
  });

  it("npm test exits 0", () => {
    const res = run("npm test");
    expect(res.status).toBe(0);
  });

  it("VIBEOPS_ALLOW_COMMAND=git-push allows only its class", () => {
    const push = run("git push origin main", "Bash", { VIBEOPS_ALLOW_COMMAND: "git-push" });
    expect(push.status).toBe(0);

    const publish = run("npm publish", "Bash", { VIBEOPS_ALLOW_COMMAND: "git-push" });
    expect(publish.status).toBe(2);
  });

  it("malformed stdin exits 2 and stderr matches /hook error/", () => {
    const res = spawnSync(firewallHookCommand(), {
      shell: true,
      input: "{not json",
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws, VIBEOPS_ALLOW_COMMAND: "" },
      encoding: "utf8",
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/hook error/);
  });

  it("non-Bash tool exits 0", () => {
    const res = spawnSync(firewallHookCommand(), {
      shell: true,
      input: JSON.stringify({ tool_name: "Read", tool_input: { path: "foo.txt" }, cwd: ws }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws, VIBEOPS_ALLOW_COMMAND: "" },
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
  });

  it("fails closed on missing script", () => {
    const cmd = firewallHookCommand().replace("firewall-hook.ts", "firewall-hook-missing.ts");
    const res = spawnSync(cmd, {
      shell: true,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: ws }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws, VIBEOPS_ALLOW_COMMAND: "" },
      encoding: "utf8",
    });
    expect(res.status).toBe(2);
  });
});
