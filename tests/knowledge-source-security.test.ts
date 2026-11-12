import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getKnowledgeSource, upsertVaultFile, upsertSourceDoc } from "../src/services/knowledge.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { createProject, updateProjectRepo } from "../src/services/projects.js";

const emb = new FakeEmbedder(1024);

test("vault source refuses paths that are not in the knowledge index", async () => {
  const secret = resolve("package.json"); // real file on disk, never ingested
  const out = await getKnowledgeSource("vault", secret);
  expect(out).toContain("not an indexed vault source");
  expect(out).not.toContain("\"dependencies\"");
});

test("session source reassembles indexed chunks (no file to read back)", async () => {
  const ref = `test-session-${Date.now()}`;
  await upsertSourceDoc("session", ref, "# Session\nagent said session-body-alpha", emb);
  const out = await getKnowledgeSource("session", ref);
  expect(out).toContain("session-body-alpha");
  expect(await getKnowledgeSource("session", "no-such-session")).toContain("not found");
});

test("vault source serves an indexed ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-src-"));
  const file = join(dir, "doc.md");
  writeFileSync(file, `# Doc\nsource-body-${Date.now()}`);
  await upsertVaultFile(file, `# Doc\nsource-body`, emb);
  const out = await getKnowledgeSource("vault", file);
  expect(out).toContain("# Doc");
  rmSync(dir, { recursive: true, force: true });
});

async function repoProject() {
  const outer = mkdtempSync(join(tmpdir(), "repo-src-"));
  const repo = join(outer, "repo");
  mkdirSync(repo, { recursive: true });
  const p = await createProject({ key: `rs-${randomUUID()}`, name: "RS" });
  await updateProjectRepo(p.id, repo);
  return { outer, repo, pid: p.id };
}

test("repo source serves an indexed file from the project repoPath", async () => {
  const { outer, repo, pid } = await repoProject();
  const stamp = Date.now();
  try {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "a.md"), `# A\nrepo-disk-${stamp}`);
    await upsertSourceDoc("repo", `${pid}:docs/a.md`, "# A\nindexed-only-text", emb);
    const out = await getKnowledgeSource("repo", `${pid}:docs/a.md`);
    expect(out).toContain(`repo-disk-${stamp}`);
    expect(out).not.toContain("indexed-only-text");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("repo source refuses refs that are not in the index", async () => {
  const { outer, repo, pid } = await repoProject();
  const stamp = Date.now();
  try {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "b.md"), `unindexed-${stamp}`);
    const out = await getKnowledgeSource("repo", `${pid}:docs/b.md`);
    expect(out).toContain("not an indexed repo source");
    expect(out).not.toContain(`unindexed-${stamp}`);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("repo source refuses an indexed ref that traverses outside repoPath", async () => {
  const { outer, repo, pid } = await repoProject();
  const stamp = Date.now();
  try {
    writeFileSync(join(outer, "secret.md"), `trav-secret-${stamp}`);
    await upsertSourceDoc("repo", `${pid}:../secret.md`, "# x\ntrav-indexed", emb);
    const out = await getKnowledgeSource("repo", `${pid}:../secret.md`);
    expect(out).toContain("outside the project repo");
    expect(out).not.toContain(`trav-secret-${stamp}`);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("repo source refuses a junction/symlink escaping repoPath", async () => {
  const { outer, repo, pid } = await repoProject();
  const stamp = Date.now();
  try {
    mkdirSync(join(outer, "elsewhere"));
    writeFileSync(join(outer, "elsewhere", "secret.md"), `junction-secret-${stamp}`);
    symlinkSync(join(outer, "elsewhere"), join(repo, "link"), "junction");
    await upsertSourceDoc("repo", `${pid}:link/secret.md`, "# x\njunction-indexed", emb);
    const out = await getKnowledgeSource("repo", `${pid}:link/secret.md`);
    expect(out).toContain("outside the project repo");
    expect(out).not.toContain(`junction-secret-${stamp}`);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("repo source falls back to indexed chunks when the file is gone", async () => {
  const { outer, repo, pid } = await repoProject();
  const stamp = Date.now();
  try {
    mkdirSync(join(repo, "docs"), { recursive: true });
    await upsertSourceDoc("repo", `${pid}:docs/gone.md`, `# Gone\nfallback-body-${stamp}`, emb);
    // no file on disk
    const out = await getKnowledgeSource("repo", `${pid}:docs/gone.md`);
    expect(out).toContain(`fallback-body-${stamp}`);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("chat source reassembles indexed chunks", async () => {
  const stamp = Date.now();
  const chatRef = `${randomUUID()}:chat-${stamp}`;
  await upsertSourceDoc("chat", chatRef, "# Chat\nchat-body-alpha", emb);
  const out = await getKnowledgeSource("chat", chatRef);
  expect(out).toContain("chat-body-alpha");
  expect(await getKnowledgeSource("chat", "no-such-chat")).toContain("not found");
});

test("unknown kind keeps the existing error", async () => {
  expect(await getKnowledgeSource("bogus", "x")).toBe("Error: Unknown source kind bogus");
});
