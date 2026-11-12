import os from "node:os";
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/relay/firewall.js", () => ({
  checkCommand: () => {
    throw new Error("boom");
  },
}));

import { commandRisk } from "../src/relay/risk.js";

describe("commandRisk fail-closed", () => {
  it("denies with internal-error when checkCommand throws", () => {
    expect(commandRisk("ls", os.tmpdir())).toEqual({
      id: "internal-error",
      reason: "command firewall failed; denied",
    });
  });
});
