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

  const docs = await makeAntigravitySource(root).listSessionDocs(30);
  const refs = docs.map((d) => d.ref).sort();
  expect(refs).toEqual([join(conv, "plan.md"), join(root, "conversations", "notes.txt")].sort());
  expect(docs.find((d) => d.ref.endsWith("plan.md"))!.text).toContain("Refactor the auth module.");
});

test("antigravity reader is silently empty for missing or empty dirs", async () => {
  expect(await makeAntigravitySource(join(tmpdir(), "nope-ag")).listSessionDocs(30)).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), "antigravity-empty-"));
  mkdirSync(join(root, "brain"), { recursive: true });
  mkdirSync(join(root, "conversations"), { recursive: true });
  expect(await makeAntigravitySource(root).listSessionDocs(30)).toEqual([]);
});
