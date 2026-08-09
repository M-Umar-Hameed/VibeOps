import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbedded, EmbeddedDbOpenError } from "../src/db/lifecycle.js";

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

test("openEmbedded on open failure makes NO copy, preserves original, points at latest good snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-bad-"));
  writeFileSync(join(dir, "original"), "data");
  const good = `${dir}.good-2026-08-03T00-00-00-000Z`;
  mkdirSync(good);
  writeFileSync(join(good, "marker"), "ok");

  const fakeClient = {
    exec: async () => { throw new Error("PANIC:  could not locate a valid checkpoint record"); },
    close: async () => {},
  };

  let err: EmbeddedDbOpenError | undefined;
  try {
    await openEmbedded(dir, { makeClient: () => fakeClient as never, now: () => "2026-08-03T00-00-00-000Z" });
  } catch (e) {
    err = e as EmbeddedDbOpenError;
  }
  expect(err).toBeInstanceOf(EmbeddedDbOpenError);
  expect(existsSync(`${dir}.broken-2026-08-03T00-00-00-000Z`)).toBe(false); // NO failure copy
  expect(existsSync(join(dir, "original"))).toBe(true);                     // original untouched
  expect(readFileSync(join(dir, "original"), "utf-8")).toBe("data");
  expect(err!.dataDir).toBe(dir);
  expect(err!.backupPath).toBe(good);                                       // points at known-good snapshot

  rmSync(dir, { recursive: true, force: true });
  rmSync(good, { recursive: true, force: true });
});
