import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateRelayConfig } from "../src/relay/config.js";

function cfg(agent: Record<string, unknown>) {
  return { workdir: "D:/x", agents: { s: { type: "sdk", roles: ["work"], ...agent } } };
}

describe("relay config executable", () => {
  it("rejects a non-absolute executable", () => {
    expect(() => validateRelayConfig(cfg({ executable: "claude.exe" }), "p")).toThrow(/executable must be an absolute path/);
  });
  it("rejects a non-string executable", () => {
    expect(() => validateRelayConfig(cfg({ executable: 5 }), "p")).toThrow(/executable must be an absolute path/);
  });
  it("rejects executable on a non-sdk lane", () => {
    expect(() => validateRelayConfig({ workdir: "D:/x", agents: { c: { cmd: ["claude"], roles: ["work"], executable: join(tmpdir(), "claude.exe") } } }, "p"))
      .toThrow(/only supported for type "sdk"/);
  });
  it("accepts an absolute executable on an sdk lane", () => {
    expect(() => validateRelayConfig(cfg({ executable: join(tmpdir(), "claude.exe") }), "p")).not.toThrow();
  });
});
