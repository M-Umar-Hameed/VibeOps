import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { indexVaultOnce, handleUnlink, reindexFile } from "../src/ingest/watch.js";

const emb = new FakeEmbedder(1024);
const rows = (p: string) =>
  db.select().from(embeddings).where(and(eq(embeddings.sourceKind, "vault"), eq(embeddings.sourceRef, p)));

test("full index, hash-gate skip, re-index on change, delete on unlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  const file = join(dir, "doc.md");
  writeFileSync(file, "# Title\nfirst content");

  const r1 = await indexVaultOnce(dir, emb);
  expect(r1.indexed).toBe(1);
  expect((await rows(file)).length).toBeGreaterThan(0);

  const r2 = await indexVaultOnce(dir, emb);         // unchanged -> skipped
  expect(r2.skipped).toBe(1);
  expect(r2.indexed).toBe(0);

  writeFileSync(file, "# Title\nchanged content entirely");
  const r3 = await indexVaultOnce(dir, emb);         // changed -> re-index
  expect(r3.indexed).toBe(1);

  await handleUnlink(file);                            // delete
  expect((await rows(file)).length).toBe(0);

  rmSync(dir, { recursive: true, force: true });
});

test("reindexFile hash-gates a single path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  const file = join(dir, "doc.md");
  writeFileSync(file, "# Title\nfirst content");

  expect(await reindexFile(file, emb)).toBe(true);          // embedded
  expect(await reindexFile(file, emb)).toBe(false);         // unchanged -> skip

  writeFileSync(file, "# Title\ndifferent content");
  expect(await reindexFile(file, emb)).toBe(true);           // changed -> re-embed

  rmSync(dir, { recursive: true, force: true });
});
