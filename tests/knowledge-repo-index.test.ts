import { test, expect } from "vitest";
process.env.EMBED_PROVIDER = "fake";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../src/services/projects.js";
import { indexRepoDocs } from "../src/services/knowledge.js";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

test("indexes more than 50 docs", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-index-"));
  try {
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(root, `doc-${i}.md`), `# Doc ${i}\ncontent ${i}`);
    }
    const p = await createProject({ key: `ri-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "RI" });
    await db.update(projects).set({ repoPath: root }).where(eq(projects.id, p.id));
    const res = await indexRepoDocs(p.id);
    expect(res.indexed).toBe(60);
    expect(res.indexed).toBeGreaterThan(50);
    expect(res.skipped).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("200 KB per-file skip still counted", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-index-skip-"));
  try {
    writeFileSync(join(root, "small1.md"), "small 1");
    writeFileSync(join(root, "small2.md"), "small 2");
    writeFileSync(join(root, "big.md"), "x".repeat(200 * 1024 + 1));
    const p = await createProject({ key: `ri-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "RI Skip" });
    await db.update(projects).set({ repoPath: root }).where(eq(projects.id, p.id));
    const res = await indexRepoDocs(p.id);
    expect(res.indexed).toBe(2);
    expect(res.skipped).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("progress reports reading, embedding and removing stale docs with counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-index-prog-"));
  try {
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, `doc-${i}.md`), `# Doc ${i}\ncontent ${i}`);
    }
    const p = await createProject({ key: `rip-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "RI Prog" });
    await db.update(projects).set({ repoPath: root }).where(eq(projects.id, p.id));

    const log: any[] = [];
    const s: any = {};
    const ctx = {
      cancelled: false,
      progress(update: any) {
        Object.assign(s, update);
        log.push({ ...s });
      },
    };

    const res = await indexRepoDocs(p.id, ctx);
    expect(res.indexed).toBe(4);

    expect(log.some((entry) => entry.phase === "reading docs")).toBe(true);
    expect(log.some((entry) => entry.phase === "embedding docs")).toBe(true);
    expect(log.some((entry) => entry.phase === "removing stale docs")).toBe(true);

    const embedEntries = log.filter((entry) => entry.phase === "embedding docs");
    const lastEmbed = embedEntries[embedEntries.length - 1];
    expect(lastEmbed).toMatchObject({ done: 4, total: 4 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled indexRepoDocs does not delete stale rows", async () => {
  const { embeddings } = await import("../src/db/schema.js");
  const { and, like } = await import("drizzle-orm");

  const root = mkdtempSync(join(tmpdir(), "repo-index-cancel-"));
  try {
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, `doc-${i}.md`), `# Doc ${i}\ncontent ${i}`);
    }
    const p = await createProject({ key: `ric-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "RI Cancel" });
    await db.update(projects).set({ repoPath: root }).where(eq(projects.id, p.id));

    const initial = await indexRepoDocs(p.id);
    expect(initial.indexed).toBe(4);

    writeFileSync(join(root, "new.md"), "# New\nnew doc content");

    const res = await indexRepoDocs(p.id, { cancelled: true, progress() {} });
    expect(res.cancelled).toBe(true);
    expect(res.removed).toBe(0);

    const rows = await db.select({ sourceRef: embeddings.sourceRef })
      .from(embeddings)
      .where(and(eq(embeddings.sourceKind, "repo"), like(embeddings.sourceRef, `${p.id}:%`)));
    const distinctRefs = new Set(rows.map((r) => r.sourceRef));
    expect(distinctRefs.size).toBe(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
