import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { upsertSourceDoc } from "../src/services/knowledge.js";
import { createProject, updateProjectRepo } from "../src/services/projects.js";
import { setSetting } from "../src/services/settings.js";
import { conversationDirOf } from "../src/ingest/sessions/antigravity.js";
import {
  attributeConversation,
  backfillAntigravityKnowledge,
  backfillAntigravityKnowledgeOnce,
  buildAntigravityProjectResolver,
} from "../src/ingest/sessions/antigravity-project.js";

const SB = "C:\\Users\\Admin\\.vibeops\\sandbox";
const MONO = "G:\\Github\\monorepo";
const VIBE = "G:\\Github\\vibeops";
const REA = "G:\\Github\\rea-aster";
const ADMIN = "C:\\Users\\Admin";
const projs = [
  { id: "p-mono", repoPath: MONO },
  { id: "p-vibe", repoPath: VIBE },
  { id: "p-rea", repoPath: REA },
  { id: "p-admin", repoPath: ADMIN },
];
const TICKET = "5e59d84a-b683-4221-acf7-2288e6f46869";

const attribute = (text: string, tickets: Record<string, string> = {}) =>
  attributeConversation(text, {
    projects: projs,
    ticketProject: async (id) => tickets[id] ?? null,
    sandboxDir: SB,
    readText: () => text,
    realpath: (p) => p,
  });
const mono = (n: number) => Array.from({ length: n }, (_, i) => `${MONO}\\src\\f${i}.ts`).join("\n");
const vibe = (n: number) => Array.from({ length: n }, (_, i) => `${VIBE}\\src\\f${i}.ts`).join("\n");
const rea = (n: number) => Array.from({ length: n }, (_, i) => `${REA}\\src\\f${i}.ts`).join("\n");
const admin = (n: number) => Array.from({ length: n }, (_, i) => `${ADMIN}\\.claude\\x${i}.md`).join("\n");

test("Forge sandbox conversation maps to the ticket's project (JSON-escaped paths)", async () => {
  const text = JSON.stringify({ c: `cd ${SB}\\${TICKET}\\src\\a.ts` });
  expect(text).toContain("\\\\");
  expect(await attribute(text, { [TICKET]: "p-mono" })).toBe("p-mono");
});

test("sandbox uuid that is not a ticket falls through to the tally", async () => {
  expect(await attribute(`${SB}\\${TICKET}\\a.ts\n${mono(3)}`)).toBe("p-mono");
  expect(await attribute(`${SB}\\${TICKET}\\a.ts`)).toBeNull();
});

test("clear majority wins across path spellings", async () => {
  const text = [
    "G:\\Github\\monorepo\\a.ts",
    "g:/github/monorepo/b.ts",
    "file:///g:/GitHub/MonoRepo/x",
    "G:\\\\Github\\\\vibeops\\\\y",
  ].join("\n");
  expect(await attribute(text)).toBe("p-mono");
});

test("60% and 2-mention thresholds", async () => {
  expect(await attribute(`${mono(3)}\n${vibe(2)}`)).toBe("p-mono");
  expect(await attribute(`${mono(2)}\n${vibe(2)}`)).toBeNull();
  expect(await attribute(`${mono(3)}\n${vibe(3)}`)).toBeNull();
  expect(await attribute(`${mono(2)}\n${vibe(1)}\n${rea(1)}`)).toBeNull();
  expect(await attribute(mono(1))).toBeNull();
  expect(await attribute(mono(2))).toBe("p-mono");
});

test("admin ancestor project wins only when nothing else is mentioned", async () => {
  expect(await attribute(admin(2))).toBe("p-admin");
  expect(await attribute(`${admin(5)}\n${mono(1)}`)).toBeNull();
  expect(await attribute(`${admin(1)}\n${mono(4)}`)).toBe("p-mono");
});

test("ambiguous and empty give null", async () => {
  expect(await attribute(`${mono(2)}\n${vibe(2)}\n${rea(2)}`)).toBeNull();
  expect(await attribute("")).toBeNull();
});

