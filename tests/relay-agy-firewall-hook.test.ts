import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agyFirewallHookCommand } from "../src/relay/wall.js";

describe("relay-agy-firewall-hook", () => {
  let ws: string;

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "fw-agy-ws-"));
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  function run(toolCall: { name: string; args?: { CommandLine?: string } }, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    const res = spawnSync(agyFirewallHookCommand(), {
      shell: true,
      input: JSON.stringify({ toolCall, cwd: ws, workspacePaths: [ws], hookEventName: "PreToolUse", ...extra }),
      env: { ...process.env, VIBEOPS_ALLOW_COMMAND: "", ...env },
      encoding: "utf8",
    });
    if (res.error) throw res.error;
    if (!res.stdout.trim()) throw new Error(`empty stdout. stderr: ${res.stderr}`);
    return JSON.parse(res.stdout.trim()) as { decision: "allow" | "deny"; reason?: string };
  }

  it("sh -c 'rm -rf /' gives deny and reason matches /blocked by the forge firewall/", () => {
    const res = run({ name: "run_command", args: { CommandLine: "sh -c 'rm -rf /'" } });
    expect(res.decision).toBe("deny");
    expect(res.reason).toMatch(/blocked by the forge firewall/);
  });

  it("git --no-pager push gives deny and reason contains git-push", () => {
    const res = run({ name: "run_command", args: { CommandLine: "git --no-pager push" } });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("git-push");
  });

  it("npm test gives allow", () => {
    const res = run({ name: "run_command", args: { CommandLine: "npm test" } });
    expect(res).toEqual({ decision: "allow" });
  });

  it("non-run_command tool gives allow", () => {
    const res = run({ name: "view_file" });
    expect(res).toEqual({ decision: "allow" });
  });

  it("malformed stdin prints deny with reason matching /hook error/", () => {
    const res = spawnSync(agyFirewallHookCommand(), {
      shell: true,
      input: "{not json",
      env: { ...process.env, VIBEOPS_ALLOW_COMMAND: "" },
      encoding: "utf8",
    });
    const parsed = JSON.parse(res.stdout.trim()) as { decision: string; reason?: string };
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toMatch(/hook error/);
  });

  it("VIBEOPS_ALLOW_COMMAND=git-push allows only its class", () => {
    const push = run({ name: "run_command", args: { CommandLine: "git push origin main" } }, { VIBEOPS_ALLOW_COMMAND: "git-push" });
    expect(push).toEqual({ decision: "allow" });

    const publish = run({ name: "run_command", args: { CommandLine: "npm publish" } }, { VIBEOPS_ALLOW_COMMAND: "git-push" });
    expect(publish.decision).toBe("deny");
  });

  it("workspacePaths: [] with cwd: ws falls back to cwd and allows npm test", () => {
    const res = run({ name: "run_command", args: { CommandLine: "npm test" } }, {}, { workspacePaths: [] });
    expect(res).toEqual({ decision: "allow" });
  });
});
