import { expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbedded, EmbeddedDbOpenError, EmbeddedDbLockedError, closeEmbedded, lockAddress } from "../src/db/lifecycle.js";

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
  await closeEmbedded(client, dir);
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
  await closeEmbedded(client, dir);
  rmSync(dir, { recursive: true, force: true });
});

test("an old .vibeops-lock from a previous version does not block startup and is removed", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-legacy-"));
  writeFileSync(join(dir, ".vibeops-lock"), `${process.pid} ${Date.now()}`); // a live pid
  const { client } = await mk(dir);
  expect(existsSync(join(dir, ".vibeops-lock"))).toBe(false);
  await closeEmbedded(client, dir);
  rmSync(dir, { recursive: true, force: true });
});

test("closeEmbedded releases the lock and is idempotent", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-rel-"));
  const { client } = await mk(dir);
  await closeEmbedded(client, dir);
  await closeEmbedded(client, dir);
  const again = await mk(dir);
  await closeEmbedded(again.client, dir);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed open releases the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-failrel-"));
  const bad = { exec: async () => { throw new Error("boom"); }, close: async () => {} };
  await expect(openEmbedded(dir, { makeClient: () => bad as never, now: () => "x" })).rejects.toBeInstanceOf(EmbeddedDbOpenError);
  const good = { closed: false, exec: async () => {}, async close() { this.closed = true; } };
  const { client } = await openEmbedded(dir, { makeClient: () => good as never, now: () => "x" });
  await closeEmbedded(client, dir);
  rmSync(dir, { recursive: true, force: true });
});

test("lockAddress is stable per dir and case-insensitive on Windows", () => {
  const dir = join(tmpdir(), "vibeops-addr");
  expect(lockAddress(dir)).toBe(lockAddress(dir + "/"));
  expect(lockAddress(dir)).not.toBe(lockAddress(join(tmpdir(), "vibeops-addr-other")));
  if (process.platform === "win32") {
    expect(lockAddress(dir.toUpperCase())).toBe(lockAddress(dir));
    expect(lockAddress(dir).startsWith("\\\\.\\pipe\\vibeops-db-")).toBe(true);
  }
});
