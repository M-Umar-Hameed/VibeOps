import { describe, it, expect } from "vitest";
import { buildRoster, parseModelRef, rollTranscript, CHAT_TRANSCRIPT_CAP } from "../src/chat/roster.js";
import type { RelayConfig } from "../src/relay/config.js";

const config: RelayConfig = {
  workdir: "/tmp",
  agents: {
    "claude-sdk": { cmd: [], type: "sdk", roles: ["work"], models: [{ name: "sonnet", tier: "cheap", quality: 4 }, { name: "opus", tier: "expensive", quality: 5 }] },
    agy: { cmd: ["agy", "{model}"], roles: ["plan", "work"], models: [{ name: "Gemini 3.7 Flash (High)", tier: "cheap", quality: 3 }] },
    noroles: { cmd: ["x"], roles: [], models: [{ name: "m", tier: "cheap", quality: 1 }] },
  },
};

describe("chat roster", () => {
  it("lists every relay agent with any role; toolCapable only for the sdk lane", () => {
    const roster = buildRoster(config);
    expect(roster.map((r) => r.agent).sort()).toEqual(["agy", "claude-sdk"]); // noroles excluded
    expect(roster.find((r) => r.agent === "claude-sdk")!.toolCapable).toBe(true);
    expect(roster.find((r) => r.agent === "agy")!.toolCapable).toBe(false);
    expect(roster.find((r) => r.agent === "agy")!.models).toEqual([{ name: "Gemini 3.7 Flash (High)" }]);
  });

  it("parseModelRef splits agent::model and maps legacy to the sdk lane", () => {
    expect(parseModelRef("agy::Gemini 3.7 Flash (High)")).toEqual({ agent: "agy", model: "Gemini 3.7 Flash (High)" });
    expect(parseModelRef("opus")).toEqual({ agent: null, model: "opus" });
  });

  it("rollTranscript truncates oldest-first at the named cap, keeping the newest", () => {
    const big = "x".repeat(10_000);
    const msgs = [
      { role: "user", body: `OLDEST ${big}` },
      { role: "assistant", body: `MIDDLE ${big}` },
      { role: "user", body: `NEWEST ${big}` },
    ];
    const out = rollTranscript(msgs); // 3 * ~10k > 24k cap -> oldest dropped
    expect(out).toContain("NEWEST");
    expect(out).toContain("MIDDLE");
    expect(out).not.toContain("OLDEST");
    expect(out.length).toBeLessThanOrEqual(CHAT_TRANSCRIPT_CAP);
  });
});