test("every file in a conversation gets the same result, resolved once per folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "ag-proj-"));
  const conv = join(root, ".gemini", "antigravity-cli", "brain", randomUUID());
  mkdirSync(join(conv, ".system_generated", "logs"), { recursive: true });
  mkdirSync(join(conv, ".system_generated", "steps", "1"), { recursive: true });
  const refs = [
    join(conv, ".system_generated", "logs", "transcript.jsonl"),
    join(conv, ".system_generated", "steps", "1", "output.txt"),
    join(conv, "plan.md"),
  ];
  for (const r of refs) writeFileSync(r, "x");
  expect(refs.map(conversationDirOf)).toEqual([conv, conv, conv]);
  expect(conversationDirOf(join(root, "conversations", "notes.txt"))).toBeNull();

  let reads = 0;
  const resolve = buildAntigravityProjectResolver({
    projects: projs, ticketProject: async () => null, sandboxDir: SB, realpath: (p) => p,
    readText: () => { reads++; return mono(3); },
  });
  const out = await Promise.all(refs.map((r) => resolve(conversationDirOf(r)!)));
  expect(out).toEqual(["p-mono", "p-mono", "p-mono"]);
  expect(reads).toBe(1);
});

const emb = new FakeEmbedder(1024);
function repoDir(): string {
  const d = join(mkdtempSync(join(tmpdir(), "ag-repo-")), "repo");
  mkdirSync(d, { recursive: true });
  return d;
}
function convDir(): string {
  const c = join(mkdtempSync(join(tmpdir(), "ag-home-")), ".gemini", "antigravity-cli", "brain", randomUUID());
  mkdirSync(join(c, ".system_generated", "logs"), { recursive: true });
  return c;
}
const pidOf = async (ref: string) =>
  (await db.select({ p: embeddings.projectId }).from(embeddings).where(eq(embeddings.sourceRef, ref)))[0]?.p ?? null;

test("backfill assigns NULL rows only, never overwrites, and is idempotent", async () => {
  const r1 = repoDir();
  const r2 = repoDir();
  const p1 = await createProject({ key: `ag1-${randomUUID()}`, name: "AG1" });
  const p2 = await createProject({ key: `ag2-${randomUUID()}`, name: "AG2" });
  await updateProjectRepo(p1.id, r1);
  await updateProjectRepo(p2.id, r2);
  const about = (r: string) => [1, 2, 3].map((i) => `${r}/src/f${i}.ts`).join("\n");

  const a = convDir(); // names P1, NULL rows -> P1
  const b = convDir(); // names P1, but already P2 -> untouched
  const c = convDir(); // no transcript -> stays NULL
  writeFileSync(join(a, ".system_generated", "logs", "transcript.jsonl"), about(r1));
  writeFileSync(join(b, ".system_generated", "logs", "transcript.jsonl"), about(r1));
  const refA = [join(a, ".system_generated", "logs", "transcript.jsonl"), join(a, "plan.md")];
  const refB = join(b, "plan.md");
  const refC = join(c, "plan.md");
  for (const r of refA) await upsertSourceDoc("session", r, `text ${r}`, emb);
  await upsertSourceDoc("session", refB, "text b", emb, undefined, p2.id);
  await upsertSourceDoc("session", refC, "text c", emb);

  const first = await backfillAntigravityKnowledge();
  expect(first.assigned).toBeGreaterThanOrEqual(2);
  expect(first.assignedConversations).toBeGreaterThanOrEqual(1);
  for (const r of refA) expect(await pidOf(r)).toBe(p1.id);
  expect(await pidOf(refB)).toBe(p2.id);
  expect(await pidOf(refC)).toBeNull();

  const second = await backfillAntigravityKnowledge({ resolve: async (d) => ([a, b].includes(d) ? p1.id : null) });
  expect(second.assigned).toBe(0);
  expect(await pidOf(refB)).toBe(p2.id);
});

test("backfillOnce honours the v1 guard", async () => {
  const r = repoDir();
  const p = await createProject({ key: `ag3-${randomUUID()}`, name: "AG3" });
  await updateProjectRepo(p.id, r);
  const c = convDir();
  writeFileSync(join(c, ".system_generated", "logs", "transcript.jsonl"), [1, 2, 3].map((i) => `${r}/f${i}`).join("\n"));
  const ref = join(c, "plan.md");
  await upsertSourceDoc("session", ref, "guarded", emb);

  await setSetting("knowledge.antigravityBackfill", "v1");
  await backfillAntigravityKnowledgeOnce();
  expect(await pidOf(ref)).toBeNull();
});
