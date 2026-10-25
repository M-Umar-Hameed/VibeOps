import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeCodeSource } from "../src/ingest/sessions/claude-code.js";

test("claude-code source skips sessions whose cwd is inside the Forge sandbox root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccode-sbx-"));
  const projects = join(dir, "projects");
  const sandbox = join(dir, "sandbox");
  const proj = join(projects, "P");
  mkdirSync(proj, { recursive: true });
  const session = (cwd: string, text: string) => [
    JSON.stringify({ type: "user", cwd, message: { role: "user", content: text } }),
    JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `re ${text}` }] } }),
  ].join("\n");
  writeFileSync(join(proj, "worker.jsonl"), session(join(sandbox, "views", "abc"), "forge worker task"));
  writeFileSync(join(proj, "user.jsonl"), session(join(dir, "repo"), "user task"));
  try {
    const docs = await makeClaudeCodeSource(projects, sandbox).listSessionDocs(30);
    expect(docs.map((d) => d.ref)).toEqual([join(proj, "user.jsonl")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
