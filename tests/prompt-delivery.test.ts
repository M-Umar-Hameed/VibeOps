import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRelayConfig } from "../src/relay/config.js";
import { runAgent } from "../src/relay/invoke.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");

function cfg(agent: Record<string, unknown>) {
  return { workdir: "D:/x", agents: { a: { roles: ["plan"], ...agent } } };
}

describe("promptDelivery validation", () => {
  it("rejects an unknown value", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["x", "{prompt}"], promptDelivery: "pipe" }), "p"))
      .toThrow(/promptDelivery must be one of/);
  });

  it("rejects argv declared without a {prompt} placeholder", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["x"], promptDelivery: "argv" }), "p"))
      .toThrow(/declares promptDelivery "argv" but its cmd has no \{prompt\}/);
  });

  it("rejects file declared without a {promptFile} placeholder", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["x", "{prompt}"], promptDelivery: "file" }), "p"))
      .toThrow(/declares promptDelivery "file" but its cmd has no \{promptFile\}/);
  });

  it("rejects stdin declared while the cmd still substitutes the prompt", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["x", "{prompt}"], promptDelivery: "stdin" }), "p"))
      .toThrow(/declares promptDelivery "stdin" but its cmd still substitutes/);
  });

  it("accepts each consistent combination", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["x", "{prompt}"], promptDelivery: "argv" }), "p")).not.toThrow();
    expect(() => validateRelayConfig(cfg({ cmd: ["x", "{promptFile}"], promptDelivery: "file" }), "p")).not.toThrow();
    expect(() => validateRelayConfig(cfg({ cmd: ["x"], promptDelivery: "stdin" }), "p")).not.toThrow();
  });

  it("stays optional so existing configs keep inferring from placeholders", () => {
    expect(() => validateRelayConfig(cfg({ cmd: ["x", "{prompt}"] }), "p")).not.toThrow();
  });
});

describe("promptDelivery at spawn", () => {
  const run = (agent: Record<string, unknown>, prompt: string) => {
    const wd = mkdtempSync(join(tmpdir(), "pd-"));
    process.env.FAKE_MODE = "plan";
    return runAgent(agent as never, prompt, wd, undefined, undefined, join(wd, "r.log"));
  };

  it("declared stdin delivers the prompt without any placeholder", async () => {
    const res = await run(
      { cmd: [process.execPath, FAKE], roles: ["plan"], promptDelivery: "stdin" },
      "hello via stdin",
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("do the thing");
  });

  it("declared argv still falls back to stdin when the prompt exceeds the argv limit", async () => {
    const res = await run(
      { cmd: [process.execPath, FAKE, "{prompt}"], roles: ["plan"], promptDelivery: "argv" },
      "x".repeat(200_000),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("do the thing");
  });

  it("declared file writes the prompt to a file the cmd receives", async () => {
    const wd = mkdtempSync(join(tmpdir(), "pd-"));
    const marker = join(wd, "seen.txt");
    const reader = join(wd, "reader.mjs");
    writeFileSync(reader, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.PD_MARKER, readFileSync(process.argv[2], 'utf8').slice(0, 40));",
      "console.log('read-the-file');",
    ].join("\n"));
    process.env.PD_MARKER = marker;
    const res = await runAgent(
      { cmd: [process.execPath, reader, "{promptFile}"], roles: ["plan"], promptDelivery: "file" } as never,
      "prompt-written-to-file", wd, undefined, undefined, join(wd, "r.log"),
    );
    delete process.env.PD_MARKER;
    expect(res.ok).toBe(true);
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toContain("prompt-written-to-file");
  });
});
