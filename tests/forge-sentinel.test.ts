import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSensitivePaths, snapshotSensitive, detectAndRestore } from "../src/forge/sentinel.js";

describe("sentinel resolveSensitivePaths", () => {
  it("uses a JSON array setting when valid", () => {
    expect(resolveSensitivePaths('["/a/b.mjs","/c/d.mjs"]')).toEqual(["/a/b.mjs", "/c/d.mjs"]);
  });
  it("honours an explicit empty array (disable)", () => {
    expect(resolveSensitivePaths("[]")).toEqual([]);
  });
  it("falls back to defaults on malformed JSON", () => {
    expect(Array.isArray(resolveSensitivePaths("not json"))).toBe(true);
  });
});

describe("sentinel default sensitive paths", () => {
  it("includes relay.json and credentials.json under a VIBEOPS_HOME override", () => {
    const prev = process.env.VIBEOPS_HOME;
    const home = mkdtempSync(join(tmpdir(), "sentinel-home-"));
    process.env.VIBEOPS_HOME = home;
    try {
      const defaults = resolveSensitivePaths(null);
      expect(defaults).toContain(join(home, ".vibeops", "relay.json"));
      expect(defaults).toContain(join(home, ".vibeops", "credentials.json"));
    } finally {
      if (prev === undefined) delete process.env.VIBEOPS_HOME;
      else process.env.VIBEOPS_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("sentinel snapshot / detectAndRestore", () => {
  it("skips missing paths and detects+restores a tampered file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-"));
    const target = join(dir, "server.mjs");
    const missing = join(dir, "nope.mjs");
    writeFileSync(target, "GOOD PAYLOAD\n");

    const snaps = snapshotSensitive([target, missing]);
    expect(snaps.map((s) => s.path)).toEqual([target]); // missing skipped

    // no change yet
    expect(detectAndRestore(snaps)).toEqual([]);

    // agent overwrites the installed payload
    writeFileSync(target, "EVIL BUILD\n");
    const tampered = detectAndRestore(snaps);
    expect(tampered).toEqual([target]);
    expect(readFileSync(target, "utf-8")).toBe("GOOD PAYLOAD\n"); // restored

    rmSync(dir, { recursive: true, force: true });
  });
});
