import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeCodeSource } from "../src/ingest/sessions/claude-code.js";

test("transcript reader keeps user/assistant text, strips tool noise, windows by mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccode-"));
  const proj = join(dir, "D--Some-Proj");
  mkdirSync(proj);
  const lines = [
    JSON.stringify({ type: "queue-operation", operation: "x" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "fix the login bug" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "The bug is in auth.ts line 5" },
      { type: "tool_use", name: "Bash", input: { command: "cat /etc/passwd" } },
    ] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [
      { type: "tool_result", content: "root:x:0:0" },
      { type: "text", text: "thanks, also check signup" },
    ] } }),
    "not json at all",
  ].join("\n");
  writeFileSync(join(proj, "session-1.jsonl"), lines);

  const src = makeClaudeCodeSource(dir);
  const docs = await src.listSessionDocs(30);
  expect(docs).toHaveLength(1);
  const t = docs[0].text;
  expect(t).toContain("fix the login bug");
  expect(t).toContain("auth.ts line 5");
  expect(t).toContain("also check signup");
  expect(t).not.toContain("secret reasoning");
  expect(t).not.toContain("/etc/passwd");
  expect(t).not.toContain("root:x:0:0");
  expect(docs[0].ref).toBe(join(proj, "session-1.jsonl"));
  rmSync(dir, { recursive: true, force: true });
});
