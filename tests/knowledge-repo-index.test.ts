import { test, expect } from "vitest";
process.env.EMBED_PROVIDER = "fake";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep, dirname } from "node:path";
import { createProject } from "../src/services/projects.js";
import { indexRepoDocs, walkRepoDocs, parseGitignoreDirs } from "../src/services/knowledge.js";
import { db } from "../src/db/client.js";
import { projects, embeddings } from "../src/db/schema.js";
import { eq, and } from "drizzle-orm";

const parseCases: [string, string[], string[]][] = [
  ["Vibeops-data", ["Vibeops-data"], []],
  ["Vibeops-data/", ["Vibeops-data"], []],
  ["/out", [], ["out"]],
  ["/out/", [], ["out"]],
  ["docs/gen", [], ["docs/gen"]],
  ["/a/b.c_d-e/", [], ["a/b.c_d-e"]],
  ["", [], []],
  ["   ", [], []],
  ["# data", [], []],
  ["!data", [], []],
  ["*.log", [], []],
  ["data*", [], []],
  ["**/tmp", [], []],
  ["dist?", [], []],
  ["[Bb]in", [], []],
  ["a\\b", [], []],
  ["../x", [], []],
  ["a/./b", [], []],
  ["data\r\n/out/\r\n# c\r\n", ["data"], ["out"]],
  ["a\n/b\nc/d\n*.x\n!a\n", ["a"], ["b", "c/d"]],
];

test.each(parseCases)("parseGitignoreDirs %j", (input, any, rooted) => {
  const r = parseGitignoreDirs(input);
  expect([...r.anyDepth].sort()).toEqual(any);
  expect([...r.rooted].sort()).toEqual(rooted);
});

function makeTree(root: string) {
  for (const f of ["README.md", "data/a.md", "docs/data/b.md", "out/c.md", "docs/out/d.md", "docs/keep.md", "node_modules/x.md"]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "# x");
  }
}
const rels = (root: string) => walkRepoDocs(root).map((f) => relative(root, f).split(sep).join("/")).sort();

test("walkRepoDocs honours .gitignore", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-walk-gi-"));
  try {
    makeTree(root);
    writeFileSync(join(root, ".gitignore"), "# c\ndata/\n/out/\n*.log\n!keep\n");
    expect(rels(root)).toEqual(["README.md", "docs/keep.md", "docs/out/d.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkRepoDocs without .gitignore changes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-walk-nogi-"));
  try {
    makeTree(root);
    expect(rels(root)).toEqual(["README.md", "data/a.md", "docs/data/b.md", "docs/keep.md", "docs/out/d.md", "out/c.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexRepoDocs removes rows of newly ignored folders", async () => {
  const root = mkdtempSync(join(tmpdir(), "repo-index-gi-"));
  try {
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "keep.md"), "# keep\nkeep");
    writeFileSync(join(root, "data", "x.md"), "# x\nx");
    const p = await createProject({ key: `rig-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "RI GI" });
    await db.update(projects).set({ repoPath: root }).where(eq(projects.id, p.id));
    expect((await indexRepoDocs(p.id)).indexed).toBe(2);

    writeFileSync(join(root, ".gitignore"), "data/\n");
    const res = await indexRepoDocs(p.id);
    expect(res.indexed).toBe(1);
    expect(res.removed).toBe(1);

    const rows = (ref: string) => db.select().from(embeddings)
      .where(and(eq(embeddings.sourceKind, "repo"), eq(embeddings.sourceRef, `${p.id}:${ref}`)));
    expect((await rows("data/x.md")).length).toBe(0);
    expect((await rows("keep.md")).length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
