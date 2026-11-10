import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "../src/db/client.js";
import { embeddings, sessionCursors } from "../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { ingestSessions } from "../src/ingest/sessions/ingest.js";
import { makeClaudeCodeSource } from "../src/ingest/sessions/claude-code.js";
import { makeCodexSource } from "../src/ingest/sessions/codex.js";
import { searchKnowledge } from "../src/services/knowledge.js";

const emb = new FakeEmbedder(1024);

function ul(text: string) { return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"; }
function al(text: string, model = "claude-opus-5-5") {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text }] } }) + "\n";
}

async function rows(ref: string) {
  return db.select({ id: embeddings.id, chunkIndex: embeddings.chunkIndex, content: embeddings.content })
    .from(embeddings)
    .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, ref)))
    .orderBy(embeddings.chunkIndex);
}

async function cursor(ref: string) {
  const [c] = await db.select().from(sessionCursors).where(eq(sessionCursors.sourceRef, ref));
  return c;
}

test("growing transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const projDir = join(dir, "D--Proj");
  const u = randomUUID().slice(0, 8);
  const path = join(projDir, `s-${randomUUID()}.jsonl`);
  mkdirSync(projDir);

  writeFileSync(path, ul(`alpha-${u} question`) + al(`alpha-${u} answer`));
  const src = makeClaudeCodeSource(dir, join(dir, "sandbox"), { skipDirs: [], resolveProject: async () => null });
  await ingestSessions([src], emb, 30);

  const first = await rows(path);
  expect(first.length).toBeGreaterThan(0);
  const firstIds = first.map((r) => r.id);
  const firstContent = first.map((r) => r.content).join(" ");
  expect(firstContent).toContain(`alpha-${u}`);

  writeFileSync(path, ul(`alpha-${u} question`) + al(`alpha-${u} answer`) + ul(`beta-${u} question`) + al(`beta-${u} answer`), { flag: "w" });
  await ingestSessions([src], emb, 30);

  const second = await rows(path);
  expect(second.length).toBeGreaterThan(first.length);
  for (const id of firstIds) {
    expect(second.find((r) => r.id === id)).toBeTruthy();
  }
  const newRows = second.filter((r) => !firstIds.includes(r.id));
  expect(newRows.length).toBeGreaterThan(0);
  expect(Math.min(...newRows.map((r) => r.chunkIndex))).toBeGreaterThan(Math.max(...first.map((r) => r.chunkIndex)));
  expect(newRows.some((r) => r.content.includes(`beta-${u}`))).toBe(true);

  const results = await searchKnowledge(`beta-${u} question`, { limit: 20 }, emb);
  expect(results.some((r) => r.citation === path)).toBe(true);

  const c = await cursor(path);
  expect(c).toBeTruthy();
  expect(Number(c!.byteOffset)).toBe(statSync(path).size);
});

test("window slide", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const projDir = join(dir, "D--Proj");
  const u = randomUUID().slice(0, 8);
  const path = join(projDir, `s-${randomUUID()}.jsonl`);
  mkdirSync(projDir);

  writeFileSync(path, ul(`origin-${u}`) + al(`origin-${u}-response`));
  const src = makeClaudeCodeSource(dir, join(dir, "sandbox"), { skipDirs: [], resolveProject: async () => null, tailBytes: 600 });
  await ingestSessions([src], emb, 30);

  for (let i = 0; i < 4; i++) {
    const q = `step-${i}-${u}-question-with-some-padding-text`;
    const a = `step-${i}-${u}-answer-with-some-padding-text`;
    writeFileSync(path, ul(q) + al(a), { flag: "a" });
    await ingestSessions([src], emb, 30);
  }

  const final = await rows(path);
  expect(final.some((r) => r.content.includes(`origin-${u}`))).toBe(true);
  for (let i = 0; i < 4; i++) {
    expect(final.some((r) => r.content.includes(`step-${i}-${u}`))).toBe(true);
  }
});

test("unchanged file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const projDir = join(dir, "D--Proj");
  const u = randomUUID().slice(0, 8);
  const path = join(projDir, `s-${randomUUID()}.jsonl`);
  mkdirSync(projDir);

  writeFileSync(path, ul(`test-${u}`) + al(`test-${u}-answer`));
  const src = makeClaudeCodeSource(dir, join(dir, "sandbox"), { skipDirs: [], resolveProject: async () => null });
  await ingestSessions([src], emb, 30);

  const first = await rows(path);
  const firstIds = first.map((r) => r.id);

  const result = await ingestSessions([src], emb, 30);
  const second = await rows(path);

  expect(second.map((r) => r.id)).toEqual(firstIds);
  expect(result["claude-code"].indexed).toBe(0);

  const c = await cursor(path);
  expect(c).toBeTruthy();
  expect(Number(c!.byteOffset)).toBe(statSync(path).size);
});

