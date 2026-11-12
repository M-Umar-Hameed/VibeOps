import { test } from "node:test";
import assert from "node:assert/strict";
import { clipText, createClip } from "./output-budget.ts";

const bound = (o: { headChars: number; tailChars: number; maxSignalLines: number; maxLineChars: number }) =>
  o.headChars + o.tailChars + o.maxSignalLines * (o.maxLineChars + 16) + 300;
const D = { headChars: 2000, tailChars: 6000, maxSignalLines: 30, maxLineChars: 240 };

test("small input returns unchanged with ANSI removed", () => {
  const r = clipText("\x1b[31mred\x1b[0m text\r\nline2\n");
  assert.equal(r.text, "red text\nline2\n");
  assert.equal(r.stats.truncated, false);
  assert.equal(r.stats.totalLines, 2);
});

test("empty input returns empty string", () => {
  const r = clipText("");
  assert.equal(r.text, "");
  assert.equal(r.stats.truncated, false);
  assert.equal(r.stats.totalBytes, 0);
});

test("200k lines keeps head, tail, marker and the signal line", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 200000; i++) lines.push(i === 100000 ? "Error: boom at line 100000" : `line ${i} padding text`);
  const r = clipText(lines.join("\n") + "\n");
  assert.equal(r.stats.truncated, true);
  assert.ok(r.text.startsWith("line 1 padding text\nline 2 "));
  assert.ok(r.text.trimEnd().endsWith("line 200000 padding text"));
  assert.match(r.text, /\[\.\.\. clipped: \d+ chars \/ \d+ lines omitted; 1 matching lines kept \.\.\.\]/);
  assert.match(r.text, /^L100000: Error: boom at line 100000$/m);
  assert.ok(r.text.includes("[... end of clipped section ...]"));
  assert.ok(r.stats.keptChars <= bound(D), `keptChars ${r.stats.keptChars}`);
  assert.equal(r.stats.keptChars, r.text.length);
  assert.equal(r.stats.totalLines, 200000);
});

test("multi-byte char split across pushes survives", () => {
  const bytes = new TextEncoder().encode("a€b");
  const c = createClip();
  c.push(bytes.subarray(0, 2));
  c.push(bytes.subarray(2));
  const r = c.finish();
  assert.equal(r.text, "a€b");
  assert.equal(r.stats.totalBytes, 5);
});

test("ANSI sequence split across chunks is stripped", () => {
  const c = createClip();
  c.push("pre \x1b");
  c.push("[3");
  c.push("1mred\x1b[0");
  c.push("m post");
  assert.equal(c.finish().text, "pre red post");
});

test("carriage-return progress keeps only the last state", () => {
  assert.equal(clipText("10%\r50%\r100%\n").text, "100%\n");
  const c = createClip();
  c.push("10%\r50");
  c.push("%\r100%\r");
  c.push("\nnext\n");
  assert.equal(c.finish().text, "100%\nnext\n");
});

test("control characters other than newline and tab are removed", () => {
  assert.equal(clipText("a\x00b\x07c\td\n").text, "abc\td\n");
});

test("50 MB in 64 KB chunks stays bounded", () => {
  const chunk = Buffer.alloc(64 * 1024, "x".repeat(79) + "\n");
  const c = createClip();
  const n = Math.ceil((50 * 1024 * 1024) / chunk.length);
  for (let i = 0; i < n; i++) c.push(chunk);
  c.push("Error: tail marker\n");
  const r = c.finish();
  assert.equal(r.stats.truncated, true);
  assert.ok(r.stats.totalBytes >= 50 * 1024 * 1024);
  assert.ok(r.stats.keptChars <= bound(D), `keptChars ${r.stats.keptChars}`);
  assert.ok(r.text.trimEnd().endsWith("Error: tail marker"));
});

test("a single endless line without newlines stays bounded", () => {
  const c = createClip();
  const chunk = "y".repeat(64 * 1024);
  for (let i = 0; i < 200; i++) c.push(chunk);
  const r = c.finish();
  assert.ok(r.stats.keptChars <= bound(D), `keptChars ${r.stats.keptChars}`);
});

test("signal lines are capped and truncated to maxLineChars", () => {
  const long = "Error: " + "z".repeat(1000);
  const lines: string[] = [];
  for (let i = 0; i < 20000; i++) lines.push(i % 100 === 0 ? long : `ok ${i}`);
  const r = clipText(lines.join("\n"));
  const kept = r.text.split("\n").filter((l) => /^L\d+: /.test(l));
  assert.ok(kept.length <= 30);
  assert.ok(kept.every((l) => l.length <= 240 + 16));
  assert.ok(r.stats.keptChars <= bound(D));
});
