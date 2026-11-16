import { expect, test } from "vitest";
import { spawn, spawnSync, execSync, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openEmbedded, closeEmbedded, EmbeddedDbLockedError } from "../src/db/lifecycle.js";

const script = fileURLToPath(new URL("./helpers/db-lock-child.mts", import.meta.url));
const ROUNDS = 200;

type Child = { proc: ChildProcess; next: () => Promise<string>; send: (l: string) => void };

function spawnChild(args: string[]): Child {
  const proc = spawn(process.execPath, ["--import", "tsx", script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  let buf = "";
  proc.stdout!.on("data", (b) => {
    buf += String(b);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(l); else lines.push(l);
    }
  });
  proc.stderr!.on("data", (b) => console.error("child stderr:", String(b)));
  return {
    proc,
    next: () => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for child line")), 60_000);
      const done = (l: string) => { clearTimeout(t); res(l); };
      const l = lines.shift();
      if (l !== undefined) done(l); else waiters.push(done);
    }),
    send: (l) => { proc.stdin!.write(l + "\n"); },
  };
}

function hardKill(c: Child): Promise<void> {
  const exited = new Promise<void>((r) => c.proc.on("exit", () => r()));
  if (process.platform === "win32") execSync(`taskkill /F /PID ${c.proc.pid}`);
  else c.proc.kill("SIGKILL");
  return exited;
}

const probe = (dir: string) =>
  spawnSync(process.execPath, ["--import", "tsx", script, "try", dir], { encoding: "utf8" }).stdout.trim();

const realClient = async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  return (d: string) => new PGlite(d, { extensions: { vector } });
};

test(`two processes opening the same dir at the same moment: exactly one opens, ${ROUNDS} rounds`, { timeout: 300_000 }, async () => {
  const a = spawnChild(["serve"]);
  const b = spawnChild(["serve"]);
  const dirs: string[] = [];
  try {
    expect(await a.next()).toBe("armed");
    expect(await b.next()).toBe("armed");
    for (let i = 0; i < ROUNDS; i++) {
      const dir = mkdtempSync(join(tmpdir(), "vibeops-race-"));
      dirs.push(dir);
      // Dead-holder state from the old pid-file race; no PG_VERSION = fresh-dir path.
      writeFileSync(join(dir, ".vibeops-lock"), "99999999");
      a.send(`open ${dir} fake`);
      b.send(`open ${dir} fake`);
      const res = await Promise.all([a.next(), b.next()]);
      expect(res.sort(), `round ${i}`).toEqual(["LOCKED", "OPENED"]);
      a.send("close");
      b.send("close");
      expect(await a.next()).toBe("CLOSED");
      expect(await b.next()).toBe("CLOSED");
    }
  } finally {
    a.proc.kill(); b.proc.kill();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

test("after the holder is hard-killed, a new process opens immediately", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-hk-lock-"));
  const c1 = spawnChild(["serve"]);
  let c2: Child | undefined;
  try {
    expect(await c1.next()).toBe("armed");
    c1.send(`open ${dir} real`);
    expect(await c1.next()).toBe("OPENED");

    let err: EmbeddedDbLockedError | undefined;
    try { await openEmbedded(dir, { makeClient: await realClient(), now: () => "x" }); }
    catch (e) { err = e as EmbeddedDbLockedError; }
    expect(err).toBeInstanceOf(EmbeddedDbLockedError);
    expect(err!.holderPid).toBeNull();
    expect(err!.message).toContain("another VibeOps process");

    await hardKill(c1);

    c2 = spawnChild(["serve"]);
    expect(await c2.next()).toBe("armed");
    c2.send(`open ${dir} real`);
    expect(await c2.next()).toBe("OPENED");
    c2.send("close");
    expect(await c2.next()).toBe("CLOSED");

    const { client } = await openEmbedded(dir, { makeClient: await realClient(), now: () => "x" });
    const r = await client.query("select 1 as n");
    expect((r.rows as { n: number }[])[0].n).toBe(1);
    await closeEmbedded(client, dir);
  } finally {
    c1.proc.kill(); c2?.proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh-directory open holds the lock for the whole initialisation", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-fresh-"));
  try {
    const make = await realClient();
    let probeDuring = "";
    const { client } = await openEmbedded(dir, {
      makeClient: (d) => { probeDuring = probe(d); return make(d); },
      now: () => "x",
    });
    expect(probeDuring).toBe("LOCKED");
    expect(existsSync(join(dir, "PG_VERSION"))).toBe(true);
    expect(probe(dir)).toBe("LOCKED");
    await closeEmbedded(client, dir);
    expect(probe(dir)).toBe("OPENED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
