import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripDeadWeight, prunePayload } from "../scripts/prune-platform.mjs";

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "payload-"));
  const nm = join(dir, "node_modules");
  const f = (p: string) => { mkdirSync(join(nm, p), { recursive: true }); writeFileSync(join(nm, p, "x"), "x"); };
  f("onnxruntime-web");
  f("@types/node");
  f("undici-types");
  for (const p of ["win32/x64", "linux/x64", "darwin/arm64"]) f(`onnxruntime-node/bin/napi-v6/${p}`);
  f("@img/sharp-win32-x64");
  f("@img/sharp-linux-x64");
  f("@img/sharp-libvips-linux-x64");
  f("@img/colour");
  for (const p of ["x64-win32", "x64-linux", "arm64-darwin"]) f(`@anthropic-ai/claude-agent-sdk/vendor/ripgrep/${p}`);
  return dir;
}

test("stripDeadWeight removes onnxruntime-web, @types, undici-types", () => {
  const dir = seed();
  try {
    stripDeadWeight(dir);
    const nm = join(dir, "node_modules");
    expect(existsSync(join(nm, "onnxruntime-web"))).toBe(false);
    expect(existsSync(join(nm, "@types"))).toBe(false);
    expect(existsSync(join(nm, "undici-types"))).toBe(false);
    // untouched
    expect(existsSync(join(nm, "@img", "colour"))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prunePayload(linux-x64) leaves ONLY linux native binaries", () => {
  const dir = seed();
  try {
    prunePayload(dir, "linux-x64");
    const nm = join(dir, "node_modules");
    const napi = join(nm, "onnxruntime-node", "bin", "napi-v6");
    // kept (mutation guard: deleting the kept platform fails here)
    expect(existsSync(join(napi, "linux", "x64"))).toBe(true);
    expect(existsSync(join(nm, "@img", "sharp-linux-x64"))).toBe(true);
    expect(existsSync(join(nm, "@img", "sharp-libvips-linux-x64"))).toBe(true);
    expect(existsSync(join(nm, "@img", "colour"))).toBe(true);
    expect(existsSync(join(nm, "@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-linux"))).toBe(true);
    // foreign pruned
    expect(existsSync(join(napi, "win32", "x64"))).toBe(false);
    expect(existsSync(join(napi, "darwin", "arm64"))).toBe(false);
    expect(existsSync(join(nm, "@img", "sharp-win32-x64"))).toBe(false);
    expect(existsSync(join(nm, "@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-win32"))).toBe(false);
    expect(existsSync(join(nm, "@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prunePayload rejects unknown keep target", () => {
  expect(() => prunePayload(".", "sparc-v9")).toThrow(/unknown keep target/);
});
