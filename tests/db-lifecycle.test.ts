import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbedded, EmbeddedDbOpenError, EmbeddedDbLockedError, closeEmbedded } from "../src/db/lifecycle.js";

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

const mk = async (dir: string) => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  return openEmbedded(dir, {
    makeClient: (d) => new PGlite(d, { extensions: { vector } }),
    now: () => "x",
  });
};

test("second open in the same process refuses, naming the holder pid", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-lock2-"));
  const { client } = await mk(dir);
  let err: EmbeddedDbLockedError | undefined;
  try { await mk(dir); } catch (e) { err = e as EmbeddedDbLockedError; }
  expect(err).toBeInstanceOf(EmbeddedDbLockedError);
  expect(err!.message).toContain(String(process.pid));
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a lock file whose pid is dead is reclaimed and the open succeeds", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-stale-"));
  writeFileSync(join(dir, ".vibeops-lock"), "99999999"); // pid that does not exist
  const { client } = await mk(dir);
  const r = await client.query("select 1 as n");
  expect((r.rows as { n: number }[])[0].n).toBe(1);
  expect(readFileSync(join(dir, ".vibeops-lock"), "utf-8").trim()).toBe(String(process.pid));
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("closeEmbedded removes the lock file", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-rel-"));
  const { client } = await mk(dir);
  expect(existsSync(join(dir, ".vibeops-lock"))).toBe(true);
  await closeEmbedded(client, dir);
  expect(existsSync(join(dir, ".vibeops-lock"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("a LIVE holder is never stolen from, even when the lock file is old", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-liveold-"));
  const lockPath = join(dir, ".vibeops-lock");
  writeFileSync(lockPath, String(process.pid)); // our own pid: definitely alive
  const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  utimesSync(lockPath, old, old); // older than any plausible time-based threshold
  let err: EmbeddedDbLockedError | undefined;
  try { await mk(dir); } catch (e) { err = e as EmbeddedDbLockedError; }
  expect(err).toBeInstanceOf(EmbeddedDbLockedError);
  rmSync(dir, { recursive: true, force: true });
});
