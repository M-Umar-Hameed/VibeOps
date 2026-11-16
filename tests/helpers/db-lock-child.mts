// Child for tests/db-lock.test.ts.
//   serve: reads stdin lines. "open <dir> fake|real" -> prints OPENED | LOCKED | ERROR <msg>;
//          "close" -> closeEmbedded if held, prints CLOSED. Prints "armed" when ready.
//   try <dir>: one open attempt with a fake client, prints OPENED|LOCKED, releases, exits 0.
import { createInterface } from "node:readline";
import { openEmbedded, closeEmbedded, EmbeddedDbLockedError } from "../../src/db/lifecycle.js";

const fake = () => ({ closed: false, exec: async () => {}, async close() { this.closed = true; } });

async function open(dir: string, real: boolean) {
  let makeClient: (d: string) => any = () => fake();
  if (real) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");
    makeClient = (d) => new PGlite(d, { extensions: { vector } });
  }
  return openEmbedded(dir, { makeClient, now: () => "x" });
}

async function attempt(dir: string, real: boolean): Promise<{ line: string; client?: any }> {
  try { const { client } = await open(dir, real); return { line: "OPENED", client }; }
  catch (e) { return { line: e instanceof EmbeddedDbLockedError ? "LOCKED" : `ERROR ${(e as Error).message}` }; }
}

if (process.argv[2] === "try") {
  const dir = process.argv[3];
  const r = await attempt(dir, false);
  console.log(r.line);
  if (r.client) await closeEmbedded(r.client, dir);
  process.exit(0);
}

let heldClient: any = null; let heldDir = "";
const rl = createInterface({ input: process.stdin });
rl.on("line", async (l) => {
  const [cmd, dir, mode] = l.trim().split(" ");
  if (cmd === "open") {
    const r = await attempt(dir, mode === "real");
    if (r.client) { heldClient = r.client; heldDir = dir; }
    console.log(r.line);
  } else if (cmd === "close") {
    if (heldClient) { await closeEmbedded(heldClient, heldDir); heldClient = null; }
    console.log("CLOSED");
  }
});
rl.on("close", () => process.exit(0));
console.log("armed");
