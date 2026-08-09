import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as schema from "../src/db/schema.js";
import { projects, actors, tickets, notes, comments, events, embeddings } from "../src/db/schema.js";
import { dumpDurable, restoreDurable, countDump, countTables, pruneBackups } from "../src/services/backup.js";

async function freshDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite({ extensions: { vector } });
  await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const d: any = drizzle(client as never, { schema });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  return { d, client };
}

async function seed(d: any) {
  const [proj] = await d.insert(projects).values({ key: "inbox", name: "Inbox" }).returning();
  const [owner] = await d.insert(actors).values({ name: "owner", kind: "human", role: "admin", apiKeyHash: randomUUID() }).returning();
  const [t] = await d.insert(tickets).values({ projectId: proj.id, title: "t1", assigneeId: owner.id }).returning();
  await d.insert(comments).values({ ticketId: t.id, authorId: owner.id, body: "c1" });
  await d.insert(events).values({ actorId: owner.id, ticketId: t.id, action: "ticket.created" });
  await d.insert(notes).values({ actorId: owner.id, scope: "project", refId: proj.id, body: "n1", indexed: false, version: 1 });
  const vec = `[${Array.from({ length: 1024 }, () => 0).join(",")}]`;
  await d.execute((await import("drizzle-orm")).sql`
    insert into embeddings (source_kind, source_ref, chunk_index, content, embedding, model, dim, content_hash)
    values ('note', ${"x"}, 0, 'e', ${vec}::vector, 'fake', 1024, 'h')`);
  return { proj, owner, t };
}

test("dump excludes embeddings; restore into fresh db yields identical counts", async () => {
  const src = await freshDb();
  await seed(src.d);
  const dump = await dumpDurable(src.d);
  expect("embeddings" in (dump as any)).toBe(false);

  const want = countDump(dump);
  const tgt = await freshDb();
  const got = await restoreDurable(tgt.d, dump);
  expect(got).toEqual(want);
  expect(await countTables(tgt.d)).toEqual(want);
  // embeddings genuinely not restored
  const [{ n }] = await tgt.d.select({ n: (await import("drizzle-orm")).sql<number>`count(*)::int` }).from(embeddings);
  expect(n).toBe(0);

  await src.client.close(); await tgt.client.close();
});

test("restore survives JSON round-trip (ISO date coercion)", async () => {
  const src = await freshDb();
  await seed(src.d);
  const dump = await dumpDurable(src.d);
  const parsed = JSON.parse(JSON.stringify(dump));
  const tgt = await freshDb();
  const got = await restoreDurable(tgt.d, parsed);
  expect(got).toEqual(countDump(dump));
  await src.client.close(); await tgt.client.close();
});

test("restore remaps colliding Inbox project + owner actor by key/name, no orphans", async () => {
  const src = await freshDb();
  const { t: srcTicket } = await seed(src.d);
  const dump = await dumpDurable(src.d);

  // Target already has its own Inbox project + owner actor (the bootstrap trap).
  const tgt = await freshDb();
  const [liveProj] = await tgt.d.insert(projects).values({ key: "inbox", name: "Inbox" }).returning();
  const [liveOwner] = await tgt.d.insert(actors).values({ name: "owner", kind: "human", role: "admin", apiKeyHash: randomUUID() }).returning();

  await restoreDurable(tgt.d, dump);

  // Exactly one inbox project and one owner actor (no duplication).
  const inboxes = await tgt.d.select().from(projects).where((await import("drizzle-orm")).eq(projects.key, "inbox"));
  expect(inboxes.length).toBe(1);
  const owners = await tgt.d.select().from(actors).where((await import("drizzle-orm")).eq(actors.name, "owner"));
  expect(owners.length).toBe(1);

  // Dumped ticket now points at the LIVE inbox id, not the dumped one -> no orphan.
  const [restoredTicket] = await tgt.d.select().from(tickets).where((await import("drizzle-orm")).eq(tickets.id, srcTicket.id));
  expect(restoredTicket.projectId).toBe(liveProj.id);
  expect(restoredTicket.assigneeId).toBe(liveOwner.id);
  // Every ticket resolves to a real project.
  const allTickets = await tgt.d.select().from(tickets);
  const projIds = new Set((await tgt.d.select().from(projects)).map((p: any) => p.id));
  for (const tk of allTickets) expect(projIds.has(tk.projectId)).toBe(true);

  await src.client.close(); await tgt.client.close();
});

test("pruneBackups keeps last N export files", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeops-bkp-"));
  for (const ts of ["a", "b", "c", "d", "e"]) writeFileSync(join(dir, `export-2026-01-0${ts === "a" ? 1 : ts === "b" ? 2 : ts === "c" ? 3 : ts === "d" ? 4 : 5}.json`), "{}");
  pruneBackups(dir, 3);
  expect(readdirSync(dir).filter((f) => f.startsWith("export-")).length).toBe(3);
  rmSync(dir, { recursive: true, force: true });
});
