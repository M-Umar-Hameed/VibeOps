import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../src/bootstrap.js";

test("bootstrap default dir honours VIBEOPS_HOME, not the real home", async () => {
  const prev = process.env.VIBEOPS_HOME;
  const home = mkdtempSync(join(tmpdir(), "vibeops-home-resolver-"));
  process.env.VIBEOPS_HOME = home;
  try {
    await runBootstrap(9999); // no dir arg: exercises the default resolver
    // The vault is created under `dir` on every boot, before the actors
    // early-return, so this holds on every lane regardless of whether a
    // credential was written.
    expect(existsSync(join(home, ".vibeops", "vault", "README.md"))).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.VIBEOPS_HOME;
    else process.env.VIBEOPS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("bootstrap never overwrites an existing credentials.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-creds-guard-"));
  const vibeops = join(dir, ".vibeops");
  mkdirSync(vibeops, { recursive: true });
  const credsPath = join(vibeops, "credentials.json");
  const sentinel = JSON.stringify({ baseUrl: "http://localhost:1", apiKey: "SENTINEL-KEEP-ME" });
  writeFileSync(credsPath, sentinel);

  // COVERAGE LIMIT, stated so nobody reads more into a green run than is there:
  // runBootstrap returns at the "already initialized" actors probe before it ever
  // reaches the credential write, so with actors present this asserts the file is
  // untouched WITHOUT proving the existsSync guard is what spared it. Emptying
  // actors would exercise the guard, but this file does not call allocateSlice(),
  // so it shares the default test database -- a TRUNCATE here cascades into every
  // other file's rows. Isolating it needs a per-file slice, not a wider DELETE.
  await runBootstrap(9999, vibeops);
  expect(readFileSync(credsPath, "utf8")).toBe(sentinel);
  await runBootstrap(9999, vibeops); // twice: still unchanged (same key)
  expect(readFileSync(credsPath, "utf8")).toBe(sentinel);

  rmSync(dir, { recursive: true, force: true });
});

test("no src module resolves .vibeops/credentials.json via raw homedir()", () => {
  const offender = /homedir\s*\([\s\S]{0,60}\.vibeops[\s\S]{0,60}credentials\.json/;
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };
  const hits = walk("src").filter((f) => offender.test(readFileSync(f, "utf8")));
  expect(hits).toEqual([]);
});
