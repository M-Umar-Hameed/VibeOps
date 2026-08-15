import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddedDataDir } from "../src/runtime/home.js";

test("embedded data dir resolves under VIBEOPS_HOME (throwaway), never real home", () => {
  const prev = process.env.VIBEOPS_HOME;
  const home = mkdtempSync(join(tmpdir(), "vibeops-home-"));
  process.env.VIBEOPS_HOME = home;
  try {
    expect(resolveEmbeddedDataDir()).toBe(join(home, ".vibeops", "data"));
  } finally {
    if (prev === undefined) delete process.env.VIBEOPS_HOME; else process.env.VIBEOPS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("embedded test mode without VIBEOPS_HOME fails loudly instead of using real home", () => {
  const prev = process.env.VIBEOPS_HOME;
  delete process.env.VIBEOPS_HOME;
  try {
    expect(() => resolveEmbeddedDataDir()).toThrow(/VIBEOPS_HOME/);
  } finally {
    if (prev !== undefined) process.env.VIBEOPS_HOME = prev;
  }
});
