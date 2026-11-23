import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAntigravitySource } from "../src/ingest/sessions/antigravity.js";

test("antigravity reader ingests markdown artifacts from brain and conversations", async () => {
  const root = mkdtempSync(join(tmpdir(), "antigravity-"));
  const conv = join(root, "brain", "conv-123");
  mkdirSync(conv, { recursive: true });
  writeFileSync(join(conv, "plan.md"), "# Task plan\nRefactor the auth module.");
  mkdirSync(join(root, "conversations"), { recursive: true });
  writeFileSync(join(root, "conversations", "notes.txt"), "walkthrough text");
  writeFileSync(join(conv, "binary.png"), Buffer.from([0x89, 0x50]));

  const oldFile = join(conv, "stale.md");
  writeFileSync(oldFile, "ancient artifact");
  const old = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  utimesSync(oldFile, old, old);

  const docs = await makeAntigravitySource([root], { resolveProject: async () => null }).listSessionDocs(30);
  const refs = docs.map((d) => d.ref).sort();
  expect(refs).toEqual([join(conv, "plan.md"), join(root, "conversations", "notes.txt")].sort());
  expect(docs.find((d) => d.ref.endsWith("plan.md"))!.text).toContain("Refactor the auth module.");
});

test("antigravity reader is silently empty for missing or empty dirs", async () => {
  const none = { resolveProject: async () => null };
  expect(await makeAntigravitySource([join(tmpdir(), "nope-ag")], none).listSessionDocs(30)).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), "antigravity-empty-"));
  mkdirSync(join(root, "brain"), { recursive: true });
  mkdirSync(join(root, "conversations"), { recursive: true });
  expect(await makeAntigravitySource([root], none).listSessionDocs(30)).toEqual([]);
});

test("antigravity reader sets projectId on brain docs from the conversation resolver", async () => {
  const root = mkdtempSync(join(tmpdir(), "antigravity-proj-"));
  const conv = join(root, "brain", "conv-456");
  mkdirSync(join(conv, ".system_generated", "logs"), { recursive: true });
  writeFileSync(join(conv, "plan.md"), "# Plan\nDo the thing.");
  writeFileSync(
    join(conv, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({ type: "USER_INPUT", content: "hello" }) + "\n",
  );
  mkdirSync(join(root, "conversations"), { recursive: true });
  writeFileSync(join(root, "conversations", "notes.txt"), "walkthrough text");

  const seen: string[] = [];
  const docs = await makeAntigravitySource([root], {
    resolveProject: async (d) => { seen.push(d); return "proj-x"; },
  }).listSessionDocs(30);
  const brain = docs.filter((d) => d.ref.startsWith(join(root, "brain")));
  expect(brain.length).toBe(2);
  for (const d of brain) expect(d.projectId).toBe("proj-x");
  expect(seen.every((d) => d === conv)).toBe(true);
  expect(docs.find((d) => d.ref.endsWith("notes.txt"))!.projectId).toBeUndefined();
});
