import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgentSdk } from "../src/relay/invoke-sdk.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(),
  };
});

describe("forge SDK lane", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "sdk-lane-"));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it("yields telemetry correctly", async () => {
    (query as any).mockImplementation(async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello SDK" }] } };
      yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.005 };
    });

    const res = await runAgentSdk({ type: "sdk", roles: ["work"], cmd: [] }, "prompt", workdir);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello SDK");
    expect(res.usage).toEqual({ tokens: 30, cost: 5000 });
  });

  it("passes the picked model through to the SDK, and omits it when unset", async () => {
    const seen: any[] = [];
    (query as any).mockImplementation(async function* (args: any) {
      seen.push(args.options);
      yield { type: "result", subtype: "success", is_error: false };
    });
    const agent = { type: "sdk" as const, roles: ["work"], cmd: [] };

    await runAgentSdk(agent, "prompt", workdir, undefined, undefined, "opus");
    expect(seen[0].model).toBe("opus");

    await runAgentSdk(agent, "prompt", workdir);
    expect("model" in seen[1]).toBe(false);
  });

  it("stops via abort controller", async () => {
    let capturedAbort: AbortController | undefined;
    (query as any).mockImplementation(async function* (args: any) {
      capturedAbort = args.options.abortController;
      yield { type: "result", subtype: "success", is_error: false };
    });

    let doAbort: any;
    await runAgentSdk({ type: "sdk", roles: ["work"], cmd: [] }, "prompt", workdir, undefined, (abort) => {
      doAbort = abort;
    });

    expect(capturedAbort).toBeDefined();
    expect(capturedAbort!.signal.aborted).toBe(false);
    doAbort();
    expect(capturedAbort!.signal.aborted).toBe(true);
  });
});
