// Standalone child: opens an embedded PGlite cluster in the dir given by argv[2],
// installs the stdin-EOF + SIGTERM shutdown handlers, prints "ready". Parent
// closes stdin (or sends SIGTERM) to trigger a clean close; a clean close removes
// postmaster.pid, a hard kill leaves it.
import { openEmbedded, closeEmbedded } from "../../src/db/lifecycle.js";

const dir = process.argv[2];
const { PGlite } = await import("@electric-sql/pglite");
const { vector } = await import("@electric-sql/pglite/vector");
const { client } = await openEmbedded(dir, {
  makeClient: (d) => new PGlite(d, { extensions: { vector } }),
  now: () => "unused",
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await closeEmbedded(client, dir);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.stdin.on("end", () => void shutdown());
process.stdin.resume();
process.stdout.write("ready\n");
