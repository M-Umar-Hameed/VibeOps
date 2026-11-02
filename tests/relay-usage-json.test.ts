import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseUsageJson } from "../src/relay/usage-json.js";
import { validateRelayConfig } from "../src/relay/config.js";
import { runAgent } from "../src/relay/invoke.js";

const CLAUDE = '{"type":"result","result":"done","total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":3,"cache_read_input_tokens":2}}';
const AGY = '{"response":"pong\\n","usage":{"total_tokens":28485}}';

describe("parseUsageJson", () => {
  it("reads claude", () => {
    expect(parseUsageJson(CLAUDE)).toEqual({ text: "done", usage: { tokens: 20, cost: 12300 } });
  });
  it("reads agy", () => {
    expect(parseUsageJson(AGY)).toEqual({ text: "pong\n", usage: { tokens: 28485, cost: 0 } });
  });
  it("keeps lines before the json", () => {
    expect(parseUsageJson("warning: x\n" + CLAUDE)?.text).toBe("warning: x\ndone");
  });
  it("rejects other shapes", () => {
    expect(parseUsageJson('{"type":"result","res')).toBeUndefined();
    expect(parseUsageJson("hello")).toBeUndefined();
    expect(parseUsageJson('{"foo":1}')).toBeUndefined();
  });
});

describe("usage exact config", () => {
  const cfg = (agent: Record<string, unknown>) => ({ workdir: "D:/x", agents: { a: { roles: ["work"], ...agent } } });
  it("accepts claude and agy cli lanes", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["claude", "-p"], usage: "exact" }), "p")).not.toThrow();
    expect(() => validateRelayConfig(cfg({ cmd: ["C:\\x\\agy.exe"], usage: "exact" }), "p")).not.toThrow();
  });
  it("rejects other lanes and values", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["codex", "exec"], usage: "exact" }), "p")).toThrow(/usage/);
    expect(() => validateRelayConfig(cfg({ type: "sdk", usage: "exact" }), "p")).toThrow(/usage/);
    expect(() => validateRelayConfig(cfg({ cmd: ["claude", "-p"], usage: "yes" }), "p")).toThrow(/usage/);
  });
});

describe("runAgent usage exact", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-json-"));
  const script = (name: string, line: string) => {
    const p = join(dir, name);
    writeFileSync(p, `process.stdout.write(${JSON.stringify(line)});\n`);
    return p;
  };
  const run = async (line: string, usage?: "exact") => {
    const chunks: string[] = [];
    const res = await runAgent({ cmd: [process.execPath, script(`s${Math.random()}.mjs`, line)], roles: ["work"], usage }, "hi", dir, (c) => chunks.push(c));
    return { res, chunks };
  };
  it("returns parsed text and usage", async () => {
    const { res, chunks } = await run(CLAUDE, "exact");
    expect(res.usage).toEqual({ tokens: 20, cost: 12300 });
    expect(res.output).toBe("done");
    expect(chunks.join("")).toBe("done");
  });
  it("falls back to raw output on garbage", async () => {
    const { res, chunks } = await run("garbage", "exact");
    expect(res.usage).toBeUndefined();
    expect(res.output).toContain("garbage");
    expect(chunks.join("")).toContain("garbage");
  });
  it("streams raw json without the opt-in", async () => {
    const { res, chunks } = await run(CLAUDE);
    expect(res.usage).toBeUndefined();
    expect(chunks.join("")).toBe(CLAUDE);
  });
});
