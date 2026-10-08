import { describe, it, expect, afterEach } from "vitest";
import { resolveStrategy } from "../src/forge/router.js";
import { describeSteps, actRiskRefusal } from "../src/browser/risk.js";
import { resetLayaForTests, closeLaya } from "../src/laya/client.js";
import { withSetting } from "./helpers/settings.js";
import type { ActionStep } from "../src/browser/channel.js";

const LAYA = process.env.LAYA_COMMAND;
const live = LAYA ? it : it.skip;

function withoutLaya<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LAYA_COMMAND;
  delete process.env.LAYA_COMMAND;
  resetLayaForTests();
  return fn().finally(() => { if (saved !== undefined) process.env.LAYA_COMMAND = saved; });
}

const steps = [{ verb: "click", ref: "e1" }] as unknown as ActionStep[];

afterEach(async () => { await closeLaya(); resetLayaForTests(); });

describe("laya routing", () => {
  it("keeps the base strategy when laya is not configured", async () => {
    await withoutLaya(async () => {
      expect(await resolveStrategy("balanced", { title: "Anything" })).toBe("balanced");
    });
  });

  it("keeps the base strategy for empty work text without calling laya", async () => {
    expect(await resolveStrategy("quality-first", { title: "", body: "" })).toBe("quality-first");
  });

  live("routes a small change cheap and a sprawling one to quality", async () => {
    expect(await resolveStrategy("balanced", {
      title: "Add a missing null check in parseConfig",
      body: "parseConfig dereferences opts.name without checking it exists.",
    })).toBe("cheapest-first");

    expect(await resolveStrategy("balanced", {
      title: "Extract the billing module into its own service",
      body: "Split the database, stand up a new service, and update every caller across the codebase.",
    })).toBe("quality-first");
  }, 120_000);
});

describe("browser risk screen", () => {
  it("describes steps by verb and origin and never includes page text", () => {
    const d = describeSteps(
      [{ verb: "type", value: "hello world" }] as unknown as ActionStep[],
      "https://example.com",
    );
    expect(d).toContain("https://example.com");
    expect(d).toContain("type");
    expect(d).toContain("hello world");
    expect(d).not.toContain("snapshot");
  });

  it("allows when the screen is switched off", async () => {
    await withSetting("laya.browserRiskScreen", "false", async () => {
      expect(await actRiskRefusal(steps, "https://example.com")).toBeNull();
    });
  });

  it("allows when laya is not configured, so nothing regresses without it", async () => {
    await withoutLaya(async () => {
      expect(await actRiskRefusal(steps, "https://example.com")).toBeNull();
    });
  });

  it("allows an empty batch without consulting laya", async () => {
    expect(await actRiskRefusal([], "https://example.com")).toBeNull();
  });

  live("still allows an ordinary click on a live model", async () => {
    expect(await actRiskRefusal(steps, "https://example.com")).toBeNull();
  }, 90_000);
});