test("truncated file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const projDir = join(dir, "D--Proj");
  const u = randomUUID().slice(0, 8);
  const path = join(projDir, `s-${randomUUID()}.jsonl`);
  mkdirSync(projDir);

  writeFileSync(path, ul(`first-${u}`) + al(`first-${u}-answer`) + ul(`second-${u}`) + al(`second-${u}-answer`));
  const src = makeClaudeCodeSource(dir, join(dir, "sandbox"), { skipDirs: [], resolveProject: async () => null });
  await ingestSessions([src], emb, 30);

  const first = await rows(path);
  const firstIds = first.map((r) => r.id);

  writeFileSync(path, ul(`short-${u}`));
  await ingestSessions([src], emb, 30);

  const second = await rows(path);
  for (const id of firstIds) {
    expect(second.find((r) => r.id === id)).toBeTruthy();
  }

  const c = await cursor(path);
  expect(Number(c!.fileSize)).toBe(statSync(path).size);

  writeFileSync(path, "partial-without-newline");
  await ingestSessions([src], emb, 30);
  const c2 = await cursor(path);
  expect(Number(c2!.fileSize)).toBe(statSync(path).size);
  expect(Number(c2!.byteOffset)).toBe(0);
});

test("multi-window delta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const projDir = join(dir, "D--Proj");
  const u = randomUUID().slice(0, 8);
  const path = join(projDir, `s-${randomUUID()}.jsonl`);
  mkdirSync(projDir);

  writeFileSync(path, ul(`start-${u}`) + al(`start-${u}-answer`));
  const src = makeClaudeCodeSource(dir, join(dir, "sandbox"), { skipDirs: [], resolveProject: async () => null, windowBytes: 300 });
  await ingestSessions([src], emb, 30);

  for (let i = 0; i < 5; i++) {
    writeFileSync(path, ul(`turn-${i}-${u}-question`) + al(`turn-${i}-${u}-answer`), { flag: "a" });
  }
  await ingestSessions([src], emb, 30);

  const final = await rows(path);
  for (let i = 0; i < 5; i++) {
    expect(final.some((r) => r.content.includes(`turn-${i}-${u}`))).toBe(true);
  }
  const c = await cursor(path);
  expect(Number(c!.byteOffset)).toBe(statSync(path).size);
});

test("filter kept on delta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const projDir = join(dir, "D--Proj");
  const u = randomUUID().slice(0, 8);
  const path = join(projDir, `s-${randomUUID()}.jsonl`);
  mkdirSync(projDir);

  writeFileSync(path, ul(`first-${u}`) + al(`first-${u}-answer`));
  const src = makeClaudeCodeSource(dir, join(dir, "sandbox"), { skipDirs: [], resolveProject: async () => null });
  await ingestSessions([src], emb, 30);

  const firstCount = (await rows(path)).length;

  writeFileSync(path, ul(`q-${u}`) + al(`local-${u}`, "qwen3:30b"), { flag: "a" });
  await ingestSessions([src], emb, 30);

  const second = await rows(path);
  expect(second.some((r) => r.content.includes(`local-${u}`))).toBe(false);
  expect(second.length).toBe(firstCount);
  const c = await cursor(path);
  expect(Number(c!.byteOffset)).toBe(statSync(path).size);

  writeFileSync(path, ul(`later-${u}`) + al(`later-${u}-answer`), { flag: "a" });
  await ingestSessions([src], emb, 30);
  const third = await rows(path);
  expect(third.length).toBeGreaterThan(firstCount);
  expect(third.some((r) => r.content.includes(`later-${u}`))).toBe(true);
});

test("codex growing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sess-append-"));
  const u = randomUUID().slice(0, 8);
  const dateDir = join(dir, "2026", "11", "11");
  mkdirSync(dateDir, { recursive: true });
  const path = join(dateDir, `s-${randomUUID()}.jsonl`);

  const userMsg = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } }) + "\n";
  const agentMsg = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: text } }) + "\n";

  writeFileSync(path, userMsg(`alpha-${u} question`) + agentMsg(`alpha-${u} answer`));
  const src = makeCodexSource(dir);
  await ingestSessions([src], emb, 30);

  const first = await rows(path);
  expect(first.length).toBeGreaterThan(0);
  const firstIds = first.map((r) => r.id);
  const firstContent = first.map((r) => r.content).join(" ");
  expect(firstContent).toContain(`alpha-${u}`);

  writeFileSync(path, userMsg(`beta-${u} question`) + agentMsg(`beta-${u} answer`), { flag: "a" });
  await ingestSessions([src], emb, 30);

  const second = await rows(path);
  expect(second.length).toBeGreaterThan(first.length);
  for (const id of firstIds) {
    expect(second.find((r) => r.id === id)).toBeTruthy();
  }
  const newRows = second.filter((r) => !firstIds.includes(r.id));
  expect(newRows.length).toBeGreaterThan(0);
  expect(Math.min(...newRows.map((r) => r.chunkIndex))).toBeGreaterThan(Math.max(...first.map((r) => r.chunkIndex)));
  expect(newRows.some((r) => r.content.includes(`beta-${u}`))).toBe(true);

  const results = await searchKnowledge(`beta-${u} question`, { limit: 20 }, emb);
  expect(results.some((r) => r.citation === path)).toBe(true);

  const c = await cursor(path);
  expect(c).toBeTruthy();
  expect(Number(c!.byteOffset)).toBe(statSync(path).size);
});
