import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDataDir, openEmbedded, EmbeddedDbOpenError } from "../src/db/lifecycle.js";

test("backupDataDir copies the dir to a timestamped sibling", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-bk-"));
  writeFileSync(join(dir, "marker"), "keep");
  const backup = backupDataDir(dir, "2026-08-03T00-00-00-000Z");
  expect(backup).toBe(`${dir}.broken-2026-08-03T00-00-00-000Z`);
  expect(readFileSync(join(backup, "marker"), "utf-8")).toBe("keep");
  rmSync(dir, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
});

test("openEmbedded happy path returns a usable client", { timeout: 60_000 }, async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const dir = mkdtempSync(join(tmpdir(), "vibeops-ok-"));
  const { client } = await openEmbedded(dir, {
    makeClient: (d) => new PGlite(d, { extensions: { vector } }),
    now: () => "unused",
  });
  const r = await client.query("select 1 as n");
  expect((r.rows as { n: number }[])[0].n).toBe(1);
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("openEmbedded on open failure backs up, preserves original, throws typed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-bad-"));
  writeFileSync(join(dir, "original"), "data");
  const fakeClient = {
    exec: async () => { throw new Error("PANIC:  could not locate a valid checkpoint record"); },
    close: async () => {},
  };
  await expect(openEmbedded(dir, {
    makeClient: () => fakeClient as never,
    now: () => "2026-08-03T00-00-00-000Z",
  })).rejects.toThrow(EmbeddedDbOpenError);

  const backup = `${dir}.broken-2026-08-03T00-00-00-000Z`;
  expect(existsSync(backup)).toBe(true);                       // backup made
  expect(existsSync(join(dir, "original"))).toBe(true);        // original NOT deleted
  expect(readFileSync(join(dir, "original"), "utf-8")).toBe("data");

  try {
    await openEmbedded(dir, { makeClient: () => fakeClient as never, now: () => "x" });
  } catch (e) {
    expect(e).toBeInstanceOf(EmbeddedDbOpenError);
    expect((e as EmbeddedDbOpenError).dataDir).toBe(dir);
    expect((e as EmbeddedDbOpenError).message).toContain(dir);
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  rmSync(`${dir}.broken-x`, { recursive: true, force: true });
});
